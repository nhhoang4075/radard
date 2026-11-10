/**
 * Cụm gu của một hồ sơ: kết quả gom cụm tin 👍 (packages/core/src/interest.ts) của LẦN CHẠY GẦN NHẤT.
 *
 * Mỗi lần xếp hạng gom lại từ đầu rồi thay cả bộ cụm của hồ sơ (xoá hết, ghi mới trong một giao
 * dịch), nên bảng chỉ giữ "cụm hôm qua" để cụm hôm nay mượn tên theo tâm gần nhất, không giữ lịch sử.
 */
import {
  bigint,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { profile } from "./profile.ts";

export const interestClusters = pgTable(
  "interest_clusters",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profile.id),
    /** Thứ hạng trong lần chạy (0 = quan trọng nhất), khớp thứ tự `clusterInterests` trả về. */
    position: integer("position").notNull(),
    /** `active` | `pending`, như `InterestCluster.status`. */
    status: text("status").notNull(),
    name: text("name"),
    /** Tâm cụm, đã chuẩn hoá L2 (cùng số chiều với vector tài liệu). */
    center: doublePrecision("center").array().notNull(),
    importance: doublePrecision("importance").notNull(),
    medoid: text("medoid").notNull(),
    memberIds: text("member_ids").array().notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("interest_clusters_profile_idx").on(t.profileId, t.position)],
);
