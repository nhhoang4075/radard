/**
 * Interface AI. Lõi chỉ biết những kiểu này; Vercel AI Gateway, gọi thẳng provider hay model
 * chạy local đều là adapter (ports & adapters).
 *
 * Mọi lời gọi báo về một `UsageSink` để ghi vào bảng `llm_calls`: chi phí thật đo được, không
 * phải ước tính. Model reasoning có token suy nghĩ ẩn tính theo giá output, nên phải đo.
 */

/** Việc mà lời gọi phục vụ, để xem chi phí theo từng bước pipeline. */
export type AiTask = "embed_document" | "embed_profile" | "digest" | (string & {});

export interface UsageEvent {
  task: AiTask;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  /**
   * `gateway`: số tiền Gateway báo cho đúng lời gọi này (đã tính bậc giá theo độ dài prompt,
   * cache, vùng). `estimate`: tính từ bảng giá có bậc của Gateway, khi Gateway không báo số
   * tiền. `unknown`: không có cả bảng giá, chi phí ghi 0.
   */
  costSource?: "gateway" | "estimate" | "unknown";
  /** Id lời gọi phía Gateway, để đối chiếu với trang quản lý của Vercel. */
  generationId?: string;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

export type UsageSink = (event: UsageEvent) => Promise<void>;

export interface EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  /** Số chiều cố định; adapter phải từ chối vector khác số chiều để không làm hỏng cột DB. */
  readonly dimensions: number;
  embed(texts: string[], task: AiTask): Promise<number[][]>;
}

export interface LlmProvider {
  readonly provider: string;
  readonly model: string;
  generateText(opts: {
    task: AiTask;
    system?: string;
    prompt: string;
    maxOutputTokens?: number;
  }): Promise<string>;
}

/**
 * Câu hỏi cho model ra quyết định (Jev và loại tương tự): model không viết văn bản, chỉ trả đúng
 * kiểu được hỏi kèm xác suất. `boolean`: xác suất câu trả lời là "có". `choice`: chọn một tên
 * trong `criteria` (tên → mô tả phương án), kèm xác suất cho từng phương án.
 *
 * Mỗi câu chỉ hỏi một điều (lời khuyên trong tài liệu Jev); nhiều câu về cùng một trạng thái thì
 * gửi chung một lời gọi.
 */
export type DecisionQuestion =
  | { readonly type: "boolean"; readonly instructions: string }
  | {
      readonly type: "choice";
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, string>>;
    };

export type DecisionAnswer<Q extends DecisionQuestion> = Q extends {
  type: "choice";
  criteria: infer C;
}
  ? {
      type: "choice";
      choice: Extract<keyof C, string>;
      /** Đủ mọi phương án, tổng xấp xỉ 1. */
      probabilities: Record<Extract<keyof C, string>, number>;
    }
  : { type: "boolean"; probability: number };

export interface DecisionResult<Qs extends Record<string, DecisionQuestion>> {
  answers: { [K in keyof Qs]: DecisionAnswer<Qs[K]> };
  usage: { inputTokens: number; costUsd: number };
  /** Id model đã trả lời (provider có thể trả bản cụ thể hơn id đã cấu hình). */
  model: string;
}

/** Trạng thái chung mà mọi câu hỏi cùng xét: văn bản, hoặc một object JSON. */
export type DecisionState = string | { readonly [key: string]: unknown };

export interface DecisionProvider {
  readonly provider: string;
  readonly model: string;
  /** Một lời gọi cho mọi câu hỏi. Lỗi, hay model từ chối trả lời câu nào, thì cả lời gọi lỗi. */
  decide<const Qs extends Record<string, DecisionQuestion>>(opts: {
    task: AiTask;
    state: DecisionState;
    questions: Qs;
  }): Promise<DecisionResult<Qs>>;
}
