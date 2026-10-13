/**
 * Bảng vận hành: không phải dữ liệu nghiệp vụ, mà là số đo để biết hệ thống tốn bao nhiêu.
 */
import {
  bigint,
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** Mỗi lời gọi model một dòng: chi phí thật đo được, theo từng việc của pipeline. */
export const llmCalls = pgTable(
  "llm_calls",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    task: text("task").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    reasoningTokens: integer("reasoning_tokens").notNull(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 8, mode: "number" }).notNull(),
    /** gateway (số Gateway báo) | estimate (tính từ bảng giá có bậc) | unknown. Trước 11/10: trống. */
    costSource: text("cost_source"),
    generationId: text("generation_id"),
    latencyMs: integer("latency_ms").notNull(),
    ok: boolean("ok").notNull(),
    error: text("error"),
  },
  (t) => [index("llm_calls_at_idx").on(t.at)],
);
