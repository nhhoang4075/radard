/**
 * Builds the shared dependencies for the daemon and the CLI, so both run jobs in exactly the same way.
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

/** Raw-content store chosen by `OBJECT_STORE`; missing R2 variables stop startup immediately rather than silently writing to disk. */
export function createObjectStore(): ObjectStore {
  if (env.objectStore === "fs") return fsObjectStore(env.dataDir);
  const { endpoint, bucket, accessKeyId, secretAccessKey } = env.r2;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey)
    throw new Error(
      "OBJECT_STORE=r2 cần R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY",
    );
  return r2ObjectStore({ endpoint, bucket, accessKeyId, secretAccessKey });
}

/** One price table shared by the whole process: read from the Gateway at most once a day. */
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

/** Text-generation model via the AI Gateway; `null` when there is no key (the digest will report a clear error). */
export function createLlm(db: Database): LlmProvider | null {
  if (!process.env.AI_GATEWAY_API_KEY) return null;
  return gatewayLlm({
    model: env.llmModel,
    sink: dbUsageSink(db),
    priceBook,
  });
}

/** Decision model via the AI Gateway; `null` when there is no key (callers must skip the question step themselves). */
export function createDecider(db: Database): DecisionProvider | null {
  if (!process.env.AI_GATEWAY_API_KEY) return null;
  return gatewayDecision({ model: env.decisionModel, sink: dbUsageSink(db), priceBook });
}

/** `null` when no embedder is configured: the process job is skipped, while collection still runs normally. */
export function createProcessDeps(base: FetchDeps): ProcessDeps | null {
  const embedder = createEmbedder(base.db);
  if (!embedder) return null;
  return {
    db: base.db,
    store: base.store,
    embedder,
    thresholds: env.thresholds,
    // The grey zone of event merging; without a key, merge as before (by vector threshold only).
    decider: createDecider(base.db),
    llm: createLlm(base.db),
    extractPage: extractPageText,
  };
}

/**
 * Default profile for the CLI (single-user commands: `topics`, `feedback`, `report`…): profile id 1.
 * NOT used in the real flows (digest, bot, web): there the profile is derived from the recipient via
 * `profile_channels` (`profileOf`, `enabledRecipients`).
 */
export function cliDefaultProfileId(): number {
  return 1;
}

/** Digest delivery channel; `null` when TELEGRAM_BOT_TOKEN is not set. Recipients come from `profile_channels`. */
export function createNotifier(): Notifier | null {
  if (!env.telegramToken) return null;
  return telegramNotifier({ token: env.telegramToken });
}

/**
 * Dependencies of the digest job; `null` when there is no delivery channel. Profile and recipient are not bound here: `runDigestAll`
 * runs once for each enabled recipient of the channel, each with their own profile. Without an LLM it sends the
 * digest without summaries; without a decision model the topic gate uses the rule R ≥ gateR.
 */
export function createDigestDeps(base: FetchDeps): DigestJobDeps | null {
  const notifier = createNotifier();
  if (!notifier) return null;
  return {
    db: base.db,
    http: base.http,
    llm: createLlm(base.db),
    decider: createDecider(base.db),
    // Enabled only when both variables are set; if one is missing, the message keeps the direct link as before.
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

/** Callback channel for button presses; `null` when no token is set. Who may use the bot is decided by `profile_channels`. */
export function createChatChannel(): ChatChannel | null {
  if (!env.telegramToken) return null;
  return telegramChat({ token: env.telegramToken });
}
