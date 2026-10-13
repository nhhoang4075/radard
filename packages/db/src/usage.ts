/**
 * Ghi mỗi lời gọi model vào `llm_calls`. Đặt ở đây vì chỉ package db biết cấu trúc bảng;
 * adapter AI chỉ biết interface `UsageSink` của lõi.
 */
import type { UsageSink } from "@radard/core";
import type { Database } from "./client.ts";
import { llmCalls } from "./schema/ops.ts";

export function dbUsageSink(db: Database): UsageSink {
  return async (e) => {
    await db.insert(llmCalls).values({ ...e, error: e.error ?? null });
  };
}
