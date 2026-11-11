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
import { user } from "./auth.ts";
import { EMBED_DIMENSIONS } from "./derived.ts";

/**
 * Một người dùng ở MVP-0 (id = 1).
 *
 * `promptContext` là BỐI CẢNH của người dùng bằng tiếng Anh (nghề, stack, đang làm gì), dùng trong
 * prompt digest để viết câu "vì sao đáng chú ý với bạn". Không dùng để lọc: mức liên quan tính theo
 * các chủ đề đang bật trong `profile_topics` (từ 12/10/2026). `description` là lời người dùng tự viết
 * về mình, giữ nguyên ngôn ngữ họ viết (trống cho tới khi họ viết).
 */
export const profile = pgTable("profile", {
  id: integer("id").primaryKey().default(1),
  promptContext: text("prompt_context").notNull(),
  /** Lời người dùng tự viết về mình; không dùng trong prompt. */
  description: text("description"),
  displayLang: text("display_lang").notNull().default("vi"),
  /**
   * Tài khoản đăng nhập web của hồ sơ (`user.id`). Duy nhất: một user một hồ sơ. Trống cho tới khi
   * người đó đăng nhập lần đầu (hồ sơ 1 của chủ dự án được nối qua `OWNER_EMAIL`).
   */
  userId: text("user_id")
    .unique()
    .references(() => user.id, { onDelete: "set null" }),
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
    /** Khoá ổn định trong code (`agents`, `llm_apps`…), chỉ chủ đề thư viện có. */
    key: text("key").unique(),
    /** Nhóm hiển thị trong thư viện; chủ đề tự thêm không có. */
    groupName: text("group_name"),
    /** Tên hiển thị: thư viện soạn sẵn, hoặc tên người dùng đặt. */
    name: text("name").notNull(),
    /** Câu dùng để embed: tiếng Anh, có ví dụ cụ thể (tự thêm: LLM viết từ lời người dùng). */
    embedText: text("embed_text").notNull(),
    /**
     * Phạm vi chủ đề bằng tiếng Anh (gồm gì, không gồm gì, tin lấn sang thì thuộc chủ đề nào), chỉ
     * đưa cho LLM khi gắn nhãn tin trong điểm tin; không embed. Thư viện lấy từ code; chủ đề tự
     * thêm thì trống (LLM chỉ thấy tên).
     */
    labelGuide: text("label_guide"),
    /** Lời của người dùng, giữ nguyên ngôn ngữ họ viết; chỉ chủ đề tự thêm có. */
    description: text("description"),
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
    /** Cách tạo vector (chỉ dẫn nhiệm vụ…); khác giá trị hiện hành thì job process embed lại. */
    embeddingRecipe: text("embedding_recipe"),
  },
  (t) => [
    check("topics_origin_ck", sql`${t.origin} in ('library', 'custom')`),
    // Thư viện: có khoá, không thuộc hồ sơ nào. Tự thêm: không khoá, thuộc một hồ sơ, có lời người dùng.
    check(
      "topics_source_ck",
      sql`(${t.origin} = 'library') = (${t.key} is not null)
        and (${t.origin} = 'library') = (${t.ownerProfileId} is null)
        and (${t.origin} = 'library' or ${t.description} is not null)`,
    ),
    uniqueIndex("topics_custom_label_uq")
      .on(t.ownerProfileId, sql`lower(${t.name})`)
      .where(sql`${t.origin} = 'custom'`),
  ],
);

/**
 * Tin giả định của chủ đề (HyDE): vài tin ngắn LLM viết như tin thật của chủ đề, embed như một tài
 * liệu. Điểm R của một tin với chủ đề là cosine lớn nhất trong vector mô tả và các vector này
 * (`scoreTopics`). Dẫn xuất từ `topics.embed_text`: mô tả đổi thì xoá đi sinh lại.
 */
export const topicExamples = pgTable(
  "topic_examples",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    topicId: integer("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    embedding: halfvec("embedding", { dimensions: EMBED_DIMENSIONS }).notNull(),
    embeddingModel: text("embedding_model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("topic_examples_topic_pos_uq").on(t.topicId, t.position)],
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
