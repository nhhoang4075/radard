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
