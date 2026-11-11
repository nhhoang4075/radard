/**
 * Candidate pool: every event that passed the gate in one ranking run of a profile, whether picked or not.
 *
 * The send plan (`digests.meta.plan`) keeps scores only for picked items, so it is not enough to compute the floor by
 * percentile of S over every event that passed the gate. This table keeps the missing part.
 *
 * Like `deliveries`, no foreign key to `events` (derived, `events rebuild` changes ids): `url_canonicals`
 * snapshots the URLs of the event's documents at ranking time to recognize the event after a rebuild.
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
    /** Ranking period, matches `RankPeriod`. */
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    eventId: bigint("event_id", { mode: "number" }).notNull(),
    urlCanonicals: text("url_canonicals").array().notNull(),
    /** Source of the document with the highest R (`Components.sourceId`). */
    sourceId: integer("source_id").notNull(),
    r: doublePrecision("r").notNull(),
    p: doublePrecision("p").notNull(),
    c: doublePrecision("c").notNull(),
    a: doublePrecision("a").notNull(),
    f: doublePrecision("f").notNull(),
    n: doublePrecision("n").notNull(),
    /** Taste score U (0 when there is no active cluster yet); NULL on rows written before U existed (S by the old formula). */
    u: doublePrecision("u"),
    /** S, the score before the duplicate penalty. */
    score: doublePrecision("score").notNull(),
    /** MMR penalty; only set for picked items, NULL otherwise. */
    penalty: doublePrecision("penalty"),
    selected: boolean("selected").notNull(),
    /** Reason for exclusion (`floor`, `not_new`, `source_cap`, `not_picked`); NULL when picked. */
    rejectReason: text("reject_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("candidate_pool_once_uq").on(t.profileId, t.periodEnd, t.eventId),
    index("candidate_pool_profile_idx").on(t.profileId, t.periodEnd),
  ],
);
