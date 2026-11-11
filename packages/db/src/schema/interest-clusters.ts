/**
 * Taste clusters of a profile: the result of clustering 👍 messages (packages/core/src/interest.ts) from the LATEST RUN.
 *
 * Each ranking run re-clusters from scratch and replaces the profile's whole cluster set (delete all, write new in one
 * transaction), so the table keeps only "yesterday's clusters" so today's clusters borrow names from the nearest centroid, with no history kept.
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
    /** Rank in the run (0 = most important), matches the order returned by `clusterInterests`. */
    position: integer("position").notNull(),
    /** `active` | `pending`, same as `InterestCluster.status`. */
    status: text("status").notNull(),
    name: text("name"),
    /** Cluster centroid, L2-normalized (same number of dimensions as the document vectors). */
    center: doublePrecision("center").array().notNull(),
    importance: doublePrecision("importance").notNull(),
    medoid: text("medoid").notNull(),
    memberIds: text("member_ids").array().notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("interest_clusters_profile_idx").on(t.profileId, t.position)],
);
