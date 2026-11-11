/**
 * Tóm tắt dùng chung và câu "Với tôi?" (quyết định 11/11/2026, mo-hinh-de-xuat.html: "tóm tắt dùng
 * chung, 'với bạn' tách thành nút bấm").
 *
 * - `event_summaries`: tóm tắt CHUNG của một sự kiện ("chuyện gì xảy ra và bối cảnh"), không có
 *   `profile_id`: mọi hồ sơ cùng sự kiện, cùng ngôn ngữ dùng chung một dòng. `docs_hash` là băm
 *   (đã sắp xếp) danh sách id tài liệu đã đưa vào prompt, nên sự kiện có thêm bài thì ra dòng mới
 *   (tính lại), dòng cũ giữ nguyên cho tin đã chụp (`feed_items.summary_id`).
 * - `event_for_profile`: câu "Với tôi?" của MỘT hồ sơ cho một sự kiện, cache theo (hồ sơ, sự kiện,
 *   ngôn ngữ, `context_hash`). `context_hash` băm bối cảnh hồ sơ (mô tả, bối cảnh, chủ đề đang bật),
 *   KHÔNG gồm tin đã thích, để cache ổn định.
 *
 * Như `feed_items`, `event_id` chỉ để tham khảo, không có khoá ngoại vào `events` (dẫn xuất,
 * `events rebuild` đổi id).
 */
import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { profile } from "./profile.ts";

export const eventSummaries = pgTable(
  "event_summaries",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    eventId: bigint("event_id", { mode: "number" }).notNull(),
    lang: text("lang").notNull(),
    /** sha256 của danh sách id tài liệu đã đưa vào prompt (sắp xếp tăng dần, nối bằng dấu phẩy). */
    docsHash: text("docs_hash").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [unique("event_summaries_uq").on(t.eventId, t.lang, t.docsHash)],
);

export const eventForProfile = pgTable(
  "event_for_profile",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profile.id, { onDelete: "cascade" }),
    eventId: bigint("event_id", { mode: "number" }).notNull(),
    lang: text("lang").notNull(),
    /** sha256 của (mô tả + bối cảnh + id các chủ đề đang bật); đổi hồ sơ thì tính lại. */
    contextHash: text("context_hash").notNull(),
    text: text("text").notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    unique("event_for_profile_uq").on(t.profileId, t.eventId, t.lang, t.contextHash),
    // Đếm hạn mức mỗi ngày: số câu hồ sơ này đã nhờ model viết từ một mốc.
    index("event_for_profile_quota_idx").on(t.profileId, t.createdAt),
  ],
);
