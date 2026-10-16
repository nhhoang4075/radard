/**
 * Vai trò bot: nhận lượt bấm 👍/👎 và lệnh chọn chủ đề qua kênh chat (Telegram: long polling).
 * Chỉ MỘT bản được chạy cho mỗi bot token: hai bản cùng long polling thì Telegram trả 409.
 */
import {
  type ChatChannel,
  createLogger,
  type DecisionProvider,
  type EmbeddingProvider,
  type LlmProvider,
  type ProfileHandlers,
  type SuggestedTopic,
  type TopicHandlers,
  type TopicItem,
} from "@radard/core";
import type { Database } from "@radard/db";
import { runBaselines } from "../jobs/baselines.ts";
import { recordFeedback } from "../jobs/feedback.ts";
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
  embedder: EmbeddingProvider | null;
  llm: LlmProvider | null;
  /** Model ra quyết định: chấm thư viện khi gợi ý chủ đề (/profile). Thiếu thì không gợi ý được. */
  decider: DecisionProvider | null;
}

/**
 * Sau khi bật hoặc thêm chủ đề: embed (1 request), chấm điểm (SQL), tính lại mặt bằng, để digest
 * kế tiếp dùng được ngay mà không phải chờ lượt process hay job 06:30. Chạy nền, lần lượt.
 */
function refresher({ db, embedder }: BotDeps) {
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
  const { db } = deps;
  return {
    async list(): Promise<TopicItem[]> {
      const library = (await listLibrary(db)).map((t) => ({
        key: `l:${t.id}`,
        label: t.name,
        chosen: t.chosen,
      }));
      const custom = (await listProfileTopics(db))
        .filter((t) => t.origin === "custom" && t.kind === "include")
        .map((t) => ({ key: `c:${t.id}`, label: t.label, chosen: t.active }));
      return [...library, ...custom];
    },
    async toggle(key) {
      const [kind, raw] = key.split(":");
      const id = Number(raw);
      let on: boolean;
      if (kind === "l") {
        on = await toggleLibraryTopic(db, id);
      } else {
        const mine = (await listProfileTopics(db)).find((t) => t.id === id);
        if (!mine) throw new Error(`không có chủ đề ${key}`);
        on = !mine.active;
        await setTopicActive(db, id, on);
      }
      if (on) refresh();
      return on;
    },
    async describe(label, text) {
      if (!deps.llm) throw new Error("chưa có AI_GATEWAY_API_KEY: không viết được câu mô tả");
      return describeTopic(deps.llm, label, text);
    },
    async addCustom(draft) {
      await addCustomTopic(db, draft);
      refresh();
    },
  };
}

/** Số chủ đề đang theo dõi, đếm như danh sách /topics: thư viện đang bật + tự thêm đang bật. */
async function countFollowed(db: Database): Promise<number> {
  const library = (await listLibrary(db)).filter((t) => t.chosen).length;
  const custom = (await listProfileTopics(db)).filter(
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
  const { db } = deps;
  return {
    get: () => readProfile(db),
    async saveDescription(text) {
      // Lưu lời người dùng trước: LLM lỗi thì lời họ vẫn còn, bối cảnh cũ giữ nguyên.
      await saveProfile(db, text);
      if (!deps.llm) return { rewritten: false };
      try {
        await saveProfile(db, text, await describeReader(deps.llm, text));
        return { rewritten: true };
      } catch (err) {
        log.warn("viết bối cảnh lỗi", { err: String(err).slice(0, 300) });
        return { rewritten: false };
      }
    },
    async suggest() {
      const { promptContext } = await readProfile(db);
      if (!promptContext) return null;
      const res = await suggestTopics(
        { db, decider: deps.decider, llm: deps.llm, embedder: deps.embedder },
        promptContext,
      );
      if (!res.ran.library) return null;
      // Chủ đề đang bật luôn tích sẵn, dù ở mức nào: Lưu không được lặng lẽ tắt nó.
      const chosen = new Set((await listLibrary(db)).filter((t) => t.chosen).map((t) => t.id));
      const item =
        (tier: SuggestedTopic["tier"]) =>
        (s: { topicId: number; label: string }): SuggestedTopic => ({
          key: `l:${s.topicId}`,
          label: s.label,
          tier,
          checked: tier === "preselect" || chosen.has(s.topicId),
        });
      return {
        topics: [...res.preselect.map(item("preselect")), ...res.maybe.map(item("maybe"))],
        newTopics: res.newTopics.map((t) => ({
          label: t.name,
          why: t.why,
          embedText: t.embedText,
        })),
      };
    },
    async apply(on, off) {
      const enabled = await setLibraryTopics(db, libraryIds(on), libraryIds(off));
      if (enabled > 0) refresh();
      return countFollowed(db);
    },
    async addProposed(p) {
      // Chủ đề tự thêm bắt buộc có lời của người dùng (`topics.description`). Đề xuất không phải lời
      // họ viết, nên lấy đúng câu radard đã cho họ xem ("tên: vì sao") làm mô tả: họ đã đọc và bấm
      // Thêm, coi như đồng ý với câu đó. Câu tiếng Anh của đề xuất dùng làm `embed_text`.
      await addCustomTopic(db, {
        label: p.label,
        description: `${p.label}: ${p.why}`,
        embedText: p.embedText,
      });
      refresh();
    },
  };
}

export async function startBot(deps: BotDeps, chat: ChatChannel): Promise<() => Promise<void>> {
  // Một chuỗi làm mới dùng chung: bật chủ đề từ /topics và /profile không chạy embed chồng nhau.
  const refresh = refresher(deps);
  await chat.start({
    onFeedback: (ev) => recordFeedback(deps.db, ev),
    topics: topicHandlers(deps, refresh),
    profile: profileHandlers(deps, refresh),
  });
  return () => chat.stop();
}
