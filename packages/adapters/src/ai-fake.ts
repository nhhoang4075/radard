/**
 * Fake embedding, deterministic, no network calls: hashes each word into one dimension of the vector.
 *
 * Two texts with many shared words get a high cosine, so it is enough to test filtering and merging logic without
 * spending money or needing an API key. Do not use it to measure quality: real thresholds must be tuned on the real model.
 */
import type {
  DecisionProvider,
  DecisionQuestion,
  DecisionResult,
  DecisionState,
  EmbeddingProvider,
  LlmProvider,
  UsageSink,
} from "@radard/core";

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
 * Fake LLM, no network calls: returns the exact string the test provides (a function of the prompt), and records one call
 * into `sink`, like the real adapter.
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

/**
 * Fake decision-model answer to a question: a number is the probability for a `boolean` question; a string
 * is the option chosen for a `choice` question (probability 1); or lists every option and its probability.
 */
export type FakeDecisionReply =
  | number
  | string
  | { choice: string; probabilities: Record<string, number> };

/**
 * Fake decision model, deterministic, no network calls: the test's `answer` function answers each question. Checks
 * the answer type like the real adapter does (choosing an option not in `criteria` is an error), and records
 * one call into `sink`.
 */
export function fakeDecision(opts: {
  answer: (
    question: DecisionQuestion,
    id: string,
    state: DecisionState,
  ) => FakeDecisionReply | Promise<FakeDecisionReply>;
  sink?: UsageSink;
  /** Fake cost per call, to test cost summation. */
  costUsd?: number;
}): DecisionProvider {
  return {
    provider: "fake",
    model: "fake-decision",
    async decide({ task, state, questions }) {
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(questions)) {
        answers[id] = toFakeAnswer(q, await opts.answer(q, id, state));
      }
      const inputTokens = JSON.stringify({ state, questions }).length;
      const costUsd = opts.costUsd ?? 0;
      await opts.sink?.({
        task,
        provider: "fake",
        model: "fake-decision",
        inputTokens,
        outputTokens: 0,
        reasoningTokens: 0,
        costUsd,
        latencyMs: 0,
        ok: true,
      });
      return {
        answers: answers as DecisionResult<typeof questions>["answers"],
        usage: { inputTokens, costUsd },
        model: "fake-decision",
      };
    },
  };
}

function toFakeAnswer(q: DecisionQuestion, r: FakeDecisionReply) {
  if (q.type === "boolean") {
    if (typeof r !== "number") throw new Error("câu boolean cần trả một xác suất");
    return { type: "boolean" as const, probability: r };
  }
  if (typeof r === "number") throw new Error("câu choice cần trả tên phương án");
  const choice = typeof r === "string" ? r : r.choice;
  if (!(choice in q.criteria)) throw new Error(`không có phương án "${choice}"`);
  const probabilities: Record<string, number> = {};
  for (const name of Object.keys(q.criteria)) {
    const p = typeof r === "string" ? Number(name === choice) : r.probabilities[name];
    probabilities[name] = p ?? 0;
  }
  return { type: "choice" as const, choice, probabilities };
}
