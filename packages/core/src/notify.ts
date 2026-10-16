/**
 * Interface thông báo. Lõi (job digest) chỉ biết các kiểu này; Telegram, Discord, Web Push là
 * adapter. Tin lưu và truyền ở dạng TRUNG LẬP: văn bản thuần, không HTML hay markdown riêng của
 * kênh nào; mỗi adapter tự render (radard-thiet-ke.html, quy tắc 2).
 */

/** Phản hồi bằng nút. Khớp `feedback.kind`; `comment` (nhận xét bằng chữ) để sau. */
export type FeedbackKind = "like" | "dislike";

/** Một link của tin. Job quyết định có link nào, nhãn gì; adapter chỉ quyết cách trình bày. */
export interface Link {
  url: string;
  /** Chữ hiện ra, ví dụ tên miền "openai.com". Link thật vẫn là `url` đầy đủ. */
  label: string;
  /**
   * main: bài nên đọc nhất · related: bài viết khác về cùng chuyện · discussion: trang thảo luận
   * (bình luận HN…).
   */
  role: "main" | "related" | "discussion";
}

export interface Message {
  kind: "digest" | "system";
  title: string;
  /** Mỗi phần tử một đoạn, văn bản thuần. */
  lines: string[];
  /** Mọi link của tin; tin không có trường link nào khác. */
  links?: Link[];
  /** Số bài liên quan KHÔNG có trong `links` (hiện "+N bài"). */
  moreRelated?: number;
  actions?: { id: FeedbackKind; label: string }[];
}

export interface Notifier {
  readonly channel: string;
  /** Gửi một tin; trả về id tin phía kênh, job ghi vào `deliveries.message_id`. */
  send(recipient: string, msg: Message): Promise<{ messageId: string }>;
}

/** Một lượt bấm nút, đã quy về dạng trung lập. */
export interface FeedbackEvent {
  channel: string;
  recipient: string;
  /** Tin được bấm: nối về `deliveries` qua (channel, recipient, message_id). */
  messageId: string;
  kind: FeedbackKind;
  /**
   * Id của CHÍNH lượt bấm phía kênh (Telegram: `callback_query.id`). Kênh giao lại cùng lượt bấm
   * (bot khởi động lại trước khi kịp xác nhận) thì id trùng, nên không ghi hai lần.
   */
  sourceId: string;
}

/** Một chủ đề hiện trong danh sách chọn: từ thư viện hoặc do người dùng tự thêm. */
export interface TopicItem {
  /** Khoá ổn định để bật tắt: `l:<topics.id>` (thư viện) hoặc `c:<profile_topics.id>` (tự thêm). */
  key: string;
  label: string;
  chosen: boolean;
}

export interface CustomTopicDraft {
  label: string;
  /** Lời của người dùng, giữ nguyên ngôn ngữ họ viết. */
  description: string;
  /** Câu tiếng Anh để embed, do LLM viết từ lời người dùng. */
  embedText: string;
}

/** Lệnh về chủ đề mà kênh chat chuyển vào lõi (bước 5, tuần 3). */
export interface TopicHandlers {
  list(): Promise<TopicItem[]>;
  /** Bật/tắt; trả về trạng thái mới. */
  toggle(key: string): Promise<boolean>;
  /** Viết câu mô tả tiếng Anh (một lời gọi LLM). Chưa lưu gì. */
  describe(label: string, text: string): Promise<string>;
  /** Lưu chủ đề tự thêm (đang bật). */
  addCustom(draft: CustomTopicDraft): Promise<void>;
}

export interface ChatHandlers {
  /** Ghi phản hồi. `recorded = false`: đã ghi từ trước (lượt bấm bị giao lại). */
  onFeedback(ev: FeedbackEvent): Promise<{ recorded: boolean }>;
  /** Không có thì kênh không nhận lệnh chọn chủ đề. */
  topics?: TopicHandlers;
}

/** Chiều về: nhận lượt bấm (sau này: lệnh, tin nhắn) từ một kênh. */
export interface ChatChannel {
  readonly channel: string;
  /** Bắt đầu nhận; trả về ngay, việc nhận chạy nền cho tới `stop()`. */
  start(handlers: ChatHandlers): Promise<void>;
  stop(): Promise<void>;
}
