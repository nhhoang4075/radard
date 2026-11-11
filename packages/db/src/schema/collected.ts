/**
 * Collected data. Append-only; no table here is modified by later processing.
 *
 * `documents` holds metadata; the original content lives in ObjectStore under `raw_key`. This way
 * Postgres stays lean, and reprocessing only needs to re-read the raw copy instead of re-crawling the source.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json.ts";

export const sources = pgTable("sources", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  kind: text("kind").notNull(),
  name: text("name").notNull().unique(),
  config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
  /** Cron expression, UTC time. */
  cadence: text("cadence").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  /** Default role of documents from this source: primary | technical | press | community | aggregator. */
  defaultRole: text("default_role").notNull().default("community"),
  trustScore: real("trust_score").notNull().default(0.5),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** State managed by the adapter itself (cursors, ETags…); the core does not read inside it. */
export const sourceState = pgTable("source_state", {
  sourceId: integer("source_id")
    .primaryKey()
    .references(() => sources.id, { onDelete: "cascade" }),
  state: jsonb("state"),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  failCount: integer("fail_count").notNull().default(0),
});

export const fetchRuns = pgTable(
  "fetch_runs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** running | ok | not_modified | behind (not caught up to the latest, see `note`) | error */
    status: text("status").notNull().default("running"),
    httpStatus: integer("http_status"),
    nFetched: integer("n_fetched").notNull().default(0),
    nNew: integer("n_new").notNull().default(0),
    error: text("error"),
    /** A note that is not an error, e.g. why this run has not caught up to the latest yet. */
    note: text("note"),
  },
  (t) => [index("fetch_runs_source_started_idx").on(t.sourceId, t.startedAt)],
);

export const documents = pgTable(
  "documents",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    urlCanonical: text("url_canonical").notNull(),
    /** Title in the original language. */
    title: text("title"),
    /** Original language (filled in by the process job). Derived data is always in English. */
    lang: text("lang"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    contentSha256: text("content_sha256").notNull(),
    rawKey: text("raw_key").notNull(),
    contentType: text("content_type").notNull(),
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    unique("documents_source_external_uq").on(t.sourceId, t.externalId),
    index("documents_sha_idx").on(t.contentSha256),
    index("documents_url_idx").on(t.urlCanonical),
    index("documents_fetched_idx").on(t.fetchedAt),
  ],
);

/**
 * Pages linked to by documents (`SourceAdapter.articleUrl`), one row per URL: five re-posts of
 * the same article on HN are fetched only once. The original HTML lives in ObjectStore under `raw_key`; the text
 * body is re-extracted at each embed (derived data), so changing the text extractor does not require re-fetching.
 * Documents link here via `documents.url_canonical`; no foreign key needed.
 *
 * Pages with no content of their own (Ask HN) also get a `skipped` row, so the process job knows they were checked
 * and stops waiting for them.
 */
export const linkedPages = pgTable(
  "linked_pages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    urlCanonical: text("url_canonical").notNull().unique(),
    /** Address the request was sent to (of the first document that linked to it). */
    url: text("url").notNull(),
    finalUrl: text("final_url"),
    /** ok | blocked (robots.txt) | skipped (not HTML, or no external page) | failed */
    status: text("status").notNull(),
    httpStatus: integer("http_status"),
    contentType: text("content_type"),
    contentSha256: text("content_sha256"),
    rawKey: text("raw_key"),
    error: text("error"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("linked_pages_status_ck", sql`${t.status} in ('ok', 'blocked', 'skipped', 'failed')`),
    check("linked_pages_raw_ck", sql`(${t.status} = 'ok') = (${t.rawKey} is not null)`),
  ],
);

/**
 * GitHub repo star counts over time (github-theo-doi.html tab 05), one row per measurement, written
 * only (append). Not in `documents`: the key (source_id, external_id) keeps one row per repo, while
 * star counts change daily and every measurement must be kept to compute the 24-hour gain and acceleration.
 *
 * `repo` is `owner/repo` in lowercase (GitHub is case-insensitive), so a repo seen via Search,
 * Trending or a link in an HN post is the same. No foreign key to `documents`: one repo can come from
 * many documents from many sources.
 */
export const repoStats = pgTable(
  "repo_stats",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    repo: text("repo").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    stars: integer("stars").notNull(),
    /** Rows on the Trending page may lack the fork count, so it can be left empty. */
    forks: integer("forks"),
    /** github_stars (radard captures it itself via GraphQL) | trending_daily (read from the Trending page) */
    source: text("source").notNull(),
    /** Increase reported by the source itself ("N stars today" on Trending); empty when radard captures it itself. */
    reportedGain: integer("reported_gain"),
  },
  (t) => [
    index("repo_stats_repo_observed_idx").on(t.repo, t.observedAt),
    check("repo_stats_source_ck", sql`${t.source} in ('github_stars', 'trending_daily')`),
  ],
);
