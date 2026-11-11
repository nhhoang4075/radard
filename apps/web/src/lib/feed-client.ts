/**
 * Máy khách Feed: một giao diện, cài đặt thật dùng `hc<AppType>` (có kiểu). Có thể thay bằng dữ liệu giả
 * (`setFeedClient(fixtureClient)`), chỉ dùng cho trang xem trước dev `/_design/feed` không cần đăng nhập.
 */
import type {
  EventDetail,
  FeedbackKind,
  FeedDates,
  FeedPage,
  ForMe,
  ImpressionInput,
} from "../features/feed/types.ts";
import { ForMeError } from "../features/feed/types.ts";
import { api, HttpError } from "./api.ts";

export interface FeedClient {
  getFeed(q: { date?: string; cursor?: string | null }): Promise<FeedPage>;
  getDates(): Promise<FeedDates>;
  getEvent(eventId: number): Promise<EventDetail>;
  /** Bấm lại đúng nút đang chọn thì server bỏ chọn; trả trạng thái mới. */
  putFeedback(q: { feedItemId: number; kind: FeedbackKind }): Promise<"like" | "dislike" | "none">;
  postImpressions(batch: ImpressionInput[]): Promise<void>;
  forMe(eventId: number): Promise<ForMe>;
}

export const fetchClient: FeedClient = {
  async getFeed({ date, cursor }) {
    // limit=50 ≥ K (≤ 30): lấy trọn bản chụp một lần, chip chủ đề và số đếm ở banner dùng được ngay.
    const res = await api.feed.$get({
      query: { limit: "50", ...(date ? { date } : {}), ...(cursor ? { cursor } : {}) },
    });
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
  },
  async getDates() {
    const res = await api.feed.dates.$get();
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
  },
  async getEvent(eventId) {
    const res = await api.events[":id"].$get({ param: { id: String(eventId) } });
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
  },
  async putFeedback(json) {
    const res = await api.feedback.$put({ json });
    if (!res.ok) throw new HttpError(res.status);
    return (await res.json()).state;
  },
  async postImpressions(items) {
    const res = await api.impressions.$post({ json: { items } });
    if (!res.ok) throw new HttpError(res.status);
  },
  async forMe(eventId) {
    const res = await api.events[":id"]["for-me"].$post({ param: { id: String(eventId) } });
    if (res.status === 429) throw new ForMeError("limit");
    if (res.status === 503) throw new ForMeError("unavailable");
    if (!res.ok) throw new ForMeError("other");
    return (await res.json()) as ForMe;
  },
};

let current: FeedClient = fetchClient;
export const getFeedClient = (): FeedClient => current;
export const setFeedClient = (c: FeedClient): void => {
  current = c;
};
