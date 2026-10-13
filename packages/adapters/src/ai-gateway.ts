/**
 * Adapter AI qua Vercel AI Gateway (AI SDK 7). Truyền model dạng chuỗi `provider/model`,
 * AI SDK tự đi qua Gateway khi có `AI_GATEWAY_API_KEY`.
 *
 * Nơi duy nhất import `ai`: đổi sang gọi thẳng provider hay model local chỉ cần một adapter
 * khác cùng interface.
 */
import {
  type AiTask,
  createLogger,
  type EmbeddingProvider,
  type LlmProvider,
  type UsageSink,
} from "@radard/core";
import { embedMany, generateText } from "ai";
import type { PriceBook, TokenUsage } from "./gateway-pricing.ts";

const PROVIDER = "vercel-gateway";
const log = createLogger("ai-gateway");

/**
 * Gateway trả lỗi rate limit kèm "Retry after Ns" (gói miễn phí: 5 request/phút cho model
 * embedding, đo 06/10/2026). AI SDK tự thử lại sau 2–4 giây rồi bỏ cuộc, quá ngắn; ở đây
 * chờ đúng thời gian Gateway yêu cầu. Lỗi khác thì thử lại 2 lần như AI SDK.
 */
/** Số giây phải chờ nếu `err` là lỗi rate limit của Gateway; `null` nếu là lỗi khác. */
export function rateLimitWait(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  if (name !== "GatewayRateLimitError" && !/rate limit/i.test(msg)) return null;
  return Number(/retry after (\d+)\s*s/i.exec(msg)?.[1] ?? 60);
}

async function withRetry<T>(call: () => Promise<T>, label: string): Promise<T> {
  let rateLimited = 0;
  let other = 0;
  for (;;) {
    try {
      return await call();
    } catch (err) {
      const wait = rateLimitWait(err);
      if (wait === null ? ++other > 2 : ++rateLimited > 4) throw err;
      if (wait !== null) log.warn("chạm rate limit, chờ rồi gọi lại", { label, waitSeconds: wait });
      await Bun.sleep(wait === null ? 2000 * other : wait * 1000);
    }
  }
}

/**
 * Chi phí thật Gateway báo trong `providerMetadata.gateway.cost` (USD, dạng chuỗi). Giá chia
 * bậc theo độ dài prompt (Haiku 5.5: gấp 5 lần từ 100k token), cache, vùng, service tier, nên
 * tự tính từ một đơn giá cố định sẽ sai khi đổi model hoặc prompt dài. Không có thì `null`.
 */
export function reportedCost(meta: unknown): { cost: number; generationId?: string } | null {
  const g = (meta as { gateway?: { cost?: unknown; generationId?: unknown } } | undefined)?.gateway;
  const cost = Number(g?.cost);
  if (g?.cost === undefined || !Number.isFinite(cost)) return null;
  return { cost, generationId: typeof g.generationId === "string" ? g.generationId : undefined };
}

/**
 * Chi phí của một lời gọi: số Gateway báo nếu có (`gateway`); không thì ước tính từ bảng giá
 * có bậc (`estimate`); không có cả bảng giá thì 0 và `unknown`, để `costs` thấy là thiếu số.
 */
async function costOf(meta: unknown, model: string, usage: TokenUsage, book?: PriceBook) {
  const r = reportedCost(meta);
  if (r) return { costUsd: r.cost, costSource: "gateway" as const, generationId: r.generationId };
  const est = book ? await book.estimate(model, usage) : null;
  return est === null
    ? { costUsd: 0, costSource: "unknown" as const }
    : { costUsd: est, costSource: "estimate" as const };
}

/** Giãn nhịp: mỗi lời gọi cách lời gọi trước ít nhất `ms`. */
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
  /** Dự phòng khi Gateway không báo chi phí. */
  priceBook?: PriceBook;
  /** Khoảng cách tối thiểu giữa hai request (ms), để không chạm hạn mức của tài khoản. */
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
          // maxParallelCalls 1: AI SDK có thể tách lô thành nhiều request song song, mỗi
          // request đều tính vào hạn mức.
          return embedMany({
            model: opts.model,
            values: texts,
            maxRetries: 0,
            maxParallelCalls: 1,
          });
        }, `embed ${opts.model}`);
        const bad = res.embeddings.find((e) => e.length !== opts.dimensions);
        if (bad) {
          // Chặn ngay ở đây: ghi vector sai số chiều vào cột halfvec(n) sẽ hỏng cả lô.
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
  /** Dự phòng khi Gateway không báo chi phí. */
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
