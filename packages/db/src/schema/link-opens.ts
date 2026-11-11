/**
 * Link opens in sent messages (the `/o/:token` route of the web role). Record only; not yet used for ranking.
 *
 * Each (delivery, link) keeps ONE row per 24-hour window: duplicate-write prevention lives in the write code
 * (advisory lock per pair, then `insert ... where not exists`), because a unique constraint cannot express
 * "within 24 hours". The index `(delivery_id, link_index, opened_at)` serves exactly that check.
 */
import { bigint, boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { deliveries } from "./delivery.ts";
import { profile } from "./profile.ts";

export const linkOpens = pgTable(
  "link_opens",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Taken from `deliveries.profile_id`, never from the request. */
    profileId: integer("profile_id")
      .notNull()
      .references(() => profile.id),
    deliveryId: bigint("delivery_id", { mode: "number" })
      .notNull()
      .references(() => deliveries.id, { onDelete: "cascade" }),
    /** Link index in `deliveries.meta.links`. */
    linkIndex: integer("link_index").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    /** Truncated to 200 characters. */
    userAgent: text("user_agent"),
    /** Flag: UA is a link-preview bot (TelegramBot…) or a prefetch header. Still writes the row. */
    isPrefetch: boolean("is_prefetch").notNull().default(false),
  },
  (t) => [
    index("link_opens_delivery_link_idx").on(t.deliveryId, t.linkIndex, t.openedAt),
    index("link_opens_profile_idx").on(t.profileId, t.openedAt),
  ],
);
