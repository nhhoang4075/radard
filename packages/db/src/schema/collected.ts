/**
 * Dữ liệu thu thập. Chỉ ghi thêm; không bảng nào ở đây bị sửa bởi xử lý phía sau.
 *
 * `documents` giữ metadata; nội dung gốc nằm trong ObjectStore theo `raw_key`. Như vậy
 * Postgres gọn, và xử lý lại chỉ cần đọc lại bản thô chứ không cào lại nguồn.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json.ts";

export const sources = pgTable("sources", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  kind: text("kind").notNull(),
  name: text("name").notNull().unique(),
  config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
  /** Biểu thức cron, giờ UTC. */
  cadence: text("cadence").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  /** Vai trò mặc định của tài liệu từ nguồn này: primary | technical | press | community | aggregator. */
  defaultRole: text("default_role").notNull().default("community"),
  trustScore: real("trust_score").notNull().default(0.5),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Trạng thái do adapter tự quản (con trỏ, ETag…), lõi không đọc bên trong. */
export const sourceState = pgTable("source_state", {
  sourceId: integer("source_id")
    .primaryKey()
    .references(() => sources.id, { onDelete: "cascade" }),
  state: jsonb("state"),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  failCount: integer("fail_count").notNull().default(0),
});

export const fetchRuns = pgTable(
  "fetch_runs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** running | ok | not_modified | behind (chưa bắt kịp hiện tại, xem `note`) | error */
    status: text("status").notNull().default("running"),
    httpStatus: integer("http_status"),
    nFetched: integer("n_fetched").notNull().default(0),
    nNew: integer("n_new").notNull().default(0),
    error: text("error"),
    /** Ghi chú không phải lỗi, ví dụ vì sao lượt này chưa bắt kịp hiện tại. */
    note: text("note"),
  },
  (t) => [index("fetch_runs_source_started_idx").on(t.sourceId, t.startedAt)],
);

export const documents = pgTable(
  "documents",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    urlCanonical: text("url_canonical").notNull(),
    /** Tiêu đề ở ngôn ngữ gốc. */
    title: text("title"),
    /** Ngôn ngữ gốc (job process điền). Dữ liệu dẫn xuất luôn bằng tiếng Anh. */
    lang: text("lang"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    contentSha256: text("content_sha256").notNull(),
    rawKey: text("raw_key").notNull(),
    contentType: text("content_type").notNull(),
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    unique("documents_source_external_uq").on(t.sourceId, t.externalId),
    index("documents_sha_idx").on(t.contentSha256),
    index("documents_url_idx").on(t.urlCanonical),
    index("documents_fetched_idx").on(t.fetchedAt),
  ],
);

/**
 * Trang được tài liệu link tới (`SourceAdapter.articleUrl`), mỗi URL một dòng: năm lượt đăng lại
 * cùng một bài trên HN chỉ tải một lần. HTML gốc nằm trong ObjectStore theo `raw_key`; phần chữ
 * chính được rút lại mỗi lần embed (dữ liệu dẫn xuất), nên đổi bộ rút chữ không phải tải lại.
 * Tài liệu nối về đây qua `documents.url_canonical`, không cần khoá ngoại.
 *
 * Trang không có nội dung riêng (Ask HN) cũng có một dòng `skipped`, để job process biết đã xét
 * xong và không chờ nữa.
 */
export const linkedPages = pgTable(
  "linked_pages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    urlCanonical: text("url_canonical").notNull().unique(),
    /** Địa chỉ đã gửi request (của tài liệu đầu tiên link tới). */
    url: text("url").notNull(),
    finalUrl: text("final_url"),
    /** ok | blocked (robots.txt) | skipped (không phải HTML, hoặc không có trang ngoài) | failed */
    status: text("status").notNull(),
    httpStatus: integer("http_status"),
    contentType: text("content_type"),
    contentSha256: text("content_sha256"),
    rawKey: text("raw_key"),
    error: text("error"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("linked_pages_status_ck", sql`${t.status} in ('ok', 'blocked', 'skipped', 'failed')`),
    check("linked_pages_raw_ck", sql`(${t.status} = 'ok') = (${t.rawKey} is not null)`),
  ],
);
