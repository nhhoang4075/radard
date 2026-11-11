/**
 * Records each model call into `llm_calls`. Placed here because only the db package knows the table structure;
 * AI adapters only know the core's `UsageSink` interface.
 */
import type { UsageSink } from "@radard/core";
import type { Database } from "./client.ts";
import { llmCalls } from "./schema/ops.ts";

export function dbUsageSink(db: Database): UsageSink {
  return async (e) => {
    await db.insert(llmCalls).values({ ...e, error: e.error ?? null });
  };
}
