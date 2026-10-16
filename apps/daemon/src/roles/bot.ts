/**
 * Vai trò bot: nhận lượt bấm 👍/👎 và lệnh chọn chủ đề qua kênh chat (Telegram: long polling).
 * Chỉ MỘT bản được chạy cho mỗi bot token: hai bản cùng long polling thì Telegram trả 409.
 */
import {
  type ChatChannel,
  createLogger,
  type EmbeddingProvider,
  type LlmProvider,
  type TopicHandlers,
  type TopicItem,
} from "@radard/core";
import type { Database } from "@radard/db";
import { runBaselines } from "../jobs/baselines.ts";
import { recordFeedback } from "../jobs/feedback.ts";
import { scoreTopics } from "../jobs/process.ts";
import {
  addCustomTopic,
  describeTopic,
  embedPendingTopics,
  listLibrary,
  listProfileTopics,
  setTopicActive,
  toggleLibraryTopic,
} from "../jobs/topics.ts";

const log = createLogger("bot");

export interface BotDeps {
  db: Database;
  embedder: EmbeddingProvider | null;
  llm: LlmProvider | null;
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

export function topicHandlers(deps: BotDeps): TopicHandlers {
  const { db } = deps;
  const refresh = refresher(deps);
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

export async function startBot(deps: BotDeps, chat: ChatChannel): Promise<() => Promise<void>> {
  await chat.start({
    onFeedback: (ev) => recordFeedback(deps.db, ev),
    topics: topicHandlers(deps),
  });
  return () => chat.stop();
}
