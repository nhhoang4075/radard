/**
 * Ánh xạ người nhận → hồ sơ (đa người dùng). Một dòng = một người nhận theo kênh thuộc về một hồ sơ.
 *
 * `channel` và `recipient` cùng giá trị, cùng kiểu với `digests.channel` / `digests.recipient`; không
 * có gì riêng của Telegram trong bảng (Telegram chỉ là một giá trị `channel`, `recipient` là chat id).
 * Một người nhận chỉ thuộc MỘT hồ sơ (khoá duy nhất); một hồ sơ có nhiều dòng = nhiều kênh.
 * Người nhận không có trong bảng thì không có quyền gì (fail-closed).
 */
import { boolean, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { profile } from "./profile.ts";

export const profileChannels = pgTable(
  "profile_channels",
  {
    id: serial("id").primaryKey(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profile.id),
    channel: text("channel").notNull(),
    recipient: text("recipient").notNull(),
    /** Tắt thì không gửi digest và bot không nhận update từ người nhận này. */
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("profile_channels_recipient_uq").on(t.channel, t.recipient)],
);
