/**
 * AI adapter via Vercel AI Gateway (AI SDK 7). Pass the model as a `provider/model` string,
 * the AI SDK routes through Gateway automatically when `AI_GATEWAY_API_KEY` is set.
 *
 * The only place that imports `ai`: switching to calling a provider directly or a local model needs only another adapter
 * with the same interface.
 */
import {
  type AiTask,
  createLogger,
  type DecisionProvider,
  type DecisionQuestion,
  type DecisionResult,
  type EmbeddingProvider,
  type LlmProvider,
  type UsageSink,
} from "@radard/core";
import {
  type Experimental_DecisionModel,
  type Experimental_DecisionQuestion,
  type Experimental_DecisionState,
  embedMany,
  experimental_decide,
  generateText,
} from "ai";
import type { PriceBook, TokenUsage } from "./gateway-pricing.ts";

const PROVIDER = "vercel-gateway";
const log = createLogger("ai-gateway");

/**
 * Gateway returns a rate-limit error with "Retry after Ns" (free tier: 5 requests/min for models
 * embedding, measured 06/10/2026). The AI SDK retries after 2–4 seconds and then gives up, which is too short; here we
 * wait the exact time Gateway asks for. Other errors are retried 2 times, as in the AI SDK.
 */
/** Seconds to wait if `err` is a Gateway rate-limit error; `null` if it is another error. */
export function rateLimitWait(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  if (name !== "GatewayRateLimitError" && !/rate limit/i.test(msg)) return null;
  return Number(/retry after (\d+)\s*s/i.exec(msg)?.[1] ?? 60);
}

async function withRetry<T>(
  call: () => Promise<T>,
  label: string,
  /** Number of retries on errors that are not rate limits. */
  otherRetries = 2,
): Promise<T> {
  let rateLimited = 0;
  let other = 0;
  for (;;) {
    try {
      return await call();
    } catch (err) {
      const wait = rateLimitWait(err);
      if (wait === null ? ++other > otherRetries : ++rateLimited > 4) throw err;
      if (wait !== null) log.warn("chạm rate limit, chờ rồi gọi lại", { label, waitSeconds: wait });
      await Bun.sleep(wait === null ? 2000 * other : wait * 1000);
    }
  }
}

/**
 * The real cost Gateway reports in `providerMetadata.gateway.cost` (USD, as a string). Prices are split
 * into tiers by prompt length (Haiku 5.5: 5x from 100k tokens), cache, region, service tier, so
 * computing it from a fixed unit price would be wrong when the model changes or a prompt is long. If absent: `null`.
 */
export function reportedCost(meta: unknown): { cost: number; generationId?: string } | null {
  const g = (meta as { gateway?: { cost?: unknown; generationId?: unknown } } | undefined)?.gateway;
  const cost = Number(g?.cost);
  if (g?.cost === undefined || !Number.isFinite(cost)) return null;
  return { cost, generationId: typeof g.generationId === "string" ? g.generationId : undefined };
}

/**
 * Cost of one call: the number Gateway reports if present (`gateway`); otherwise estimated from the tiered price table
 * (`estimate`); with no price table either, 0 and `unknown`, so `costs` shows that the number is missing.
 */
async function costOf(meta: unknown, model: string, usage: TokenUsage, book?: PriceBook) {
  const r = reportedCost(meta);
  if (r) return { costUsd: r.cost, costSource: "gateway" as const, generationId: r.generationId };
  const est = book ? await book.estimate(model, usage) : null;
  return est === null
    ? { costUsd: 0, costSource: "unknown" as const }
    : { costUsd: est, costSource: "estimate" as const };
}

/** Pacing: each call is at least `ms` after the previous call. */
function pacer(ms: number) {
  let last = 0;
  return async () => {
    const wait = last + ms - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    last = Date.now();
  };
}

export function gatewayEmbedding(opts: {
  model: string;
  dimensions: number;
  sink: UsageSink;
  /** Fallback when Gateway does not report the cost. */
  priceBook?: PriceBook;
  /** Minimum gap between two requests (ms), so the account's quota is not hit. */
  minIntervalMs?: number;
}): EmbeddingProvider {
  const pace = pacer(opts.minIntervalMs ?? 0);
  return {
    provider: PROVIDER,
    model: opts.model,
    dimensions: opts.dimensions,
    async embed(texts: string[], task: AiTask) {
      const started = Date.now();
      try {
        const res = await withRetry(async () => {
          await pace();
          // maxParallelCalls 1: the AI SDK may split a batch into several parallel requests, each
          // request counts toward the quota.
          return embedMany({
            model: opts.model,
            values: texts,
            maxRetries: 0,
            maxParallelCalls: 1,
          });
        }, `embed ${opts.model}`);
        const bad = res.embeddings.find((e) => e.length !== opts.dimensions);
        if (bad) {
          // Block it right here: writing a vector of the wrong dimension into the halfvec(n) column would break the whole batch.
          throw new Error(`model trả ${bad.length} chiều, cấu hình là ${opts.dimensions}`);
        }
        await opts.sink({
          task,
          provider: PROVIDER,
          model: opts.model,
          inputTokens: res.usage.tokens,
          outputTokens: 0,
          reasoningTokens: 0,
          ...(await costOf(
            res.providerMetadata,
            opts.model,
            { input: res.usage.tokens },
            opts.priceBook,
          )),
          latencyMs: Date.now() - started,
          ok: true,
        });
        return res.embeddings;
      } catch (err) {
        await opts.sink(failure(task, opts.model, started, err));
        throw err;
      }
    },
  };
}

export function gatewayLlm(opts: {
  model: string;
  sink: UsageSink;
  /** Fallback when Gateway does not report the cost. */
  priceBook?: PriceBook;
}): LlmProvider {
  return {
    provider: PROVIDER,
    model: opts.model,
    async generateText({ task, system, prompt, maxOutputTokens }) {
      const started = Date.now();
      try {
        const res = await generateText({ model: opts.model, system, prompt, maxOutputTokens });
        const input = res.usage.inputTokens ?? 0;
        const output = res.usage.outputTokens ?? 0;
        await opts.sink({
          task,
          provider: PROVIDER,
          model: opts.model,
          inputTokens: input,
          outputTokens: output,
          reasoningTokens: res.usage.outputTokenDetails.reasoningTokens ?? 0,
          ...(await costOf(
            res.providerMetadata,
            opts.model,
            {
              input,
              cacheRead: res.usage.inputTokenDetails?.cacheReadTokens ?? 0,
              cacheWrite: res.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
              output,
            },
            opts.priceBook,
          )),
          latencyMs: Date.now() - started,
          ok: true,
        });
        return res.text;
      } catch (err) {
        await opts.sink(failure(task, opts.model, started, err));
        throw err;
      }
    },
  };
}

/** Raw AI SDK answer, before conversion to the core's type. */
interface RawDecisionAnswer {
  type: string;
  probability?: number;
  choice?: string;
  probabilities?: Record<string, number>;
}

/**
 * Converts the AI SDK answer to the core's type. A `choice` answer always has probabilities for each
 * option: if the provider returns no distribution, the chosen option gets 1 and the rest 0.
 */
export function toDecisionAnswer(q: DecisionQuestion, a: RawDecisionAnswer | undefined) {
  if (!a || a.type !== q.type) throw new Error(`câu trả lời sai kiểu: ${JSON.stringify(a)}`);
  if (q.type === "boolean") return { type: "boolean" as const, probability: a.probability ?? 0 };
  const choice = a.choice ?? "";
  const probabilities: Record<string, number> = {};
  for (const name of Object.keys(q.criteria)) {
    probabilities[name] = a.probabilities?.[name] ?? (name === choice ? 1 : 0);
  }
  return { type: "choice" as const, choice, probabilities };
}

/**
 * Decision model (Jev…) via AI Gateway, using the AI SDK's `experimental_decide`. Gateway classifies
 * these models as "evaluation", counting only input token prices (output tokens are free). `model` is an id of the form
 * `provider/model`, or a built-in AI SDK model (tests use the fake model of `ai/test`).
 */
export function gatewayDecision(opts: {
  model: Experimental_DecisionModel;
  sink: UsageSink;
  /** Fallback when Gateway does not report the cost. */
  priceBook?: PriceBook;
}): DecisionProvider {
  const modelId = typeof opts.model === "string" ? opts.model : opts.model.modelId;
  return {
    provider: PROVIDER,
    model: modelId,
    async decide({ task, state, questions }) {
      const started = Date.now();
      try {
        const res = await withRetry(
          () =>
            experimental_decide({
              model: opts.model,
              state: state as Experimental_DecisionState,
              questions: questions as Record<string, Experimental_DecisionQuestion>,
              // A transient error so the AI SDK retries it itself; if the model refuses or the answer has the wrong type, then
              // retrying is useless, so outside this only the rate limit is waited on.
              maxRetries: 2,
            }),
          `decide ${modelId}`,
          0,
        );
        const raw = res.answers as Record<string, RawDecisionAnswer>;
        const answers: Record<string, unknown> = {};
        for (const [id, q] of Object.entries(questions)) answers[id] = toDecisionAnswer(q, raw[id]);
        const input = res.usage.inputTokens ?? 0;
        const output = res.usage.outputTokens ?? 0;
        const cost = await costOf(res.providerMetadata, modelId, { input, output }, opts.priceBook);
        await opts.sink({
          task,
          provider: PROVIDER,
          model: modelId,
          inputTokens: input,
          outputTokens: output,
          reasoningTokens: 0,
          ...cost,
          latencyMs: Date.now() - started,
          ok: true,
        });
        return {
          answers: answers as DecisionResult<typeof questions>["answers"],
          usage: { inputTokens: input, costUsd: cost.costUsd },
          model: res.response.modelId || modelId,
        };
      } catch (err) {
        await opts.sink(failure(task, modelId, started, err));
        throw err;
      }
    },
  };
}

function failure(task: AiTask, model: string, started: number, err: unknown) {
  return {
    task,
    provider: PROVIDER,
    model,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    latencyMs: Date.now() - started,
    ok: false,
    error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
  };
}
