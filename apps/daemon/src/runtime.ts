/**
 * Dựng các phụ thuộc dùng chung cho daemon và CLI, để hai nơi chạy job giống hệt nhau.
 */

import { fakeEmbedding } from "@radard/adapters/ai-fake";
import { gatewayDecision, gatewayEmbedding, gatewayLlm } from "@radard/adapters/ai-gateway";
import { gatewayPriceBook } from "@radard/adapters/gateway-pricing";
import { fsObjectStore } from "@radard/adapters/object-store-fs";
import { r2ObjectStore } from "@radard/adapters/object-store-r2";
import { createPageFetcher, extractPageText } from "@radard/adapters/pages";
import { telegramChat, telegramNotifier } from "@radard/adapters/telegram";
import {
  type ChatChannel,
  createHttpClient,
  type DecisionProvider,
  type EmbeddingProvider,
  type LlmProvider,
  type Notifier,
  type ObjectStore,
} from "@radard/core";
import { createDatabase, type Database, dbUsageSink, EMBED_DIMENSIONS } from "@radard/db";
import { env } from "./env.ts";
import type { DigestJobDeps } from "./jobs/digest.ts";
import type { FetchDeps } from "./jobs/fetch.ts";
import type { PagesDeps } from "./jobs/pages.ts";
import type { ProcessDeps } from "./jobs/process.ts";
import { HOST_INTERVALS_MS } from "./sources/index.ts";

export function createDeps(): FetchDeps {
  return {
    db: createDatabase(env.databaseUrl),
    store: createObjectStore(),
    http: createHttpClient({ perHostIntervalMs: HOST_INTERVALS_MS }),
  };
}

/** Kho bản thô theo `OBJECT_STORE`; thiếu biến R2 thì dừng ngay, không âm thầm ghi ra đĩa. */
export function createObjectStore(): ObjectStore {
  if (env.objectStore === "fs") return fsObjectStore(env.dataDir);
  const { endpoint, bucket, accessKeyId, secretAccessKey } = env.r2;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey)
    throw new Error(
      "OBJECT_STORE=r2 cần R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY",
    );
  return r2ObjectStore({ endpoint, bucket, accessKeyId, secretAccessKey });
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

/** Model ra quyết định qua AI Gateway; `null` khi chưa có khoá (nơi dùng phải tự bỏ qua bước hỏi). */
export function createDecider(db: Database): DecisionProvider | null {
  if (!process.env.AI_GATEWAY_API_KEY) return null;
  return gatewayDecision({ model: env.decisionModel, sink: dbUsageSink(db), priceBook });
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
    // Vùng xám của gộp sự kiện; không có khoá thì gộp như trước (chỉ theo ngưỡng vector).
    decider: createDecider(base.db),
    llm: createLlm(base.db),
    extractPage: extractPageText,
  };
}

/**
 * Hồ sơ mặc định của CLI (lệnh một người dùng: `topics`, `feedback`, `report`…): hồ sơ id 1.
 * KHÔNG dùng trong luồng chạy thật (digest, bot, web): ở đó hồ sơ suy ra từ người nhận qua
 * `profile_channels` (`profileOf`, `enabledRecipients`).
 */
export function cliDefaultProfileId(): number {
  return 1;
}

/** Kênh gửi digest; `null` khi chưa đặt TELEGRAM_BOT_TOKEN. Người nhận lấy từ `profile_channels`. */
export function createNotifier(): Notifier | null {
  if (!env.telegramToken) return null;
  return telegramNotifier({ token: env.telegramToken });
}

/**
 * Phụ thuộc của job digest; `null` khi chưa có kênh gửi. Chưa gắn hồ sơ và người nhận: `runDigestAll`
 * chạy cho từng người nhận đang bật của kênh, mỗi người với hồ sơ của họ. Không có LLM thì gửi bản
 * không tóm tắt; không có model quyết định thì cổng chủ đề dùng luật R ≥ gateR.
 */
export function createDigestDeps(base: FetchDeps): DigestJobDeps | null {
  const notifier = createNotifier();
  if (!notifier) return null;
  return {
    db: base.db,
    http: base.http,
    llm: createLlm(base.db),
    decider: createDecider(base.db),
    // Chỉ bật khi đủ cả hai biến; thiếu một thì tin giữ link trực tiếp như trước.
    tracking:
      env.publicBaseUrl && env.linkSecret
        ? { baseUrl: env.publicBaseUrl, secret: env.linkSecret }
        : undefined,
    notifier,
  };
}

export function createPagesDeps(base: FetchDeps): PagesDeps {
  return { db: base.db, store: base.store, fetcher: createPageFetcher({ http: base.http }) };
}

/** Kênh nhận lượt bấm; `null` khi chưa đặt token. Ai được dùng bot do `profile_channels` quyết định. */
export function createChatChannel(): ChatChannel | null {
  if (!env.telegramToken) return null;
  return telegramChat({ token: env.telegramToken });
}
