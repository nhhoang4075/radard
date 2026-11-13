/**
 * Web feed (decision 10/11/2026, mo-hinh-de-xuat.html: "the web feed is the main source, Telegram is only a
 * notification channel"):
 *
 * - `feed_snapshots`: ONE snapshot per (profile, 07:00 VN window). Built once, not rebuilt during the
 *   day; a re-run for the same (profile, window) reuses the saved snapshot. The selection seed is saved RIGHT when the row is created,
 *   before selecting (same as `digests.meta.selectSeed`).
 * - `feed_items`: the ordered list (position 1..n) of the snapshot, with score S, penalties and score components.
 * - `feed_impressions`: views of a position in the snapshot, one row per (snapshot, position).
 *
 * Like `deliveries` and `candidate_pool`, no foreign key to `events` (derived, `events rebuild` changes
 * ids): `document_ids` snapshots the event's documents at selection time.
 *
 * Profile isolation at the DB level: `feed_items` points (snapshot_id, profile_id) at `feed_snapshots`, and
 * `feed_impressions` points (profile_id, snapshot_id, position) at `feed_items`. A row of profile A
 * cannot point at a snapshot of profile B, even if the code forgets to filter.
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
    /** The 24-hour window of the snapshot; `period_end` is the 07:00 VN window. */
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    /** building (seed set, no items yet) | ready (full list saved). */
    status: text("status").notNull().default("building"),
    /** Gumbel top-k selection seed (unsigned 32-bit integer, crypto), saved before selecting. */
    selectSeed: bigint("select_seed", { mode: "number" }).notNull(),
    /** Number of items in the snapshot (≤ feedMaxItems); NULL until built. */
    itemCount: integer("item_count"),
    /** Feed floor used (value); `notify_floor` is no longer written (decision 13/11/2026: one floor). Details in `meta.floors`. */
    feedFloor: doublePrecision("feed_floor"),
    notifyFloor: doublePrecision("notify_floor"),
    /** Config passed into `select` (K, source cap, T, MMR, floors…), so the selection can be reproduced. */
    config: jsonb<Record<string, unknown>>("config").notNull().default(sql`'{}'::jsonb`),
    /** `floors`, `ranking` (counts, baselines, grey-zone gate), `learning` (p_i/p_ij of the notified items). */
    meta: jsonb<Record<string, unknown>>("meta").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    builtAt: timestamp("built_at", { withTimezone: true }),
  },
  (t) => [
    // One snapshot per (profile, window): re-runs do not build a second one.
    unique("feed_snapshots_once_uq").on(t.profileId, t.periodEnd),
    // Target of the composite foreign key from feed_items (profile isolation).
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
    /** Position in the snapshot, 1..n, by S − penalty (the order `select` returns). */
    position: integer("position").notNull(),
    /** For reference, NO foreign key: becomes wrong after the event is rebuilt. */
    eventId: bigint("event_id", { mode: "number" }).notNull(),
    /** Snapshot of `documents.id` of the event that the ranking step considered: a join that stays stable against the source data. */
    documentIds: bigint("document_ids", { mode: "number" }).array().notNull().default(sql`'{}'`),
    /** Source of the event (source of the document with the highest R, `Components.sourceId`). */
    sourceId: integer("source_id").notNull(),
    /** Topic with the highest R; NULL when no topic matches. */
    topicId: integer("topic_id"),
    /** Event title at selection time (fallback for display). */
    title: text("title").notNull(),
    /** S (before penalty) and MMR duplicate penalty. */
    score: doublePrecision("score").notNull(),
    penalty: doublePrecision("penalty").notNull(),
    r: doublePrecision("r").notNull(),
    p: doublePrecision("p").notNull(),
    c: doublePrecision("c").notNull(),
    a: doublePrecision("a").notNull(),
    f: doublePrecision("f").notNull(),
    u: doublePrecision("u").notNull(),
    n: doublePrecision("n").notNull(),
    /** Item got in thanks to the source reservation. */
    reserved: boolean("reserved").notNull(),
    /**
     * Position in the notification message (Telegram, 1..7) if the item is picked for notifying; NULL otherwise. The notification layer
     * only reads the snapshot and does not affect feed selection.
     */
    notifyPosition: integer("notify_position"),
    /**
     * Shared summary (`event_summaries`) exactly as when the snapshot was built, stable even if the event later gains
     * articles. NULL when not available (model error or not configured): the item shows its original title.
     */
    summaryId: bigint("summary_id", { mode: "number" }).references(() => eventSummaries.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("feed_items_position_uq").on(t.snapshotId, t.position),
    unique("feed_items_event_uq").on(t.snapshotId, t.eventId),
    // Target of the composite foreign keys from deliveries/feedback (id, profile) and feed_impressions (profile isolation).
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
 * Impression: the item at `position` of the snapshot shown on screen (the visibility threshold is measured by the web). One row
 * per (snapshot, position): recording again adds no row. Daily scroll depth = the largest
 * position shown of that day's snapshot (`scrollDepths` in packages/db/src/feed.ts), used later for θk.
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
