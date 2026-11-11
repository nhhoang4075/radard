/**
 * Feed types taken directly from the Hono API (`hc<AppType>`): if the server contract changes, the web build reports a type error.
 * Only local types are added here, for things that do not go through the API.
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

/** "Với tôi?" errors by the backend HTTP code: 429 quota used up, 503 model not ready. */
export class ForMeError extends Error {
  constructor(readonly kind: "limit" | "unavailable" | "other") {
    super(kind);
  }
}
