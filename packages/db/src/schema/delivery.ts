/**
 * Sent items and user feedback.
 *
 * UNLIKE derived data: this is data that CANNOT be recreated (what you received, clicked, wrote), so
 * no table here points a foreign key at `events`. `events` is derived: `events rebuild`
 * or `reset` wipes it and rebuilds with new ids. Instead, each sent item snapshots the list
 * of `documents.id` (collected data, ids never change) of the event at send time; `event_id` is only for quick lookup
 * when the event has not been rebuilt yet.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { feedItems, feedSnapshots } from "./feed.ts";
import { jsonb } from "./json.ts";
import { profile } from "./profile.ts";

/**
 * Column `profile_id`: the profile (user) that owns this row. The channel recipient (`recipient`) still keeps
 * its value for sending and joining clicks; `profile_id` is the dimension for filtering data per user (ranking,
 * scorers). The value comes from `profile_channels` (recipient → profile).
 */
const profileIdColumn = () =>
  integer("profile_id")
    .notNull()
    .references(() => profile.id);

/** One digest run (e.g. the 07:00 edition of 12/10) sent to one recipient. */
export const digests = pgTable(
  "digests",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    profileId: profileIdColumn(),
    /** `telegram` · `discord` · `webpush`… */
    channel: text("channel").notNull(),
    /** Recipient identifier per channel (Telegram: chat id). */
    recipient: text("recipient").notNull(),
    /** Time range the digest covers. */
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    /** sending | sent | failed */
    status: text("status").notNull().default("sending"),
    /** Display language of the summary (source data stays in English). */
    lang: text("lang").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    error: text("error"),
    /**
     * `plan`: the list of selected items and the exact content to send, saved BEFORE sending the first item.
     * On re-run, read the plan and send the missing positions, without re-selecting (if HN scores changed,
     * re-selecting could give a different list). Includes scores, config and baselines to explain why items were chosen.
     */
    meta: jsonb<Record<string, unknown>>("meta").notNull().default(sql`'{}'::jsonb`),
    /** The feed snapshot this notification takes items from; NULL for digests before the feed existed (11/2026). */
    feedSnapshotId: bigint("feed_snapshot_id", { mode: "number" }),
  },
  (t) => [
    // Composite foreign key (snapshot, profile): a digest of profile A cannot point at a snapshot of profile B.
    foreignKey({
      name: "digests_feed_snapshot_fk",
      columns: [t.feedSnapshotId, t.profileId],
      foreignColumns: [feedSnapshots.id, feedSnapshots.profileId],
    }),
    // A recipient of a profile gets only one digest per range: a re-run job does not send duplicates.
    uniqueIndex("digests_once_uq").on(t.profileId, t.channel, t.recipient, t.periodEnd),
    index("digests_profile_idx").on(t.profileId, t.periodEnd),
    check("digests_status_ck", sql`${t.status} in ('sending', 'sent', 'failed')`),
  ],
);

/**
 * One row per sent item: the digest's opening item, an event item, or a test item (`notify test`).
 * Feedback analysis only takes `kind = 'event'`; the constraint below guarantees that row always belongs to one
 * digest and one event, so test items never get mixed in.
 */
export const deliveries = pgTable(
  "deliveries",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    profileId: profileIdColumn(),
    digestId: bigint("digest_id", { mode: "number" }).references(() => digests.id, {
      onDelete: "cascade",
    }),
    channel: text("channel").notNull(),
    recipient: text("recipient").notNull(),
    /** Item id on the channel side (Telegram: message_id). Replies and button presses are linked back here. */
    messageId: text("message_id").notNull(),
    /** header (opening item) | event (an event item) | test (test item, outside the digest) */
    kind: text("kind").notNull(),
    /** Position in the digest (1…7), for display and to measure "whether the first item gets more clicks". */
    position: bigint("position", { mode: "number" }),
    /** For reference, NO foreign key: becomes wrong after the event is rebuilt. */
    eventId: bigint("event_id", { mode: "number" }),
    /** Snapshot of the event's `documents.id` at send time: a join that stays stable against the source data. */
    documentIds: bigint("document_ids", { mode: "number" }).array().notNull().default(sql`'{}'`),
    /** The exact content sent (title, summary, link): what you read is kept exactly as it was. */
    title: text("title"),
    body: text("body").notNull(),
    meta: jsonb<Record<string, unknown>>("meta").notNull().default(sql`'{}'::jsonb`),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    /** Corresponding feed item (event item sent from the snapshot); NULL for opening items, test items and old items. */
    feedItemId: bigint("feed_item_id", { mode: "number" }),
  },
  (t) => [
    // Composite foreign key (feed item, profile): an item sent to profile A cannot point at a feed item of profile B.
    foreignKey({
      name: "deliveries_feed_item_fk",
      columns: [t.feedItemId, t.profileId],
      foreignColumns: [feedItems.id, feedItems.profileId],
    }),
    uniqueIndex("deliveries_message_uq").on(t.channel, t.recipient, t.messageId),
    index("deliveries_digest_idx").on(t.digestId),
    // Ranking's "already sent" query: by profile, item kind, send time.
    index("deliveries_profile_idx").on(t.profileId, t.kind, t.sentAt),
    // Each position of a digest is sent exactly once (test items outside the digest have an empty digest_id).
    uniqueIndex("deliveries_digest_position_uq").on(t.digestId, t.position),
    check("deliveries_kind_ck", sql`${t.kind} in ('header', 'event', 'test')`),
    // Only test items sit outside the digest; only event items have event_id; items in the digest always have a position.
    check(
      "deliveries_shape_ck",
      sql`(${t.kind} = 'test') = (${t.digestId} is null)
        and (${t.kind} = 'event') = (${t.eventId} is not null)
        and (${t.digestId} is null) = (${t.position} is null)`,
    ),
  ],
);

/**
 * User feedback: a button press or a written note. Append only; pressing 👍 and then changing it to 👎 makes two
 * rows; the latest row is the current opinion. Deselecting is a `clear` row (no row is deleted).
 */
export const feedback = pgTable(
  "feedback",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    profileId: profileIdColumn(),
    /** The item being responded to. Empty = general comment, not tied to any event (a regular message). */
    deliveryId: bigint("delivery_id", { mode: "number" }).references(() => deliveries.id, {
      onDelete: "set null",
    }),
    channel: text("channel").notNull(),
    recipient: text("recipient").notNull(),
    /** like | dislike | clear | comment. `clear` = deselect (press the same selected button again). */
    kind: text("kind").notNull(),
    /** Comment text, kept in the language the user wrote. Empty for like/dislike/clear. */
    text: text("text"),
    /** The user's message id on the channel side (for comments), so duplicates are not written when an update is received again. */
    sourceMessageId: text("source_message_id"),
    meta: jsonb<Record<string, unknown>>("meta").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Feed item being responded to: web feedback always has it; Telegram feedback has it when the item was sent from the snapshot
     * (`deliveries.feed_item_id`). NULL for old feedback and general comments.
     */
    feedItemId: bigint("feed_item_id", { mode: "number" }),
  },
  (t) => [
    // Composite foreign key like deliveries: feedback of profile A cannot point at a feed item of profile B.
    foreignKey({
      name: "feedback_feed_item_fk",
      columns: [t.feedItemId, t.profileId],
      foreignColumns: [feedItems.id, feedItems.profileId],
    }),
    index("feedback_feed_item_idx").on(t.feedItemId),
    index("feedback_delivery_idx").on(t.deliveryId),
    index("feedback_created_idx").on(t.createdAt),
    index("feedback_profile_idx").on(t.profileId, t.createdAt),
    uniqueIndex("feedback_source_message_uq").on(t.channel, t.recipient, t.sourceMessageId),
    check("feedback_kind_ck", sql`${t.kind} in ('like', 'dislike', 'clear', 'comment')`),
    check(
      "feedback_text_ck",
      sql`(${t.kind} = 'comment') = (${t.text} is not null and length(${t.text}) > 0)`,
    ),
  ],
);
