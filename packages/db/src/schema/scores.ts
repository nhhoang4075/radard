/**
 * Điểm và mặt bằng dùng để xếp hạng digest (xep-hang.html).
 *
 * Dẫn xuất, tính lại được: điểm chủ đề là cosine trên vector đã có (SQL, không gọi model), tín
 * hiệu lấy lại từ API của nguồn, mặt bằng tính lại mỗi ngày. Nằm riêng khỏi `derived.ts` vì
 * phụ thuộc hồ sơ người dùng.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { documents, sources } from "./collected.ts";
import { profileTopics } from "./profile.ts";

/** Cosine giữa mỗi tài liệu và mỗi chủ đề đang bật của người dùng. Tính một lần sau khi embed. */
export const docTopicScores = pgTable(
  "doc_topic_scores",
  {
    documentId: bigint("document_id", { mode: "number" })
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    profileTopicId: bigint("profile_topic_id", { mode: "number" })
      .notNull()
      .references(() => profileTopics.id, { onDelete: "cascade" }),
    score: real("score").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.profileTopicId] }),
    index("doc_topic_scores_topic_idx").on(t.profileTopicId),
  ],
);

/**
 * Tín hiệu cộng đồng mới nhất của tài liệu (điểm, bình luận HN…), lấy lại từ API của nguồn
 * ngay trước khi xếp hạng. Số lưu lúc lấy bài thì vô dụng: bài HN mới đăng gần như luôn 1 điểm
 * (trung bình 1,6, đo 11/10/2026). Chỉ giữ giá trị mới nhất.
 */
export const docSignals = pgTable(
  "doc_signals",
  {
    documentId: bigint("document_id", { mode: "number" })
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** `hn_points`, `hn_comments`… adapter nguồn tự đặt tên. */
    metric: text("metric").notNull(),
    value: real("value").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.metric] })],
);

/**
 * Mặt bằng để chuẩn hoá: trung vị và mốc 0,1% cao nhất trên 30 ngày (xep-hang.html tab 03).
 * Chỉ giữ bản mới nhất cho mỗi khoá; digest chép lại bản đã dùng vào `digests.meta`.
 *
 *   metric = relevance   source × chủ đề (source trống = mặt bằng chung của chủ đề)
 *   metric = engagement  theo nguồn, chủ đề trống
 *   metric = coverage    của sự kiện, cả nguồn lẫn chủ đề trống
 */
export const baselines = pgTable(
  "baselines",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    metric: text("metric").notNull(),
    sourceId: integer("source_id").references(() => sources.id, { onDelete: "cascade" }),
    profileTopicId: bigint("profile_topic_id", { mode: "number" }).references(
      () => profileTopics.id,
      { onDelete: "cascade" },
    ),
    median: real("median").notNull(),
    p999: real("p999").notNull(),
    /** Số mẫu: quyết định phần mặt bằng riêng w = n / (n + 1000) khi trộn với mặt bằng chung. */
    n: integer("n").notNull(),
    windowDays: integer("window_days").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("baselines_key_uq").on(
      t.metric,
      sql`coalesce(${t.sourceId}, 0)`,
      sql`coalesce(${t.profileTopicId}, 0)`,
    ),
  ],
);
