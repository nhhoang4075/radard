/**
 * Lượt mở link trong tin đã gửi (route `/o/:token` của vai trò web). Chỉ ghi nhận; chưa dùng để xếp hạng.
 *
 * Mỗi (delivery, link) giữ MỘT dòng cho mỗi cửa sổ 24 giờ: việc chống ghi trùng nằm ở code ghi
 * (khoá tư vấn theo cặp rồi `insert ... where not exists`), vì ràng buộc duy nhất không diễn tả được
 * "trong 24 giờ". Chỉ mục `(delivery_id, link_index, opened_at)` phục vụ đúng phép kiểm đó.
 */
import { bigint, boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { deliveries } from "./delivery.ts";
import { profile } from "./profile.ts";

export const linkOpens = pgTable(
  "link_opens",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Lấy từ `deliveries.profile_id`, không bao giờ từ request. */
    profileId: integer("profile_id")
      .notNull()
      .references(() => profile.id),
    deliveryId: bigint("delivery_id", { mode: "number" })
      .notNull()
      .references(() => deliveries.id, { onDelete: "cascade" }),
    /** Chỉ số link trong `deliveries.meta.links`. */
    linkIndex: integer("link_index").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    /** Cắt 200 ký tự. */
    userAgent: text("user_agent"),
    /** Cờ: UA là bot xem trước (TelegramBot…) hoặc header prefetch. Vẫn ghi dòng. */
    isPrefetch: boolean("is_prefetch").notNull().default(false),
  },
  (t) => [
    index("link_opens_delivery_link_idx").on(t.deliveryId, t.linkIndex, t.openedAt),
    index("link_opens_profile_idx").on(t.profileId, t.openedAt),
  ],
);
