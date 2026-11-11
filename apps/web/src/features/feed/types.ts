/**
 * Kiểu dữ liệu Feed lấy thẳng từ API Hono (`hc<AppType>`): đổi hợp đồng ở server thì web báo lỗi kiểu lúc build.
 * Chỉ thêm kiểu cục bộ cho thứ không đi qua API.
 */
import type { InferResponseType } from "hono/client";
import type { api } from "../../lib/api.ts";

export type FeedPage = InferResponseType<typeof api.feed.$get, 200>;
export type FeedItem = FeedPage["items"][number];
export type FeedDates = InferResponseType<(typeof api.feed.dates)["$get"], 200>;
export type EventDetail = InferResponseType<(typeof api.events)[":id"]["$get"], 200>;
export type FeedbackState = FeedItem["feedback"]; // "like" | "dislike" | "none"
export type FeedbackKind = Exclude<FeedbackState, "none">;
export type ForMe = { text: string; cached: boolean };
export type ImpressionInput = { snapshotId: number; position: number };

/** Lỗi "Với tôi?" theo mã HTTP của backend: 429 hết hạn mức, 503 model chưa sẵn sàng. */
export class ForMeError extends Error {
  constructor(readonly kind: "limit" | "unavailable" | "other") {
    super(kind);
  }
}
