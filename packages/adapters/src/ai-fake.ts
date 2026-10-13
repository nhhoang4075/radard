/**
 * Embedding giả, tất định, không gọi mạng: băm từng từ vào một chiều của vector.
 *
 * Hai văn bản có nhiều từ chung thì cosine cao, nên đủ để test logic lọc và gộp mà không
 * tốn tiền hay cần khoá API. Không dùng để đo chất lượng: ngưỡng thật phải chỉnh trên model thật.
 */
import type { EmbeddingProvider, LlmProvider, UsageSink } from "@radard/core";

function hashWord(word: string, dims: number): number {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
  return (h >>> 0) % dims;
}

export function fakeEmbedding(opts: { dimensions: number; sink?: UsageSink }): EmbeddingProvider {
  return {
    provider: "fake",
    model: "hash-bag-of-words",
    dimensions: opts.dimensions,
    async embed(texts, task) {
      const out = texts.map((t) => {
        const v = new Array<number>(opts.dimensions).fill(0);
        for (const w of t.toLowerCase().match(/\p{L}[\p{L}\p{N}]+/gu) ?? []) {
          const i = hashWord(w, opts.dimensions);
          v[i] = (v[i] ?? 0) + 1;
        }
        return v;
      });
      await opts.sink?.({
        task,
        provider: "fake",
        model: "hash-bag-of-words",
        inputTokens: texts.join(" ").length,
        outputTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        ok: true,
      });
      return out;
    },
  };
}

/**
 * LLM giả, không gọi mạng: trả đúng chuỗi do test cung cấp (hàm của prompt), và ghi một lời
 * gọi vào `sink` như adapter thật.
 */
export function fakeLlm(opts: {
  reply: (prompt: string, system?: string) => string | Promise<string>;
  sink?: UsageSink;
}): LlmProvider {
  return {
    provider: "fake",
    model: "fake-llm",
    async generateText({ task, system, prompt }) {
      const text = await opts.reply(prompt, system);
      await opts.sink?.({
        task,
        provider: "fake",
        model: "fake-llm",
        inputTokens: prompt.length,
        outputTokens: text.length,
        reasoningTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        ok: true,
      });
      return text;
    },
  };
}
