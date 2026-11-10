/**
 * Bể ứng viên: mọi sự kiện đã qua cổng trong một lần xếp hạng của một hồ sơ, được chọn hay không.
 *
 * Kế hoạch gửi (`digests.meta.plan`) chỉ giữ điểm của tin ĐƯỢC CHỌN, nên không đủ để tính sàn theo
 * phân vị của S trên mọi sự kiện qua cổng. Bảng này giữ phần còn thiếu.
 *
 * Như `deliveries`, không khoá ngoại vào `events` (dẫn xuất, `events rebuild` đổi id): `url_canonicals`
 * chụp lại URL các tài liệu của sự kiện lúc xếp hạng để nhận ra sự kiện sau khi dựng lại.
 */
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { profile } from "./profile.ts";

export const candidatePool = pgTable(
  "candidate_pool",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profile.id),
    /** Khoảng xếp hạng, khớp `RankPeriod`. */
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    eventId: bigint("event_id", { mode: "number" }).notNull(),
    urlCanonicals: text("url_canonicals").array().notNull(),
    /** Nguồn của tài liệu cho R cao nhất (`Components.sourceId`). */
    sourceId: integer("source_id").notNull(),
    r: doublePrecision("r").notNull(),
    p: doublePrecision("p").notNull(),
    c: doublePrecision("c").notNull(),
    a: doublePrecision("a").notNull(),
    f: doublePrecision("f").notNull(),
    n: doublePrecision("n").notNull(),
    /** Điểm gu U (0 khi chưa có cụm active); NULL ở dòng ghi trước khi có U (S theo công thức cũ). */
    u: doublePrecision("u"),
    /** S, điểm chưa trừ phạt trùng. */
    score: doublePrecision("score").notNull(),
    /** Phạt MMR; chỉ có với tin được chọn, còn lại NULL. */
    penalty: doublePrecision("penalty"),
    selected: boolean("selected").notNull(),
    /** Lý do bị loại (`floor`, `not_new`, `source_cap`, `not_picked`); NULL khi được chọn. */
    rejectReason: text("reject_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("candidate_pool_once_uq").on(t.profileId, t.periodEnd, t.eventId),
    index("candidate_pool_profile_idx").on(t.profileId, t.periodEnd),
  ],
);
