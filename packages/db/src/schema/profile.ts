/**
 * Hồ sơ người dùng: bối cảnh và các chủ đề quan tâm.
 *
 * KHÁC dữ liệu dẫn xuất: đây là dữ liệu của người dùng (họ đã chọn gì, đã viết gì), không tạo lại được, nên
 * `reprocess --all` không xoá các bảng này. Chỉ phần dẫn xuất (`topics.embedding`) được tính lại
 * khi đổi model embedding.
 *
 * Thuật ngữ thống nhất: "chủ đề" (topic). `topics` chứa mọi chủ đề (thư viện radard soạn sẵn và chủ
 * đề người dùng tự thêm) cùng embedding; `profile_topics` là lựa chọn của người dùng.
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
 * để viết câu "vì sao đáng chú ý với bạn". Không dùng để lọc: mức liên quan tính theo các chủ đề
 * đang bật trong `profile_topics` (từ 12/10/2026).
 */
export const profile = pgTable("profile", {
  id: integer("id").primaryKey().default(1),
  description: text("description").notNull(),
  displayLang: text("display_lang").notNull().default("vi"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

/**
 * Mọi chủ đề, mỗi chủ đề một dòng: chủ đề thư viện (radard soạn, `topics seed`) và chủ đề người dùng tự
 * thêm (`origin = custom`, thuộc một hồ sơ). Embedding nằm ở đây, nên mọi tài liệu được chấm với mọi
 * chủ đề, không phụ thuộc người dùng đang bật gì (D4). Người dùng chọn gì nằm ở `profile_topics`.
 */
export const topics = pgTable(
  "topics",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Khoá ổn định trong code (`agents`, `rag_search`…), chỉ chủ đề thư viện có. */
    key: text("key").unique(),
    /** Nhóm hiển thị trong thư viện; chủ đề tự thêm không có. */
    groupVi: text("group_vi"),
    /** Tên hiển thị: thư viện soạn sẵn, hoặc tên người dùng đặt. */
    labelVi: text("label_vi").notNull(),
    /** Câu dùng để embed: tiếng Anh, có ví dụ cụ thể (tự thêm: LLM viết từ lời người dùng). */
    descriptionEn: text("description_en").notNull(),
    /** Lời của người dùng, giữ nguyên ngôn ngữ họ viết; chỉ chủ đề tự thêm có. */
    descriptionUser: text("description_user"),
    /** library | custom */
    origin: text("origin").notNull().default("library"),
    /** Hồ sơ đã tự thêm chủ đề này; chủ đề thư viện thì trống. */
    ownerProfileId: integer("owner_profile_id").references(() => profile.id, {
      onDelete: "cascade",
    }),
    /** Thứ tự hiển thị trong thư viện. */
    position: integer("position").notNull().default(0),
    /** `false`: rút khỏi thư viện (không hiện để chọn); người đã chọn vẫn giữ. */
    active: boolean("active").notNull().default(true),
    /** Trống = chưa embed (vừa thêm, vừa sửa mô tả, hoặc đổi model): job process sẽ tính. */
    embedding: halfvec("embedding", { dimensions: EMBED_DIMENSIONS }),
    embeddingModel: text("embedding_model"),
  },
  (t) => [
    check("topics_origin_ck", sql`${t.origin} in ('library', 'custom')`),
    // Thư viện: có khoá, không thuộc hồ sơ nào. Tự thêm: không khoá, thuộc một hồ sơ, có lời người dùng.
    check(
      "topics_source_ck",
      sql`(${t.origin} = 'library') = (${t.key} is not null)
        and (${t.origin} = 'library') = (${t.ownerProfileId} is null)
        and (${t.origin} = 'library' or ${t.descriptionUser} is not null)`,
    ),
    uniqueIndex("topics_custom_label_uq")
      .on(t.ownerProfileId, sql`lower(${t.labelVi})`)
      .where(sql`${t.origin} = 'custom'`),
  ],
);

/**
 * Lựa chọn của người dùng: chủ đề nào (thư viện hoặc tự thêm, đều nằm ở `topics`), đang bật hay tắt,
 * quan tâm hay không quan tâm. Chỉ chủ đề đang bật, `kind = include` mới tính vào mức liên quan R.
 */
export const profileTopics = pgTable(
  "profile_topics",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    profileId: integer("profile_id")
      .notNull()
      .default(1)
      .references(() => profile.id, { onDelete: "cascade" }),
    topicId: bigint("topic_id", { mode: "number" })
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    /**
     * include | exclude. `exclude` = "không quan tâm": tuần 3 chỉ lưu, chưa dùng khi chấm điểm
     * (quyết định D3, 12/10/2026).
     */
    kind: text("kind").notNull().default("include"),
    /** Tắt thì không tính vào R, nhưng không xoá: bật lại được ngay. */
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Mỗi chủ đề chỉ được chọn một lần; chọn lại là bật lại dòng cũ.
    uniqueIndex("profile_topics_topic_uq").on(t.profileId, t.topicId),
    check("profile_topics_kind_ck", sql`${t.kind} in ('include', 'exclude')`),
  ],
);
