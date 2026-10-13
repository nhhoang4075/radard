/**
 * Hồ sơ người dùng: bối cảnh và các chủ đề quan tâm.
 *
 * KHÁC dữ liệu dẫn xuất: đây là dữ liệu của người dùng (họ đã chọn gì, đã viết gì), không tạo lại được, nên
 * `reprocess --all` không xoá các bảng này. Chỉ phần dẫn xuất (embedding của chủ đề) được tính lại
 * khi đổi model embedding.
 *
 * Thuật ngữ thống nhất: "chủ đề" (topic). `topics` là thư viện chủ đề radard soạn sẵn;
 * `profile_topics` là chủ đề của một người dùng, chọn từ thư viện hoặc tự thêm.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  halfvec,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { EMBED_DIMENSIONS } from "./derived.ts";

/**
 * Một người dùng ở MVP-0 (id = 1).
 *
 * `description` là BỐI CẢNH của người dùng (nghề, stack, đang làm gì), dùng trong prompt digest
 * để viết câu "vì sao đáng chú ý với bạn". Không dùng để lọc: mức liên quan tính theo
 * `profile_topics` (từ 12/10/2026).
 */
export const profile = pgTable("profile", {
  id: integer("id").primaryKey().default(1),
  description: text("description").notNull(),
  displayLang: text("display_lang").notNull().default("vi"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

/** Thư viện chủ đề: radard soạn và thử trên dữ liệu thật (`topics seed`), người dùng bấm chọn. */
export const topics = pgTable("topics", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  /** Khoá ổn định trong code (`agents`, `rag_search`…): sửa câu mô tả không đổi khoá. */
  key: text("key").notNull().unique(),
  groupVi: text("group_vi").notNull(),
  labelVi: text("label_vi").notNull(),
  /** Câu dùng để embed: tiếng Anh, có ví dụ cụ thể. Người dùng không cần thấy. */
  descriptionEn: text("description_en").notNull(),
  /** Thứ tự hiển thị trong thư viện. */
  position: integer("position").notNull().default(0),
  /** `false`: rút khỏi thư viện (không hiện để chọn); người đã chọn vẫn giữ. */
  active: boolean("active").notNull().default(true),
});

/** Chủ đề của người dùng: chọn từ thư viện (`library`) hoặc tự thêm (`custom`). */
export const profileTopics = pgTable(
  "profile_topics",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    profileId: integer("profile_id")
      .notNull()
      .default(1)
      .references(() => profile.id, { onDelete: "cascade" }),
    /** Chủ đề gốc trong thư viện; trống nếu tự thêm. */
    topicId: bigint("topic_id", { mode: "number" }).references(() => topics.id),
    /** Tên hiển thị (thư viện: `label_vi`; tự thêm: tên người dùng đặt). */
    label: text("label").notNull(),
    /** Lời của người dùng, giữ nguyên ngôn ngữ họ viết; trống nếu chọn từ thư viện. */
    descriptionUser: text("description_user"),
    /** Câu dùng để embed: chép từ thư viện, hoặc LLM viết từ lời người dùng. */
    descriptionEn: text("description_en").notNull(),
    /** library | custom */
    origin: text("origin").notNull(),
    /**
     * include | exclude. `exclude` = "không quan tâm": tuần 3 chỉ lưu, chưa dùng khi chấm điểm
     * (quyết định D3, 12/10/2026).
     */
    kind: text("kind").notNull().default("include"),
    /** Trống = chưa embed (vừa thêm, vừa sửa mô tả, hoặc đổi model): job process sẽ tính. */
    embedding: halfvec("embedding", { dimensions: EMBED_DIMENSIONS }),
    embeddingModel: text("embedding_model"),
    /** Tắt thì không dùng để chấm, nhưng không xoá: bật lại được ngay. */
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Mỗi chủ đề thư viện chỉ được chọn một lần; chọn lại là bật lại dòng cũ.
    uniqueIndex("profile_topics_library_uq")
      .on(t.profileId, t.topicId)
      .where(sql`${t.topicId} is not null`),
    uniqueIndex("profile_topics_label_uq").on(t.profileId, sql`lower(${t.label})`),
    check("profile_topics_origin_ck", sql`${t.origin} in ('library', 'custom')`),
    check("profile_topics_kind_ck", sql`${t.kind} in ('include', 'exclude')`),
    // Chọn từ thư viện thì phải trỏ về thư viện; tự thêm thì phải có lời của người dùng.
    check(
      "profile_topics_source_ck",
      sql`(${t.origin} = 'library') = (${t.topicId} is not null) and (${t.origin} = 'library' or ${t.descriptionUser} is not null)`,
    ),
  ],
);
