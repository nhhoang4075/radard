/**
 * Embedding giả, tất định, không gọi mạng: băm từng từ vào một chiều của vector.
 *
 * Hai văn bản có nhiều từ chung thì cosine cao, nên đủ để test logic lọc và gộp mà không
 * tốn tiền hay cần khoá API. Không dùng để đo chất lượng: ngưỡng thật phải chỉnh trên model thật.
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

/**
 * Câu trả lời của model quyết định giả cho một câu hỏi: số là xác suất của câu `boolean`; chuỗi
 * là phương án được chọn của câu `choice` (xác suất 1); hoặc ghi đủ phương án và xác suất.
 */
export type FakeDecisionReply =
  | number
  | string
  | { choice: string; probabilities: Record<string, number> };

/**
 * Model quyết định giả, tất định, không gọi mạng: hàm `answer` của test trả lời từng câu. Kiểm
 * kiểu câu trả lời như adapter thật (chọn phương án không có trong `criteria` thì lỗi), và ghi
 * một lời gọi vào `sink`.
 */
export function fakeDecision(opts: {
  answer: (
    question: DecisionQuestion,
    id: string,
    state: DecisionState,
  ) => FakeDecisionReply | Promise<FakeDecisionReply>;
  sink?: UsageSink;
  /** Chi phí giả mỗi lời gọi, để test phần cộng chi phí. */
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
