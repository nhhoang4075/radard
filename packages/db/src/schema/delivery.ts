/**
 * Gửi tin và phản hồi của người dùng.
 *
 * KHÁC dữ liệu dẫn xuất: đây là dữ liệu KHÔNG tạo lại được (bạn đã nhận gì, đã bấm gì, đã viết gì), nên
 * không bảng nào ở đây trỏ khoá ngoại vào `events`. `events` là dẫn xuất: `events rebuild`
 * hay `reset` xoá sạch rồi dựng lại với id mới. Thay vào đó mỗi tin đã gửi chụp lại danh sách
 * `documents.id` (dữ liệu thu thập, id không bao giờ đổi) của sự kiện lúc gửi; `event_id` chỉ để tra cứu
 * nhanh khi sự kiện chưa bị dựng lại.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { feedItems, feedSnapshots } from "./feed.ts";
import { jsonb } from "./json.ts";
import { profile } from "./profile.ts";

/**
 * Cột `profile_id`: hồ sơ (người dùng) sở hữu dòng này. Người nhận theo kênh (`recipient`) vẫn giữ
 * nguyên để gửi và nối lượt bấm; `profile_id` là chiều để lọc dữ liệu theo người dùng (xếp hạng,
 * bộ chấm). Giá trị lấy từ `profile_channels` (người nhận → hồ sơ).
 */
const profileIdColumn = () =>
  integer("profile_id")
    .notNull()
    .references(() => profile.id);

/** Một lượt digest (ví dụ bản 07:00 ngày 12/10) gửi tới một người nhận. */
export const digests = pgTable(
  "digests",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    profileId: profileIdColumn(),
    /** `telegram` · `discord` · `webpush`… */
    channel: text("channel").notNull(),
    /** Định danh người nhận theo kênh (Telegram: chat id). */
    recipient: text("recipient").notNull(),
    /** Khoảng thời gian digest bao phủ. */
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    /** sending | sent | failed */
    status: text("status").notNull().default("sending"),
    /** Ngôn ngữ hiển thị của phần tóm tắt (dữ liệu gốc vẫn tiếng Anh). */
    lang: text("lang").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    error: text("error"),
    /**
     * `plan`: danh sách tin đã chọn và đúng nội dung sẽ gửi, lưu TRƯỚC khi gửi tin đầu tiên.
     * Chạy lại thì đọc plan và gửi tiếp vị trí còn thiếu, không chọn lại (điểm HN đã đổi thì
     * chọn lại có thể ra danh sách khác). Kèm điểm, cấu hình, mặt bằng để giải thích vì sao chọn.
     */
    meta: jsonb<Record<string, unknown>>("meta").notNull().default(sql`'{}'::jsonb`),
    /** Bản chụp feed mà bản thông báo này lấy tin; NULL ở digest trước khi có feed (11/2026). */
    feedSnapshotId: bigint("feed_snapshot_id", { mode: "number" }),
  },
  (t) => [
    // Khoá ngoại ghép (bản chụp, hồ sơ): digest của hồ sơ A không thể trỏ vào bản chụp của hồ sơ B.
    foreignKey({
      name: "digests_feed_snapshot_fk",
      columns: [t.feedSnapshotId, t.profileId],
      foreignColumns: [feedSnapshots.id, feedSnapshots.profileId],
    }),
    // Một người nhận của một hồ sơ chỉ nhận một digest cho mỗi khoảng: job chạy lại không gửi trùng.
    uniqueIndex("digests_once_uq").on(t.profileId, t.channel, t.recipient, t.periodEnd),
    index("digests_profile_idx").on(t.profileId, t.periodEnd),
    check("digests_status_ck", sql`${t.status} in ('sending', 'sent', 'failed')`),
  ],
);

/**
 * Mỗi tin đã gửi một dòng: tin mở đầu của digest, tin của một sự kiện, hoặc tin thử (`notify test`).
 * Phân tích phản hồi chỉ lấy `kind = 'event'`; ràng buộc bên dưới bảo đảm dòng đó luôn thuộc một
 * digest và một sự kiện, nên tin thử không bao giờ lẫn vào.
 */
export const deliveries = pgTable(
  "deliveries",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    profileId: profileIdColumn(),
    digestId: bigint("digest_id", { mode: "number" }).references(() => digests.id, {
      onDelete: "cascade",
    }),
    channel: text("channel").notNull(),
    recipient: text("recipient").notNull(),
    /** Id tin phía kênh (Telegram: message_id). Reply và bấm nút được nối về đây. */
    messageId: text("message_id").notNull(),
    /** header (tin mở đầu) | event (tin của một sự kiện) | test (tin thử, ngoài digest) */
    kind: text("kind").notNull(),
    /** Vị trí trong digest (1…7), để hiển thị và đo "tin đầu được bấm nhiều hơn không". */
    position: bigint("position", { mode: "number" }),
    /** Tham khảo, KHÔNG có khoá ngoại: sẽ sai sau khi dựng lại sự kiện. */
    eventId: bigint("event_id", { mode: "number" }),
    /** Ảnh chụp các `documents.id` của sự kiện lúc gửi: mối nối bền với dữ liệu gốc. */
    documentIds: bigint("document_ids", { mode: "number" }).array().notNull().default(sql`'{}'`),
    /** Đúng nội dung đã gửi (tiêu đề, tóm tắt, link): bạn đã đọc gì thì giữ đúng như vậy. */
    title: text("title"),
    body: text("body").notNull(),
    meta: jsonb<Record<string, unknown>>("meta").notNull().default(sql`'{}'::jsonb`),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    /** Tin feed tương ứng (tin sự kiện gửi từ bản chụp); NULL với tin mở đầu, tin thử, tin cũ. */
    feedItemId: bigint("feed_item_id", { mode: "number" }),
  },
  (t) => [
    // Khoá ngoại ghép (tin feed, hồ sơ): tin gửi cho hồ sơ A không thể trỏ vào tin feed của hồ sơ B.
    foreignKey({
      name: "deliveries_feed_item_fk",
      columns: [t.feedItemId, t.profileId],
      foreignColumns: [feedItems.id, feedItems.profileId],
    }),
    uniqueIndex("deliveries_message_uq").on(t.channel, t.recipient, t.messageId),
    index("deliveries_digest_idx").on(t.digestId),
    // Truy vấn "đã gửi" của xếp hạng: theo hồ sơ, loại tin, mốc gửi.
    index("deliveries_profile_idx").on(t.profileId, t.kind, t.sentAt),
    // Mỗi vị trí của một digest gửi đúng một lần (tin thử ngoài digest có digest_id trống).
    uniqueIndex("deliveries_digest_position_uq").on(t.digestId, t.position),
    check("deliveries_kind_ck", sql`${t.kind} in ('header', 'event', 'test')`),
    // Chỉ tin thử đứng ngoài digest; chỉ tin sự kiện có event_id; tin trong digest luôn có vị trí.
    check(
      "deliveries_shape_ck",
      sql`(${t.kind} = 'test') = (${t.digestId} is null)
        and (${t.kind} = 'event') = (${t.eventId} is not null)
        and (${t.digestId} is null) = (${t.position} is null)`,
    ),
  ],
);

/**
 * Phản hồi của người dùng: bấm nút hoặc viết. Chỉ ghi thêm; bấm 👍 rồi đổi ý bấm 👎 là hai
 * dòng, dòng mới nhất là ý kiến hiện tại. Bỏ chọn là dòng `clear` (không xoá dòng nào).
 */
export const feedback = pgTable(
  "feedback",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    profileId: profileIdColumn(),
    /** Tin được phản hồi. Trống = góp ý chung, không gắn sự kiện nào (nhắn tin thường). */
    deliveryId: bigint("delivery_id", { mode: "number" }).references(() => deliveries.id, {
      onDelete: "set null",
    }),
    channel: text("channel").notNull(),
    recipient: text("recipient").notNull(),
    /** like | dislike | clear | comment. `clear` = bỏ chọn (bấm lại đúng nút đang chọn). */
    kind: text("kind").notNull(),
    /** Nội dung nhận xét, giữ nguyên ngôn ngữ người dùng viết. Trống với like/dislike/clear. */
    text: text("text"),
    /** Id tin của người dùng phía kênh (với nhận xét), để không ghi trùng khi nhận lại update. */
    sourceMessageId: text("source_message_id"),
    meta: jsonb<Record<string, unknown>>("meta").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Tin feed được phản hồi: phản hồi từ web luôn có; phản hồi Telegram có khi tin gửi từ bản chụp
     * (`deliveries.feed_item_id`). NULL với phản hồi cũ và góp ý chung.
     */
    feedItemId: bigint("feed_item_id", { mode: "number" }),
  },
  (t) => [
    // Khoá ngoại ghép như deliveries: phản hồi của hồ sơ A không thể trỏ vào tin feed của hồ sơ B.
    foreignKey({
      name: "feedback_feed_item_fk",
      columns: [t.feedItemId, t.profileId],
      foreignColumns: [feedItems.id, feedItems.profileId],
    }),
    index("feedback_feed_item_idx").on(t.feedItemId),
    index("feedback_delivery_idx").on(t.deliveryId),
    index("feedback_created_idx").on(t.createdAt),
    index("feedback_profile_idx").on(t.profileId, t.createdAt),
    uniqueIndex("feedback_source_message_uq").on(t.channel, t.recipient, t.sourceMessageId),
    check("feedback_kind_ck", sql`${t.kind} in ('like', 'dislike', 'clear', 'comment')`),
    check(
      "feedback_text_ck",
      sql`(${t.kind} = 'comment') = (${t.text} is not null and length(${t.text}) > 0)`,
    ),
  ],
);
