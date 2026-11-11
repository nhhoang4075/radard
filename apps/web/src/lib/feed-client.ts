/**
 * Máy khách Feed: một giao diện, hai cài đặt.
 *  - `fetchClient`: gọi route thật (hợp đồng mục 4 docs/cau-truc-web.html).
 *  - fixtures: dữ liệu giả, CHỈ khi chạy dev và chưa bật `VITE_FEED_API=1` (backend còn thiếu route feed).
 * "Với tôi?" luôn gọi route thật vì đã có ở backend.
 */
import type {
  EventDetail,
  FeedDates,
  FeedFeedbackKind,
  FeedPage,
  ForMe,
  ImpressionInput,
} from "../features/feed/types.ts";
import { ForMeError } from "../features/feed/types.ts";
import { HttpError } from "./api.ts";

export interface FeedClient {
  getFeed(q: { date?: string; cursor?: string | null }): Promise<FeedPage>;
  getDates(): Promise<FeedDates>;
  getEvent(eventId: number): Promise<EventDetail>;
  putFeedback(q: { feedItemId: number; kind: FeedFeedbackKind | "clear" }): Promise<void>;
  postImpressions(batch: ImpressionInput[]): Promise<void>;
  forMe(eventId: number): Promise<ForMe>;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new HttpError(res.status);
  return (await res.json()) as T;
}

const forMe = async (eventId: number): Promise<ForMe> => {
  const res = await fetch(`/api/events/${eventId}/for-me`, { method: "POST" });
  if (res.status === 429) throw new ForMeError("limit");
  if (res.status === 503) throw new ForMeError("unavailable");
  if (!res.ok) throw new ForMeError("other");
  return (await res.json()) as ForMe;
};

export const fetchClient: FeedClient = {
  async getFeed({ date, cursor }) {
    const p = new URLSearchParams();
    if (date) p.set("date", date);
    if (cursor) p.set("cursor", cursor);
    return json(await fetch(`/api/feed?${p}`));
  },
  async getDates() {
    return json(await fetch("/api/feed/dates"));
  },
  async getEvent(eventId) {
    return json(await fetch(`/api/events/${eventId}`));
  },
  async putFeedback(body) {
    const res = await fetch("/api/feedback", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new HttpError(res.status);
  },
  async postImpressions(batch) {
    // keepalive để lô cuối không mất khi trang đóng; lỗi lượt hiện không làm phiền người dùng.
    await fetch("/api/impressions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch),
      keepalive: true,
    });
  },
  forMe,
};

let cached: FeedClient | null = null;
export async function getFeedClient(): Promise<FeedClient> {
  if (cached) return cached;
  if (import.meta.env.DEV && import.meta.env.VITE_FEED_API !== "1") {
    const { fixtureClient } = await import("../features/feed/fixtures.ts");
    cached = { ...fixtureClient, forMe };
  } else {
    cached = fetchClient;
  }
  return cached;
}
