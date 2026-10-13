/**
 * Dữ liệu dẫn xuất (MVP-0): văn bản đã chuẩn hoá, embedding, sự kiện.
 *
 * Mọi thứ ở đây DẪN XUẤT từ dữ liệu thu thập (collected.ts): xoá đi và chạy lại được. Mỗi dòng
 * ghi model embedding đã tạo ra nó, để khi đổi model biết phải tính lại những gì.
 *
 * Ở đây không có gì phụ thuộc hồ sơ người dùng (quyết định D4, 12/10/2026): mọi tài liệu được
 * embed và gộp thành sự kiện. Điểm theo chủ đề của người dùng nằm ở `scores.ts`.
 */
import {
  bigint,
  halfvec,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { documents } from "./collected.ts";

/**
 * Số chiều của `alibaba/qwen3-embedding-0.6b`. CHƯA kiểm chứng qua Gateway (cần khoá API):
 * adapter từ chối vector khác số chiều, nên sai thì hỏng sớm ở lần gọi đầu, không hỏng dữ liệu.
 */
export const EMBED_DIMENSIONS = 1024;

export const docText = pgTable("doc_text", {
  documentId: bigint("document_id", { mode: "number" })
    .primaryKey()
    .references(() => documents.id, { onDelete: "cascade" }),
  /** Văn bản đầy đủ (gồm phần chữ của trang nếu có), ngôn ngữ gốc, đã NFC. Digest trích từ đây. */
  text: text("text").notNull(),
  /** Mã ISO 639-3 do franc đoán (`eng`, `vie`…); `und` khi quá ngắn để đoán. */
  lang: text("lang").notNull(),
  /**
   * Vector của bản thô của nguồn (tiêu đề, abstract, ghi chú phát hành): dùng để GỘP sự kiện.
   * Ngưỡng gộp 0,9 được chỉnh trên vector này; vector có nội dung trang thì hai bài cùng chuyện ở
   * hai trang khác nhau chỉ còn cosine 0,6–0,88 (đo 13/10/2026 trên 292 cặp), gộp hỏng.
   */
  embedding: halfvec("embedding", { dimensions: EMBED_DIMENSIONS }).notNull(),
  /**
   * Vector của bản thô CỘNG phần chữ chính của trang được link tới (job `pages`): dùng để CHẤM
   * chủ đề. Trống khi không có trang (arXiv, Ask HN, trang chặn bot): chấm bằng `embedding`.
   */
  contentEmbedding: halfvec("content_embedding", { dimensions: EMBED_DIMENSIONS }),
  embeddingModel: text("embedding_model").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable(
  "events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Tạm lấy tiêu đề tài liệu đầu tiên; MVP-1 sẽ viết lại bằng LLM, bằng tiếng Anh. */
    title: text("title").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    /** Số tài liệu thuộc sự kiện, kể cả gộp vì cùng URL: đo mức được nhắc tới, để xếp hạng. */
    nDocs: integer("n_docs").notNull().default(1),
    /**
     * Số vector đã góp vào `centroid` (seed + gộp theo vector), là trọng số cho `runningMean`.
     * Khác `nDocs`: gộp vì cùng URL thêm tài liệu nhưng không đổi tâm.
     */
    nVectors: integer("n_vectors").notNull().default(1),
    centroid: halfvec("centroid", { dimensions: EMBED_DIMENSIONS }).notNull(),
    embeddingModel: text("embedding_model").notNull(),
  },
  (t) => [
    index("events_last_seen_idx").on(t.lastSeenAt),
    index("events_centroid_hnsw").using("hnsw", t.centroid.op("halfvec_cosine_ops")),
  ],
);

export const eventDocuments = pgTable(
  "event_documents",
  {
    eventId: bigint("event_id", { mode: "number" })
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    documentId: bigint("document_id", { mode: "number" })
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** Cosine tới tâm cụm lúc gộp; 1 nếu là tài liệu mở đầu, hoặc gộp vì cùng URL. */
    similarity: real("similarity").notNull(),
    /** `seed` (mở sự kiện) · `url` (cùng url_canonical) · `vector` (gần tâm cụm). */
    reason: text("reason").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.documentId] }),
    index("event_documents_event_idx").on(t.eventId),
  ],
);
