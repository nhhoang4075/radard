/**
 * Danh sách mời: chỉ email có ở đây (hoặc trùng `OWNER_EMAIL`) mới đăng ký được. Hook "trước khi
 * tạo user" của Better Auth tra bảng này và từ chối khi không thấy hoặc khi lỗi (fail-closed).
 *
 * `email` luôn chữ thường (ràng buộc CHECK) để so sánh không phụ thuộc cách gõ hoa/thường.
 */
import { sql } from "drizzle-orm";
import { check, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { profile } from "./profile.ts";

export const invites = pgTable(
  "invites",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull().unique(),
    /** Hồ sơ của người mời; trống khi chủ dự án thêm trực tiếp. */
    invitedByProfileId: integer("invited_by_profile_id").references(() => profile.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Lúc người được mời đăng ký xong; trống = chưa dùng. */
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [check("invites_email_lower_ck", sql`${t.email} = lower(${t.email})`)],
);
