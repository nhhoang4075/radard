/**
 * Vai trò bot: nhận lượt bấm 👍/👎 và lệnh chọn chủ đề qua kênh chat (Telegram: long polling).
 * Chỉ MỘT bản được chạy cho mỗi bot token: hai bản cùng long polling thì Telegram trả 409.
 */
import {
  type ChatChannel,
  type ChatHandlers,
  createLogger,
  type DecisionProvider,
  type EmbeddingProvider,
  type ForMeEvent,
  type ForMeResult,
  type LlmProvider,
  type ProfileHandlers,
  type SuggestedTopic,
  type TopicHandlers,
  type TopicItem,
} from "@radard/core";
import { type Database, deliveries, profileOf } from "@radard/db";
import { and, eq } from "drizzle-orm";
import { runBaselines } from "../jobs/baselines.ts";
import { recordFeedback } from "../jobs/feedback.ts";
import { explainForProfile } from "../jobs/for-me.ts";
import { scoreTopics } from "../jobs/process.ts";
import { describeReader, readProfile, saveProfile } from "../jobs/profile.ts";
import { suggestTopics } from "../jobs/topic-suggest.ts";
import {
  addCustomTopic,
  describeTopic,
  embedPendingTopics,
  listLibrary,
  listProfileTopics,
  setLibraryTopics,
  setTopicActive,
  toggleLibraryTopic,
} from "../jobs/topics.ts";

const log = createLogger("bot");

export interface BotDeps {
  db: Database;
  /** Hồ sơ gán cho phản hồi không nối được về tin nào. */
  profileId: number;
  embedder: EmbeddingProvider | null;
  llm: LlmProvider | null;
  /** Model ra quyết định: chấm thư viện khi gợi ý chủ đề (/profile). Thiếu thì không gợi ý được. */
  decider: DecisionProvider | null;
  /** Hạn mức "Với tôi?" mỗi hồ sơ mỗi ngày (mặc định ở `for-me.ts`). */
  forMeDailyLimit?: number;
}

/**
 * Sau khi bật hoặc thêm chủ đề: embed (1 request), chấm điểm (SQL), tính lại mặt bằng, để digest
 * kế tiếp dùng được ngay mà không phải chờ lượt process hay job 06:30. Chạy nền, lần lượt.
 */
function refresher({ db, embedder }: BotBase) {
  let chain = Promise.resolve();
  return () => {
    if (!embedder) return;
    chain = chain
      .then(async () => {
        const embedded = await embedPendingTopics(db, embedder);
        if (embedded === 0) return;
        const scored = await scoreTopics(db, embedder.model);
        await runBaselines(db);
        log.info("đã cập nhật chủ đề mới", { embedded, scored });
      })
      .catch((err) => log.error("cập nhật chủ đề lỗi", { err: String(err) }));
  };
}

export function topicHandlers(deps: BotDeps, refresh: () => void = refresher(deps)): TopicHandlers {
  const { db, profileId } = deps;
  return {
    async list(): Promise<TopicItem[]> {
      const library = (await listLibrary(db, profileId)).map((t) => ({
        key: `l:${t.id}`,
        label: t.name,
        chosen: t.chosen,
      }));
      const custom = (await listProfileTopics(db, profileId))
        .filter((t) => t.origin === "custom" && t.kind === "include")
        .map((t) => ({ key: `c:${t.id}`, label: t.label, chosen: t.active }));
      return [...library, ...custom];
    },
    async toggle(key) {
      const [kind, raw] = key.split(":");
      const id = Number(raw);
      let on: boolean;
      if (kind === "l") {
        on = await toggleLibraryTopic(db, profileId, id);
      } else {
        const mine = (await listProfileTopics(db, profileId)).find((t) => t.id === id);
        if (!mine) throw new Error(`không có chủ đề ${key}`);
        on = !mine.active;
        await setTopicActive(db, profileId, id, on);
      }
      if (on) refresh();
      return on;
    },
    async describe(label, text) {
      if (!deps.llm) throw new Error("chưa có AI_GATEWAY_API_KEY: không viết được câu mô tả");
      return describeTopic(deps.llm, label, text);
    },
    async addCustom(draft) {
      await addCustomTopic(db, profileId, draft);
      refresh();
    },
  };
}

/** Số chủ đề đang theo dõi, đếm như danh sách /topics: thư viện đang bật + tự thêm đang bật. */
async function countFollowed(db: Database, profileId: number): Promise<number> {
  const library = (await listLibrary(db, profileId)).filter((t) => t.chosen).length;
  const custom = (await listProfileTopics(db, profileId)).filter(
    (t) => t.origin === "custom" && t.kind === "include" && t.active,
  ).length;
  return library + custom;
}

/** Khoá `l:<id>` → id chủ đề thư viện; khoá khác (chủ đề tự thêm) không thuộc gợi ý nên bỏ. */
const libraryIds = (keys: string[]) =>
  keys.filter((k) => /^l:\d+$/.test(k)).map((k) => Number(k.slice(2)));

export function profileHandlers(
  deps: BotDeps,
  refresh: () => void = refresher(deps),
): ProfileHandlers {
  const { db, profileId } = deps;
  return {
    get: () => readProfile(db, profileId),
    async saveDescription(text) {
      // Lưu lời người dùng trước: LLM lỗi thì lời họ vẫn còn, bối cảnh cũ giữ nguyên.
      await saveProfile(db, profileId, text);
      if (!deps.llm) return { rewritten: false };
      try {
        await saveProfile(db, profileId, text, await describeReader(deps.llm, text));
        return { rewritten: true };
      } catch (err) {
        log.warn("viết bối cảnh lỗi", { err: String(err).slice(0, 300) });
        return { rewritten: false };
      }
    },
    async suggest() {
      const { promptContext } = await readProfile(db, profileId);
      if (!promptContext) return null;
      const res = await suggestTopics(
        { db, profileId, decider: deps.decider, llm: deps.llm, embedder: deps.embedder },
        promptContext,
      );
      if (!res.ran.library) return null;
      // Chủ đề đang bật luôn tích sẵn, dù ở mức nào: Lưu không được lặng lẽ tắt nó.
      const followed = (await listLibrary(db, profileId)).filter((t) => t.chosen);
      const chosen = new Set(followed.map((t) => t.id));
      const item =
        (tier: SuggestedTopic["tier"]) =>
        (s: { topicId: number; label: string }): SuggestedTopic => ({
          key: `l:${s.topicId}`,
          label: s.label,
          tier,
          checked: tier === "preselect" || chosen.has(s.topicId),
        });
      const suggested = new Set([...res.preselect, ...res.maybe].map((t) => t.topicId));
      // Chủ đề thư viện đang bật mà không được gợi ý vẫn hiện (nhóm "đang theo dõi"), để tin gợi ý
      // cho thấy đủ những gì người dùng đang theo dõi. Chủ đề tự thêm thì /topics quản.
      const kept = followed
        .filter((t) => !suggested.has(t.id))
        .map((t) => item("followed")({ topicId: t.id, label: t.name }));
      return {
        topics: [...res.preselect.map(item("preselect")), ...res.maybe.map(item("maybe")), ...kept],
        newTopics: res.newTopics.map((t) => ({
          label: t.name,
          why: t.why,
          embedText: t.embedText,
        })),
      };
    },
    async apply(on, off, add) {
      let created = 0;
      for (const p of add) {
        // Chủ đề tự thêm bắt buộc có lời của người dùng (`topics.description`). Đề xuất không phải
        // lời họ viết, nên lấy đúng câu radard đã cho họ xem ("tên: vì sao") làm mô tả: họ đã đọc,
        // tích và bấm Lưu, coi như đồng ý với câu đó. Câu tiếng Anh của đề xuất làm `embed_text`.
        try {
          await addCustomTopic(db, profileId, {
            label: p.label,
            description: `${p.label}: ${p.why}`,
            embedText: p.embedText,
          });
          created++;
        } catch (err) {
          // Trùng tên (vừa tự thêm qua /topics chẳng hạn): bỏ qua chủ đề đó, vẫn lưu phần còn lại.
          log.warn("không tạo được chủ đề đề xuất", { label: p.label, err: String(err) });
        }
      }
      const enabled = await setLibraryTopics(db, profileId, libraryIds(on), libraryIds(off));
      if (enabled + created > 0) refresh();
      return countFollowed(db, profileId);
    },
  };
}

/**
 * Nút "Với tôi?" trên một tin Telegram. Tin phải là tin radard đã gửi cho CHÍNH hồ sơ này (tra
 * `deliveries` theo kênh, người nhận, id tin VÀ `profile_id`); sự kiện của tin còn phải nằm trong feed
 * của hồ sơ (kiểm lại ở `explainForProfile`). Không tìm thấy thì `not_found`, không gọi model.
 */
export async function forMeFor(deps: BotDeps, ev: ForMeEvent): Promise<ForMeResult> {
  const [d] = await deps.db
    .select({ eventId: deliveries.eventId })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.channel, ev.channel),
        eq(deliveries.recipient, ev.recipient),
        eq(deliveries.messageId, ev.messageId),
        eq(deliveries.profileId, deps.profileId),
      ),
    );
  if (!d || d.eventId === null) return { status: "not_found" };
  const r = await explainForProfile(
    {
      db: deps.db,
      llm: deps.llm,
      ...(deps.forMeDailyLimit === undefined ? {} : { dailyLimit: deps.forMeDailyLimit }),
    },
    { profileId: deps.profileId, eventId: d.eventId },
  );
  return r.status === "ok" ? { status: "ok", text: r.text } : { status: r.status };
}

/** Bộ xử lý của MỘT hồ sơ: mọi truy vấn trong đó dùng đúng `profileId` này. */
export function handlersFor(deps: BotDeps, refresh: () => void): ChatHandlers {
  return {
    onFeedback: (ev) => recordFeedback(deps.db, ev, deps.profileId),
    onForMe: (ev) => forMeFor(deps, ev),
    topics: topicHandlers(deps, refresh),
    profile: profileHandlers(deps, refresh),
  };
}

/** Dụng cụ bot dùng chung cho mọi hồ sơ: không có `profileId`, mỗi người nhận tự gắn hồ sơ của mình. */
export type BotBase = Omit<BotDeps, "profileId">;

/**
 * Người nhận (chat id) → bộ xử lý của hồ sơ họ qua `profile_channels`. Không có trong bảng (hay đã
 * tắt) thì `null`: kênh bỏ qua update, người lạ không dùng được bot.
 */
export function chatResolver(base: BotBase, channel: string, refresh: () => void) {
  return async (recipient: string): Promise<{ scope: string; handlers: ChatHandlers } | null> => {
    const profileId = await profileOf(base.db, channel, recipient);
    if (profileId === null) return null;
    return { scope: String(profileId), handlers: handlersFor({ ...base, profileId }, refresh) };
  };
}

export async function startBot(base: BotBase, chat: ChatChannel): Promise<() => Promise<void>> {
  // Một chuỗi làm mới dùng chung (chỉ phụ thuộc db và embedder): bật chủ đề từ /topics và /profile
  // của bất kỳ ai không chạy embed chồng nhau.
  const refresh = refresher(base);
  await chat.start(chatResolver(base, chat.channel, refresh));
  return () => chat.stop();
}
