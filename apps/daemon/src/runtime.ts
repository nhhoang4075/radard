/**
 * Dựng các phụ thuộc dùng chung cho daemon và CLI, để hai nơi chạy job giống hệt nhau.
 */

import { fakeEmbedding } from "@radard/adapters/ai-fake";
import { gatewayEmbedding, gatewayLlm } from "@radard/adapters/ai-gateway";
import { gatewayPriceBook } from "@radard/adapters/gateway-pricing";
import { fsObjectStore } from "@radard/adapters/object-store-fs";
import { createPageFetcher, extractPageText } from "@radard/adapters/pages";
import { telegramChat, telegramNotifier } from "@radard/adapters/telegram";
import {
  type ChatChannel,
  createHttpClient,
  type EmbeddingProvider,
  type LlmProvider,
  type Notifier,
} from "@radard/core";
import { createDatabase, type Database, dbUsageSink, EMBED_DIMENSIONS } from "@radard/db";
import { env } from "./env.ts";
import type { SendDeps } from "./jobs/digest.ts";
import type { FetchDeps } from "./jobs/fetch.ts";
import type { PagesDeps } from "./jobs/pages.ts";
import type { ProcessDeps } from "./jobs/process.ts";
import { HOST_INTERVALS_MS } from "./sources/index.ts";

export function createDeps(): FetchDeps {
  return {
    db: createDatabase(env.databaseUrl),
    store: fsObjectStore(env.dataDir),
    http: createHttpClient({ perHostIntervalMs: HOST_INTERVALS_MS }),
  };
}

/** Một bảng giá dùng chung cho cả tiến trình: đọc từ Gateway tối đa một lần mỗi ngày. */
const priceBook = gatewayPriceBook();

export function createEmbedder(db: Database): EmbeddingProvider | null {
  const sink = dbUsageSink(db);
  switch (env.embedder) {
    case "gateway":
      return gatewayEmbedding({
        model: env.embedModel,
        dimensions: EMBED_DIMENSIONS,
        sink,
        priceBook,
        minIntervalMs: env.embedMinIntervalMs,
      });
    case "fake":
      return fakeEmbedding({ dimensions: EMBED_DIMENSIONS, sink });
    default:
      return null;
  }
}

/** Model sinh văn bản qua AI Gateway; `null` khi chưa có khoá (digest sẽ báo lỗi rõ ràng). */
export function createLlm(db: Database): LlmProvider | null {
  if (!process.env.AI_GATEWAY_API_KEY) return null;
  return gatewayLlm({
    model: env.llmModel,
    sink: dbUsageSink(db),
    priceBook,
  });
}

/** `null` khi chưa cấu hình embedder: job process bỏ qua, thu thập vẫn chạy bình thường. */
export function createProcessDeps(base: FetchDeps): ProcessDeps | null {
  const embedder = createEmbedder(base.db);
  if (!embedder) return null;
  return {
    db: base.db,
    store: base.store,
    embedder,
    thresholds: env.thresholds,
    extractPage: extractPageText,
  };
}

/** Kênh gửi digest và người nhận; `null` khi chưa đặt TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID. */
export function createNotifier(): { notifier: Notifier; recipient: string } | null {
  if (!env.telegramToken || !env.telegramChatId) return null;
  return {
    notifier: telegramNotifier({ token: env.telegramToken }),
    recipient: env.telegramChatId,
  };
}

/** Phụ thuộc của job digest; `null` khi chưa có kênh gửi. Không có LLM thì gửi bản không tóm tắt. */
export function createDigestDeps(base: FetchDeps): SendDeps | null {
  const n = createNotifier();
  if (!n) return null;
  return { db: base.db, http: base.http, llm: createLlm(base.db), ...n };
}

export function createPagesDeps(base: FetchDeps): PagesDeps {
  return { db: base.db, store: base.store, fetcher: createPageFetcher({ http: base.http }) };
}

/** Kênh nhận lượt bấm; `null` khi chưa đặt token và chat id. */
export function createChatChannel(): ChatChannel | null {
  if (!env.telegramToken || !env.telegramChatId) return null;
  return telegramChat({ token: env.telegramToken, allowedChatId: env.telegramChatId });
}
