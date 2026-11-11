/**
 * Kiểu dữ liệu Feed phía web, theo hợp đồng mục 4 của docs/cau-truc-web.html.
 * GIẢ ĐỊNH cho trường của `items[]` (hợp đồng chỉ nêu tên trường cấp trên): cần backend xác nhận khi làm route.
 * Chỗ này là nguồn duy nhất của kiểu; đổi hợp đồng thì sửa ở đây và ở `lib/feed-client.ts`.
 */
export type FeedFeedbackKind = "up" | "down";

export type FeedItem = {
  feedItemId: number;
  /** Vị trí trong bản chụp (1..K), khoá chống trùng lượt hiện. */
  position: number;
  eventId: number;
  title: string;
  /** Tóm tắt dùng chung; null khi chưa có thì hiện tiêu đề gốc. */
  summary: string | null;
  topic: { id: number; name: string } | null;
  source: { id: number; name: string };
  /** ISO. */
  occurredAt: string;
  score: number;
  /** Tin nằm trong điểm tin đã gửi Telegram (notifyPosition ≠ null). */
  inDigest: boolean;
  /** Sự kiện đã có thêm bài so với lần trước (nhãn "Cập nhật"). */
  isUpdate: boolean;
  feedback: FeedFeedbackKind | null;
};

export type FeedPage = {
  snapshotId: number;
  /** YYYY-MM-DD theo giờ Việt Nam. */
  date: string;
  total: number;
  items: FeedItem[];
  nextCursor: string | null;
};

export type FeedDates = { dates: { date: string; total: number }[] };

export type EventDetail = {
  eventId: number;
  title: string;
  summary: string | null;
  topic: { id: number; name: string } | null;
  articles: { title: string; url: string; source: string; publishedAt: string }[];
  /** Điểm thành phần của bản chụp, mỗi số 0..1. */
  components: { r: number; p: number; c: number; a: number; f: number; u: number };
  score: number;
  penalty: number;
};

export type ForMe = { text: string; cached: boolean };

export type ImpressionInput = { snapshotId: number; position: number; seenAt: string };

/** Lỗi gọi "Với tôi?" phân loại theo mã HTTP đã có ở backend: 429 hết hạn mức, 503 model chưa sẵn sàng. */
export class ForMeError extends Error {
  constructor(readonly kind: "limit" | "unavailable" | "other") {
    super(kind);
  }
}
