/**
 * Operational tables: not business data, but measurements showing how much the system costs.
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

/** One row per model call: real measured cost, per pipeline step. */
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
    /** gateway (the number Gateway reports) | estimate (computed from a tiered price table) | unknown. Before 11/10: empty. */
    costSource: text("cost_source"),
    generationId: text("generation_id"),
    latencyMs: integer("latency_ms").notNull(),
    ok: boolean("ok").notNull(),
    error: text("error"),
  },
  (t) => [index("llm_calls_at_idx").on(t.at)],
);
