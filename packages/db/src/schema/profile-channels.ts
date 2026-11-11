/**
 * Recipient → profile mapping (multi-user). One row = one recipient on a channel, belonging to one profile.
 *
 * `channel` and `recipient` have the same values and types as `digests.channel` / `digests.recipient`; no
 * Telegram-specific data in the table (Telegram is just one `channel` value; `recipient` is the chat id).
 * A recipient belongs to ONE profile only (unique key); a profile with many rows = many channels.
 * A recipient not in the table has no rights (fail-closed).
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
    /** When off, no digest is sent and the bot does not receive updates from this recipient. */
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("profile_channels_recipient_uq").on(t.channel, t.recipient)],
);
