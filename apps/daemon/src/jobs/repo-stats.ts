/**
 * Job `repo_stats`: radard snapshots the star counts of the tracked GitHub repos itself, once a day
 * (github-theo-doi.html tab 05–06), to get the 24-hour star gain and its acceleration, instead of only having
 * "total stars / age" (new repos) or the count GitHub self-reports (Trending).
 *
 *   gain_24h(repo)   = stars(newest measurement) − stars(measurement at least 20 hours older than it)
 *   acceleration     = gain_24h today − gain_24h yesterday (computed the same way; the anchor is the reference measurement)
 *
 * Every measurement counts, whether radard snapshots it (`github_stars`) or it is read from the Trending page
 * (`trending_daily`, written by the fetch job): the same star number. The ≥ 20-hour rule keeps two close measurements
 * (Trending 06:10, self-snapshot 06:20, one extra manual run) from ever becoming one "day".
 *
 * Tracked set: repos with a document in the last 30 days from the sources `github_new_repos`, `github_trending`,
 * or from documents of another source (HN posts…) whose `url_canonical` is exactly the repo page. A repo with a document
 * flagged `meta.suspicious` (inflated stars) is not snapshotted.
 */
import { createLogger, type HttpClient, type Signals } from "@radard/core";
import { type Database, documents, repoStats, sources } from "@radard/db";
import { and, desc, eq, gte, inArray, like, or } from "drizzle-orm";
import { fetchStarCounts } from "../sources/github-repos.ts";
import type { DocRef } from "./signals.ts";

const log = createLogger("repo_stats");

const HOUR = 3_600_000;
const TRACK_DAYS = 30;
/** The reference measurement must be at least this many hours older than the newest one. */
export const MIN_GAP_HOURS = 20;
/** If it was self-snapshotted within this many hours, the next run (manual run, pg-boss retry) skips that repo. */
const RESNAP_HOURS = 12;
/** Signals and figures use only the newest measurement still within this many hours: older means the repo is no longer tracked. */
const FRESH_HOURS = 36;
/** Reads measurements within this many days: enough for gain_24h and acceleration even if a few days are missed. */
const LOOKBACK_DAYS = 7;

const REPO_KINDS = ["github_new_repos", "github_trending"];
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const REPO_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/;
/** GitHub's own pages have the form `github.com/x/y` but are not repos. */
const NOT_OWNERS = new Set([
  "orgs",
  "topics",
  "features",
  "collections",
  "sponsors",
  "marketplace",
  "settings",
  "apps",
  "trending",
  "enterprise",
  "about",
]);

/** Lowercase `owner/repo` this document refers to, or `null` if it is not a repo. */
export function repoOfDoc(d: Pick<DocRef, "kind" | "externalId" | "urlCanonical">): string | null {
  if (REPO_KINDS.includes(d.kind)) {
    return REPO_NAME.test(d.externalId) ? d.externalId.toLowerCase() : null;
  }
  const name = REPO_URL.exec(d.urlCanonical)?.[1]?.toLowerCase();
  if (!name || NOT_OWNERS.has(name.split("/")[0] ?? "")) return null;
  return name;
}

export interface TrackedRepo {
  /** Repo creation date (Search API), for "stars / age" when there are not yet two measurements. */
  createdAt: string | null;
}

/** Set of tracked repos, keyed by lowercase `owner/repo`. */
export async function trackedRepos(db: Database, now: Date): Promise<Map<string, TrackedRepo>> {
  const rows = await db
    .select({
      kind: sources.kind,
      externalId: documents.externalId,
      urlCanonical: documents.urlCanonical,
      meta: documents.meta,
    })
    .from(documents)
    .innerJoin(sources, eq(sources.id, documents.sourceId))
    .where(
      and(
        gte(documents.fetchedAt, new Date(now.getTime() - TRACK_DAYS * 24 * HOUR)),
        or(inArray(sources.kind, REPO_KINDS), like(documents.urlCanonical, "https://github.com/%")),
      ),
    );
  const out = new Map<string, TrackedRepo>();
  const bad = new Set<string>();
  for (const r of rows) {
    const repo = repoOfDoc(r);
    if (!repo) continue;
    const meta = r.meta as { suspicious?: boolean; createdAt?: string };
    if (meta.suspicious === true) bad.add(repo);
    const prev = out.get(repo);
    out.set(repo, { createdAt: prev?.createdAt ?? meta.createdAt ?? null });
  }
  for (const repo of bad) out.delete(repo);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Compute the gains

export interface Observation {
  at: Date;
  stars: number;
  forks: number | null;
  source: string;
  reportedGain: number | null;
}

export interface Growth {
  /** `null`: no measurement yet at least 20 hours older than the newest. */
  gain24h: number | null;
  /** `null`: not yet three measurements at least 20 hours apart. */
  accel: number | null;
}

/** First measurement (newest first in the list) at least `MIN_GAP_HOURS` before `from`. */
function referenceOf(obs: Observation[], from: Observation): Observation | undefined {
  const limit = from.at.getTime() - MIN_GAP_HOURS * HOUR;
  return obs.find((o) => o.at.getTime() <= limit);
}

/** 24-hour gain and acceleration from the measurements of ONE repo, in any order. */
export function growthOf(observations: Observation[]): Growth {
  const obs = [...observations].sort((a, b) => b.at.getTime() - a.at.getTime());
  const latest = obs[0];
  const ref = latest && referenceOf(obs, latest);
  if (!latest || !ref) return { gain24h: null, accel: null };
  const gain24h = latest.stars - ref.stars;
  const prev = referenceOf(obs, ref);
  return { gain24h, accel: prev ? gain24h - (ref.stars - prev.stars) : null };
}

/** Measurements within `LOOKBACK_DAYS` days of these repos, newest first. */
async function loadObservations(
  db: Database,
  repos: string[],
  now: Date,
): Promise<Map<string, Observation[]>> {
  const out = new Map<string, Observation[]>();
  if (repos.length === 0) return out;
  const rows = await db
    .select()
    .from(repoStats)
    .where(
      and(
        inArray(repoStats.repo, repos),
        gte(repoStats.observedAt, new Date(now.getTime() - LOOKBACK_DAYS * 24 * HOUR)),
      ),
    )
    .orderBy(desc(repoStats.observedAt));
  for (const r of rows) {
    const list = out.get(r.repo) ?? [];
    list.push({
      at: r.observedAt,
      stars: r.stars,
      forks: r.forks,
      source: r.source,
      reportedGain: r.reportedGain,
    });
    out.set(r.repo, list);
  }
  return out;
}

const isFresh = (o: Observation | undefined, now: Date): o is Observation =>
  o !== undefined && now.getTime() - o.at.getTime() <= FRESH_HOURS * HOUR;

// ---------------------------------------------------------------------------------------------
// Job

export interface RepoStatsDeps {
  db: Database;
  http: HttpClient;
  now?: () => Date;
  /** Number of repos per GraphQL request (tests set this small to see batching). */
  batchSize?: number;
}

export interface RepoStatsOutcome {
  tracked: number;
  /** Self-snapshotted within the last `RESNAP_HOURS` hours: skipped this run. */
  fresh: number;
  observed: number;
  /** GitHub did not return it (repo deleted, renamed, or made private). */
  missing: number;
  skipped?: string;
}

export async function runRepoStats(deps: RepoStatsDeps): Promise<RepoStatsOutcome> {
  const { db, http } = deps;
  const now = deps.now?.() ?? new Date();
  const tracked = [...(await trackedRepos(db, now)).keys()].sort();
  const out: RepoStatsOutcome = { tracked: tracked.length, fresh: 0, observed: 0, missing: 0 };
  if (!process.env.GITHUB_TOKEN) {
    // GraphQL does not allow anonymous calls: without a token every request gets 401, so retrying is pointless.
    log.warn("bỏ qua: chưa đặt GITHUB_TOKEN", { tracked: tracked.length });
    return { ...out, skipped: "chưa đặt GITHUB_TOKEN" };
  }
  // Idempotent over time: running again right away (CLI, pg-boss retry after a mid-run failure) snapshots only
  // repos not snapshotted recently, without writing duplicate measurements.
  const recent = new Set(
    tracked.length === 0
      ? []
      : (
          await db
            .selectDistinct({ repo: repoStats.repo })
            .from(repoStats)
            .where(
              and(
                eq(repoStats.source, "github_stars"),
                inArray(repoStats.repo, tracked),
                gte(repoStats.observedAt, new Date(now.getTime() - RESNAP_HOURS * HOUR)),
              ),
            )
        ).map((r) => r.repo),
  );
  const todo = tracked.filter((r) => !recent.has(r));
  out.fresh = recent.size;
  const counts = await fetchStarCounts(todo, http, deps.batchSize);
  const rows = [...counts].map(([repo, c]) => ({
    repo,
    observedAt: now,
    stars: c.stars,
    forks: c.forks,
    source: "github_stars" as const,
    reportedGain: null,
  }));
  for (let i = 0; i < rows.length; i += 1000) {
    await db.insert(repoStats).values(rows.slice(i, i + 1000));
  }
  out.observed = rows.length;
  out.missing = todo.length - rows.length;
  log.info("chụp số sao", { ...out });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Use the measurements

/**
 * Locally computed signals for the signals job (see `LocalSignals` in signals.ts): a document that refers to
 * a repo with ≥ 2 measurements at least 20 hours apart gets `gh_gain_24h`, and `gh_accel_24h` when three exist.
 * Without them the field is absent: the adapter's `engagement` falls back to its own method (stars/age, "N stars today").
 */
export async function repoStatsSignals(
  db: Database,
  docs: DocRef[],
  now: Date,
): Promise<Map<number, Signals>> {
  const repoOf = new Map<number, string>();
  for (const d of docs) {
    const repo = repoOfDoc(d);
    if (repo) repoOf.set(d.id, repo);
  }
  const obs = await loadObservations(db, [...new Set(repoOf.values())], now);
  const out = new Map<number, Signals>();
  for (const [docId, repo] of repoOf) {
    const list = obs.get(repo) ?? [];
    if (!isFresh(list[0], now)) continue;
    const g = growthOf(list);
    if (g.gain24h === null) continue;
    out.set(docId, {
      gh_gain_24h: g.gain24h,
      ...(g.accel === null ? {} : { gh_accel_24h: g.accel }),
    });
  }
  return out;
}

export interface RepoRow {
  repo: string;
  stars: number | null;
  forks: number | null;
  observedAt: Date | null;
  /** Stars gained per day used, by `basis`. */
  gain24h: number | null;
  accel: number | null;
  /** measured: self-measured · reported: GitHub reports ("N stars today") · age: total stars / age */
  basis: "measured" | "reported" | "age" | null;
}

/**
 * 24-hour gain of a repo, with a fallback when there are not yet two measurements: a repo on Trending uses the number
 * GitHub reported in the latest page read; a new repo uses total stars divided by age.
 */
export function withFallback(
  obs: Observation[],
  createdAt: string | null,
  now: Date,
): Pick<RepoRow, "gain24h" | "accel" | "basis"> {
  const g = growthOf(obs);
  if (g.gain24h !== null) return { ...g, basis: "measured" };
  const latest = [...obs].sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  const reported = obs.find((o) => o.source === "trending_daily" && isFresh(o, now));
  if (reported?.reportedGain != null) {
    return { gain24h: reported.reportedGain, accel: null, basis: "reported" };
  }
  if (latest && createdAt) {
    const days = Math.max(1, (now.getTime() - new Date(createdAt).getTime()) / (24 * HOUR));
    return { gain24h: Math.round(latest.stars / days), accel: null, basis: "age" };
  }
  return { gain24h: null, accel: null, basis: null };
}

/** Tracked repos with their newest measurement, biggest gain first (for the `repos` CLI). */
export async function listRepos(db: Database, now = new Date()): Promise<RepoRow[]> {
  const tracked = await trackedRepos(db, now);
  const obs = await loadObservations(db, [...tracked.keys()], now);
  const rows = [...tracked].map(([repo, t]): RepoRow => {
    const list = obs.get(repo) ?? [];
    const latest = list[0];
    return {
      repo,
      stars: latest?.stars ?? null,
      forks: list.find((o) => o.forks !== null)?.forks ?? null,
      observedAt: latest?.at ?? null,
      ...withFallback(list, t.createdAt, now),
    };
  });
  return rows.sort(
    (a, b) => (b.gain24h ?? -Infinity) - (a.gain24h ?? -Infinity) || a.repo.localeCompare(b.repo),
  );
}
