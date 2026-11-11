/**
 * Feed web (quyết định 10/11/2026, mo-hinh-de-xuat.html: "feed web là nguồn chính, Telegram chỉ là
 * kênh thông báo"):
 *
 * - `feed_snapshots`: MỘT bản chụp mỗi (hồ sơ, khung 07:00 VN). Dựng một lần, không dựng lại trong
 *   ngày; chạy lại cùng (hồ sơ, khung) dùng lại bản đã lưu. Hạt giống chọn lưu NGAY khi tạo dòng,
 *   trước khi chọn (cùng kiểu `digests.meta.selectSeed`).
 * - `feed_items`: danh sách có thứ tự (vị trí 1..n) của bản chụp, kèm điểm S, phạt, thành phần điểm.
 * - `feed_impressions`: lượt hiện của một vị trí trong bản chụp, mỗi (bản chụp, vị trí) một dòng.
 *
 * Như `deliveries` và `candidate_pool`, không khoá ngoại vào `events` (dẫn xuất, `events rebuild` đổi
 * id): `document_ids` chụp lại tài liệu của sự kiện lúc chọn.
 *
 * Cách ly hồ sơ ở mức DB: `feed_items` trỏ (snapshot_id, profile_id) vào `feed_snapshots`, và
 * `feed_impressions` trỏ (profile_id, snapshot_id, position) vào `feed_items`. Một dòng của hồ sơ A
 * không thể trỏ vào bản chụp của hồ sơ B, kể cả khi code quên lọc.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json.ts";
import { profile } from "./profile.ts";
import { eventSummaries } from "./summaries.ts";

export const feedSnapshots = pgTable(
  "feed_snapshots",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profile.id),
    /** Khoảng 24 giờ của bản chụp; `period_end` là khung 07:00 VN. */
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    /** building (đã có hạt giống, chưa có tin) | ready (đã lưu đủ danh sách). */
    status: text("status").notNull().default("building"),
    /** Hạt giống chọn Gumbel top-k (số nguyên không dấu 32 bit, crypto), lưu trước khi chọn. */
    selectSeed: bigint("select_seed", { mode: "number" }).notNull(),
    /** Số tin của bản chụp (≤ feedMaxItems); NULL khi chưa dựng xong. */
    itemCount: integer("item_count"),
    /** Sàn feed và sàn thông báo đã dùng (giá trị). Chi tiết (nguồn, q, n, ngày) ở `meta.floors`. */
    feedFloor: doublePrecision("feed_floor"),
    notifyFloor: doublePrecision("notify_floor"),
    /** Cấu hình đã đưa vào `select` (K, trần nguồn, T, MMR, sàn…), để tái hiện được lần chọn. */
    config: jsonb<Record<string, unknown>>("config").notNull().default(sql`'{}'::jsonb`),
    /** `floors`, `ranking` (số đếm, mặt bằng, cổng vùng xám), `learning` (p_i/p_ij của tin báo). */
    meta: jsonb<Record<string, unknown>>("meta").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    builtAt: timestamp("built_at", { withTimezone: true }),
  },
  (t) => [
    // Một bản chụp mỗi (hồ sơ, khung): chạy lại không dựng bản thứ hai.
    unique("feed_snapshots_once_uq").on(t.profileId, t.periodEnd),
    // Đích của khoá ngoại ghép từ feed_items (cách ly hồ sơ).
    unique("feed_snapshots_owner_uq").on(t.id, t.profileId),
    check("feed_snapshots_status_ck", sql`${t.status} in ('building', 'ready')`),
    check("feed_snapshots_seed_ck", sql`${t.selectSeed} >= 0 and ${t.selectSeed} < 4294967296`),
  ],
);

export const feedItems = pgTable(
  "feed_items",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    profileId: integer("profile_id").notNull(),
    snapshotId: bigint("snapshot_id", { mode: "number" }).notNull(),
    /** Vị trí trong bản chụp, 1..n, theo S − phạt (thứ tự `select` trả về). */
    position: integer("position").notNull(),
    /** Tham khảo, KHÔNG có khoá ngoại: sẽ sai sau khi dựng lại sự kiện. */
    eventId: bigint("event_id", { mode: "number" }).notNull(),
    /** Ảnh chụp `documents.id` của sự kiện mà bước xếp hạng đã xét: mối nối bền với dữ liệu gốc. */
    documentIds: bigint("document_ids", { mode: "number" }).array().notNull().default(sql`'{}'`),
    /** Nguồn của sự kiện (nguồn của tài liệu cho R cao nhất, `Components.sourceId`). */
    sourceId: integer("source_id").notNull(),
    /** Chủ đề cho R cao nhất; NULL khi không khớp chủ đề nào. */
    topicId: integer("topic_id"),
    /** Tiêu đề sự kiện lúc chọn (dự phòng khi hiển thị). */
    title: text("title").notNull(),
    /** S (chưa trừ phạt) và phạt trùng MMR. */
    score: doublePrecision("score").notNull(),
    penalty: doublePrecision("penalty").notNull(),
    r: doublePrecision("r").notNull(),
    p: doublePrecision("p").notNull(),
    c: doublePrecision("c").notNull(),
    a: doublePrecision("a").notNull(),
    f: doublePrecision("f").notNull(),
    u: doublePrecision("u").notNull(),
    n: doublePrecision("n").notNull(),
    /** Tin vào nhờ chỗ giữ cho nguồn. */
    reserved: boolean("reserved").notNull(),
    /**
     * Vị trí trong bản thông báo (Telegram, 1..7) nếu tin được chọn để báo; NULL nếu không. Lớp thông
     * báo chỉ đọc bản chụp, không ảnh hưởng việc chọn feed.
     */
    notifyPosition: integer("notify_position"),
    /**
     * Tóm tắt chung (`event_summaries`) đúng như lúc dựng bản chụp, ổn định dù sự kiện về sau có thêm
     * bài. NULL khi chưa có (model lỗi hoặc chưa cấu hình): tin hiện bằng tiêu đề gốc.
     */
    summaryId: bigint("summary_id", { mode: "number" }).references(() => eventSummaries.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("feed_items_position_uq").on(t.snapshotId, t.position),
    unique("feed_items_event_uq").on(t.snapshotId, t.eventId),
    // Đích của khoá ngoại ghép từ deliveries/feedback (id, hồ sơ) và feed_impressions (cách ly hồ sơ).
    unique("feed_items_id_owner_uq").on(t.id, t.profileId),
    unique("feed_items_owner_uq").on(t.profileId, t.snapshotId, t.position),
    foreignKey({
      name: "feed_items_snapshot_fk",
      columns: [t.snapshotId, t.profileId],
      foreignColumns: [feedSnapshots.id, feedSnapshots.profileId],
    }).onDelete("cascade"),
    index("feed_items_profile_idx").on(t.profileId, t.snapshotId),
    check("feed_items_position_ck", sql`${t.position} >= 1`),
    check("feed_items_notify_ck", sql`${t.notifyPosition} is null or ${t.notifyPosition} >= 1`),
  ],
);

/**
 * Lượt hiện: tin ở `position` của bản chụp đã hiện trên màn hình (ngưỡng hiện do web đo). Một dòng
 * mỗi (bản chụp, vị trí): ghi lại lần nữa không thêm dòng. Độ sâu cuộn mỗi ngày = vị trí lớn nhất
 * đã hiện của bản chụp ngày đó (`scrollDepths` trong packages/db/src/feed.ts), phục vụ θk sau này.
 */
export const feedImpressions = pgTable(
  "feed_impressions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    profileId: integer("profile_id").notNull(),
    snapshotId: bigint("snapshot_id", { mode: "number" }).notNull(),
    position: integer("position").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("feed_impressions_once_uq").on(t.snapshotId, t.position),
    foreignKey({
      name: "feed_impressions_item_fk",
      columns: [t.profileId, t.snapshotId, t.position],
      foreignColumns: [feedItems.profileId, feedItems.snapshotId, feedItems.position],
    }).onDelete("cascade"),
    index("feed_impressions_profile_idx").on(t.profileId, t.seenAt),
  ],
);
