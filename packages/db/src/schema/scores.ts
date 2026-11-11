/**
 * Scores and baselines used to rank the digest (xep-hang.html).
 *
 * Derived and recomputable: topic scores are cosine over existing vectors (SQL, no model call), signals
 * re-fetched from the source's API, baselines recomputed daily. Kept separate from `derived.ts` because
 * ranking reads them per user profile.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { documents, sources } from "./collected.ts";
import { topics } from "./profile.ts";

/**
 * Cosine between each document and ALL topics that have an embedding (library and user-added), enabled or not. Computed once
 * after embedding. Ranking reads only the scores of enabled topics; the rest show which topic a document fits
 * best across the whole library.
 */
export const docTopicScores = pgTable(
  "doc_topic_scores",
  {
    documentId: bigint("document_id", { mode: "number" })
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    topicId: bigint("topic_id", { mode: "number" })
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    score: real("score").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.topicId] }),
    index("doc_topic_scores_topic_idx").on(t.topicId),
  ],
);

/**
 * Latest community signal of the document (points, HN comments…), re-fetched from the source's API
 * right before ranking. A number stored when the item was fetched is useless: a new HN post almost always has 1 point
 * (average 1,6, measured 11/10/2026). Only the latest value is kept.
 */
export const docSignals = pgTable(
  "doc_signals",
  {
    documentId: bigint("document_id", { mode: "number" })
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** `hn_points`, `hn_comments`… named by the source adapter. */
    metric: text("metric").notNull(),
    value: real("value").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.metric] })],
);

/**
 * Baselines for normalization: the median and the top 0,1% mark over 30 days (xep-hang.html tab 03).
 * Only the latest row per key is kept; the digest copies the version it used into `digests.meta`.
 *
 *   metric = relevance   source × topic (empty source = the topic's shared baseline)
 *   metric = engagement  per source, topic empty
 *   metric = coverage    of the event, both source and topic empty
 */
export const baselines = pgTable(
  "baselines",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    metric: text("metric").notNull(),
    sourceId: integer("source_id").references(() => sources.id, { onDelete: "cascade" }),
    topicId: bigint("topic_id", { mode: "number" }).references(() => topics.id, {
      onDelete: "cascade",
    }),
    median: real("median").notNull(),
    p999: real("p999").notNull(),
    /** Sample count: sets the weight of the own baseline w = n / (n + 1000) when blended with the shared baseline. */
    n: integer("n").notNull(),
    windowDays: integer("window_days").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("baselines_key_uq").on(
      t.metric,
      sql`coalesce(${t.sourceId}, 0)`,
      sql`coalesce(${t.topicId}, 0)`,
    ),
  ],
);
