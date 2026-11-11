/**
 * Interface thông báo. Lõi (job digest) chỉ biết các kiểu này; Telegram, Discord, Web Push là
 * adapter. Tin lưu và truyền ở dạng TRUNG LẬP: văn bản thuần, không HTML hay markdown riêng của
 * kênh nào; mỗi adapter tự render (radard-thiet-ke.html, quy tắc 2).
 */

/** Phản hồi bằng nút. Khớp `feedback.kind`; `comment` (nhận xét bằng chữ) để sau. */
export type FeedbackKind = "like" | "dislike";

/** Ý kiến hiện tại của một tin sau lượt bấm: `none` = chưa chọn hoặc đã bỏ chọn. */
export type FeedbackState = FeedbackKind | "none";

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
  /** `for_me`: nút "Với tôi?" (không phải phản hồi, không ghi `feedback`). */
  actions?: { id: FeedbackKind | "for_me"; label: string }[];
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

/** Một lượt bấm "Với tôi?" trên một tin. */
export interface ForMeEvent {
  channel: string;
  recipient: string;
  /** Tin được bấm: nối về `deliveries` qua (channel, recipient, message_id). */
  messageId: string;
}

/** Kết quả "Với tôi?"; `status` khác `ok` thì kênh báo lỗi tương ứng, không có `text`. */
export type ForMeResult =
  | { status: "ok"; text: string }
  | { status: "not_found" | "limit" | "unavailable" };

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

/** Mô tả về người dùng, như lệnh /profile hiện ra. */
export interface ProfileView {
  /** Lời người dùng tự viết về mình (giữ nguyên ngôn ngữ); `null`: chưa viết. */
  description: string | null;
  /** Bối cảnh tiếng Anh radard đang dùng; chuỗi rỗng: chưa có. */
  promptContext: string;
}

/** Một chủ đề thư viện hiện trong tin gợi ý, kèm trạng thái tích ban đầu. */
export interface SuggestedTopic {
  /** Cùng dạng khoá với `TopicItem` (`l:<topics.id>`). */
  key: string;
  label: string;
  /**
   * preselect: nên theo dõi · maybe: có thể bạn quan tâm · followed: không được gợi ý nhưng người
   * dùng đang theo dõi (vẫn hiện, để tin gợi ý cho thấy đủ mọi chủ đề thư viện đang bật).
   */
  tier: "preselect" | "maybe" | "followed";
  /** Tích sẵn: mức "nên theo dõi", hoặc người dùng đang bật chủ đề này. */
  checked: boolean;
}

/** Chủ đề mới (chưa có trong thư viện) mà radard đề xuất. */
export interface ProposedTopicItem {
  label: string;
  /** Vì sao đề xuất, một câu tiếng Việt (hiện cho người dùng). */
  why: string;
  /** Câu tiếng Anh để embed. */
  embedText: string;
}

export interface ProfileSuggestions {
  /** Nên theo dõi, rồi có thể bạn quan tâm (mỗi mức cao trước), rồi đang theo dõi. */
  topics: SuggestedTopic[];
  newTopics: ProposedTopicItem[];
}

/** Lệnh /profile: mô tả về người dùng và gợi ý chủ đề. */
export interface ProfileHandlers {
  get(): Promise<ProfileView>;
  /**
   * Lưu lời người dùng, rồi nhờ LLM viết lại bối cảnh tiếng Anh. `rewritten = false`: không viết
   * được (thiếu LLM hay lời gọi lỗi), lời người dùng vẫn được lưu, bối cảnh cũ giữ nguyên.
   */
  saveDescription(text: string): Promise<{ rewritten: boolean }>;
  /** Gợi ý theo bối cảnh đang lưu. `null`: tạm không gợi ý được. */
  suggest(): Promise<ProfileSuggestions | null>;
  /**
   * Lưu tin gợi ý: tạo (và bật) các chủ đề mới `add`, bật các chủ đề `on`, tắt các chủ đề `off`
   * (khoá `l:<id>`). Trả về số chủ đề đang theo dõi, kể cả chủ đề vừa tạo.
   */
  apply(on: string[], off: string[], add: ProposedTopicItem[]): Promise<number>;
}

export interface ChatHandlers {
  /**
   * Ghi phản hồi. `recorded = false`: đã ghi từ trước (lượt bấm bị giao lại). `state` = ý kiến
   * hiện tại của tin sau lượt bấm (bấm lại đúng nút đang chọn thì là `none`); bỏ trống thì kênh
   * coi là nút vừa bấm.
   */
  onFeedback(ev: FeedbackEvent): Promise<{ recorded: boolean; state?: FeedbackState }>;
  /**
   * Nút "Với tôi?": tin được bấm tra về hồ sơ của người bấm ở phía lõi (fail-closed). Không có thì
   * kênh coi nút là nút lạ.
   */
  onForMe?(ev: ForMeEvent): Promise<ForMeResult>;
  /** Không có thì kênh không nhận lệnh chọn chủ đề. */
  topics?: TopicHandlers;
  /** Không có thì kênh không nhận lệnh /profile. */
  profile?: ProfileHandlers;
}

/**
 * Đa người dùng: tra người nhận (chat id) → bộ xử lý của đúng hồ sơ đó. `null` = người nhận không có
 * quyền: kênh bỏ qua update, không trả lời, không gọi bất kỳ handler nào (fail-closed).
 * `scope` định danh hồ sơ đứng sau bộ xử lý (kênh dùng nó để biết khi nào phải dựng lại bộ xử lý).
 */
export type ChatResolver = (
  recipient: string,
) => Promise<{ scope: string; handlers: ChatHandlers } | null>;

/** Chiều về: nhận lượt bấm (sau này: lệnh, tin nhắn) từ một kênh. */
export interface ChatChannel {
  readonly channel: string;
  /** Bắt đầu nhận; trả về ngay, việc nhận chạy nền cho tới `stop()`. */
  start(handlers: ChatHandlers | ChatResolver): Promise<void>;
  stop(): Promise<void>;
}
