/**
 * Shared summary and the "Với tôi?" line (decision 11/11/2026, mo-hinh-de-xuat.html: "shared summary,
 * 'with you' split into a button").
 *
 * - `event_summaries`: shared summary of an event ("what happened and the context"), without
 *   `profile_id`: every profile of the same event, in the same language, shares one row. `docs_hash` is the hash
 *   (sorted) list of document ids put into the prompt, so an event that gains an article gets a new row
 *   (recomputed), the old row is kept for the messages already snapshotted (`feed_items.summary_id`).
 * - `event_for_profile`: the "Với tôi?" line of ONE profile for one event, cached by (profile, event,
 *   language, `context_hash`). `context_hash` hashes the profile context (description, context, active topics),
 *   does NOT include liked messages, so the cache stays stable.
 *
 * Like `feed_items`, `event_id` is for reference only, with no foreign key to `events` (derived,
 * `events rebuild` changes ids).
 */
import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { profile } from "./profile.ts";

export const eventSummaries = pgTable(
  "event_summaries",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    eventId: bigint("event_id", { mode: "number" }).notNull(),
    lang: text("lang").notNull(),
    /** sha256 of the list of document ids put into the prompt (sorted ascending, joined with commas). */
    docsHash: text("docs_hash").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [unique("event_summaries_uq").on(t.eventId, t.lang, t.docsHash)],
);

export const eventForProfile = pgTable(
  "event_for_profile",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profile.id, { onDelete: "cascade" }),
    eventId: bigint("event_id", { mode: "number" }).notNull(),
    lang: text("lang").notNull(),
    /** sha256 of (description + context + ids of the active topics); changing the profile recomputes it. */
    contextHash: text("context_hash").notNull(),
    text: text("text").notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    unique("event_for_profile_uq").on(t.profileId, t.eventId, t.lang, t.contextHash),
    // Daily quota count: the number of sentences this profile had the model write since a reference point.
    index("event_for_profile_quota_idx").on(t.profileId, t.createdAt),
  ],
);
