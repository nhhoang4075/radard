/**
 * Configuration from environment variables. Gathered in one place so you can see at a glance what the daemon needs to run.
 * Bun reads the `.env` file in the directory the command runs from automatically.
 */
export type Role = "scheduler" | "worker" | "bot" | "web" | "all";
export type EmbedderKind = "gateway" | "fake" | "none";
export type ObjectStoreKind = "fs" | "r2";

const num = (v: string | undefined, fallback: number) => (v ? Number(v) : fallback);

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/radard",
  /** `fs` writes the raw copy to `DATA_DIR` (dev); `r2` writes to an R2 bucket (deploy), which needs four `R2_*` variables. */
  objectStore: (process.env.OBJECT_STORE ?? "fs") as ObjectStoreKind,
  /** Raw copy directory when `OBJECT_STORE=fs`. */
  dataDir: process.env.DATA_DIR ?? "./data",
  r2: {
    endpoint: process.env.R2_ENDPOINT || undefined,
    bucket: process.env.R2_BUCKET || undefined,
    accessKeyId: process.env.R2_ACCESS_KEY_ID || undefined,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || undefined,
  },
  role: (process.env.SERVICE_ROLE ?? "all") as Role,

  /**
   * Telegram bot. Without a token, no digest is sent and the bot role does not run. Recipients
   * come from the `profile_channels` table (`channels add`), not from environment variables: the bot ignores any chat not in the table.
   */
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
  /** HTTP port of the `web` role (Railway sets `PORT`). */
  port: num(process.env.PORT, 8080),
  /**
   * HMAC secret that signs tracking links. Without it, the `/o/*` route returns 404 and messages keep direct links: there is no default secret.
   */
  linkSecret: process.env.LINK_SECRET || undefined,
  /** Public address of the `web` role (e.g. https://radard.example.com); together with `linkSecret` it enables tracking links. */
  publicBaseUrl: process.env.PUBLIC_BASE_URL || undefined,
  /**
   * Web sign-in (Better Auth). Without `BETTER_AUTH_SECRET` or `BETTER_AUTH_URL`, sign-in is disabled
   * (`/api/*` returns 503), but the daemon keeps running. Checked with zod in `web/auth-config.ts`.
   */
  auth: {
    secret: process.env.BETTER_AUTH_SECRET || undefined,
    baseURL:
      process.env.BETTER_AUTH_URL ||
      (process.env.NODE_ENV === "production"
        ? undefined
        : `http://localhost:${num(process.env.PORT, 8080)}`),
    bootstrapOwnerEmails: process.env.BOOTSTRAP_OWNER_EMAILS || undefined,
    githubClientId: process.env.GITHUB_CLIENT_ID || undefined,
    githubClientSecret: process.env.GITHUB_CLIENT_SECRET || undefined,
    googleClientId: process.env.GOOGLE_CLIENT_ID || undefined,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || undefined,
  },
  fetchConcurrency: num(process.env.FETCH_CONCURRENCY, 4),
  /**
   * Quota for "Với tôi?" (web and Telegram): number of answers the model writes per profile per day (Vietnam time). Cache
   * hits are not counted (decision 11/11/2026).
   */
  forMeDailyLimit: num(process.env.FOR_ME_DAILY_LIMIT, 100),

  /**
   * `gateway` requires `AI_GATEWAY_API_KEY`; `fake` is a hash-based bag-of-words embedding, only for testing the mechanism
   * (filter and merge results are meaningless for quality); `none` means the process job does not run.
   */
  embedder: (process.env.EMBEDDER ??
    (process.env.AI_GATEWAY_API_KEY ? "gateway" : "none")) as EmbedderKind,
  embedModel: process.env.EMBED_MODEL ?? "alibaba/qwen3-embedding-0.6b",
  /**
   * Minimum gap between two embedding requests. The free AI Gateway plan limits to 5
   * requests/minute (measured 06/10/2026, must be set to 12000); after adding credits (11/10/2026), 8 back-to-back requests all pass, so the default is 1 second. When the rate limit is hit, the adapter still waits on Retry-After by itself.
   */
  embedMinIntervalMs: num(process.env.EMBED_MIN_INTERVAL_MS, 1_000),
  /**
   * Text generation model (digest, later grey-zone arbitration, brief...). Default
   * anthropic/claude-haiku-5.5 (11/10/2026); change via `LLM_MODEL` to compare, e.g.
   * openai/gpt-6-luna. No price is configured: the cost written to `llm_calls` is the number Gateway reports for
   * each call (tiered pricing, cache and thinking tokens already counted); if Gateway reports none, it is estimated from the
   * tiered price table read from Gateway (`gateway-pricing.ts`).
   */
  llmModel: process.env.LLM_MODEL ?? "anthropic/claude-haiku-5.5",
  /**
   * Decision model (picks the answer with a probability, does not write text), via AI Gateway. Measured
   * 13/10/2026 (docs/mo-hinh-quyet-dinh.html tab 05): typesafe-ai/jev correct on 7/7 topic-relation cases,
   * ~0,5 seconds, $0,042 per million input tokens (output tokens free). Fallback at the same price:
   * microsoft/microsoft-decision-1 (also 7/7, twice as slow).
   */
  decisionModel: process.env.DECISION_MODEL ?? "typesafe-ai/jev",
  /** Batch cap (128 documents) per `process` job run, so the job finishes before its 30-minute deadline. */
  processMaxBatches: num(process.env.PROCESS_MAX_BATCHES, 60),
  /** Cap on documents merged per `process` run (~85 ms per document): 3.000 ≈ 4–5 minutes. */
  processMaxCluster: num(process.env.PROCESS_MAX_CLUSTER, 3000),

  /**
   * Merge threshold 0,9 (tuned 28/09/2026 on 2.569 real documents with qwen3-embedding-0.6b): between 0,8 and 0,9
   * both correct and wrong merges occur; only above 0,9 is it nearly certain to be the same article. The 0,85–0,9 range is handled by
   * the digest with a duplicate penalty. No threshold is relevant here anymore: every document is merged (D4).
   */
  thresholds: {
    join: num(process.env.JOIN_THRESHOLD, 0.9),
    windowDays: num(process.env.CLUSTER_WINDOW_DAYS, 7),
  },
};
