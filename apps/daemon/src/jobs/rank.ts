/**
 * Ranks one digest window on the DB: reads candidates, baselines and signals, then calls the pure functions
 * in `@radard/core` (ranking.ts). Shared by the digest job and the `rank` CLI.
 *
 * Order chosen to make the fewest requests: the R gate is computed on existing topic scores (no network); events with
 * R in the grey zone are asked of the decision model (gate-decision.ts); then only signals (HN points) are re-fetched
 * for the documents of the events that pass the gate.
 */
import {
  type Baseline,
  type Baselines,
  type Components,
  components,
  createLogger,
  DEFAULT_RANK_CONFIG,
  type DecisionProvider,
  FLOOR_WINDOW_DAYS,
  type FloorResult,
  type HttpClient,
  type InterestCluster,
  mulberry32,
  needsDecision,
  passesGate,
  percentileFloor,
  type RankConfig,
  type RankDoc,
  type RankEvent,
  type Scored,
  type Selection,
  scoreOf,
  select,
} from "@radard/core";
import {
  baselines,
  type Database,
  docSignals,
  docTopicScores,
  documents,
  eventDocuments,
  events,
  profileTopics,
  sources,
  topics as topicsTable,
} from "@radard/db";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { adapterFor } from "../sources/index.ts";
import { readCandidateScores } from "./candidate-pool.ts";
import {
  countGate,
  decideGate,
  type GateCandidate,
  type GateCounts,
  type GateDecision,
} from "./gate-decision.ts";
import { computeInterestClusters } from "./interest.ts";
import { refreshSignals } from "./signals.ts";

const log = createLogger("rank");

export interface RankPeriod {
  start: Date;
  end: Date;
}

export interface RankResult extends Selection {
  period: RankPeriod;
  candidates: number;
  passedGate: number;
  /** The scored candidate list fed into `select` (including items dropped by the gate and floor), so the simulation gets the exact input. */
  scored: Scored[];
  /** The config fed into `select` (already includes the floors S and T), so the simulation gets the exact input. */
  selectConfig: RankConfig;
  /** Seed of the selection; `null` when the selection is deterministic (T = 0, see preview). */
  selectSeed: number | null;
  /** Every event with R in the grey zone: the decision model was asked, or the old rule was used (`fallback`). */
  gateDecisions: GateDecision[];
  gateCounts: GateCounts;
  /** Time spent asking the decision model for the gate, in milliseconds. */
  gateMs: number;
  config: RankConfig;
  /** Taste clusters (from 👍 items) used to score U, including `pending` clusters that did not take part. */
  interestClusters: InterestCluster[];
  /**
   * NOTIFICATION floor (targets `notify.floorTargetPerDay` items/day): the Telegram layer filters the snapshot by this floor.
   * Not used in `select`.
   */
  floor: FloorResult;
  /** FEED floor (targets `feedFloorTargetPerDay` items/day) passed into `select` (`selectConfig.floorS`). */
  feedFloor: FloorResult;
  /** Baselines used, so the digest can store them and explain why items were chosen. */
  baselines: {
    metric: string;
    sourceId: number | null;
    topicId: number | null;
    median: number;
    p999: number;
    n: number;
  }[];
  topicLabels: Map<number, string>;
  /** Scope of each enabled topic (for the LLM to label); self-added topics without one are absent. */
  topicNotes: Map<number, string>;
  sourceNames: Map<number, string>;
  sourceKinds: Map<number, string>;
}

/** The 24-hour window ending at `end`. */
export function periodEndingAt(end: Date, hours = 24): RankPeriod {
  return { start: new Date(end.getTime() - hours * 3_600_000), end };
}

/**
 * Enabled topics of the profile: only "interested" ones count toward R; ordered by selection time, so ties give
 * the same result on every run.
 */
export async function loadProfileTopics(
  db: Database,
  profileId: number,
): Promise<{ id: number; label: string; note: string | null }[]> {
  return db
    .select({ id: topicsTable.id, label: topicsTable.name, note: topicsTable.labelGuide })
    .from(profileTopics)
    .innerJoin(topicsTable, eq(topicsTable.id, profileTopics.topicId))
    .where(
      and(
        eq(profileTopics.profileId, profileId),
        eq(profileTopics.active, true),
        eq(profileTopics.kind, "include"),
      ),
    )
    .orderBy(profileTopics.id);
}

export async function rankPeriod(
  db: Database,
  period: RankPeriod,
  opts: {
    /** Profile being ranked: only the enabled topics and the sent items of this profile are counted. */
    profileId: number;
    http?: HttpClient;
    config?: Partial<RankConfig>;
    /** Decision model for the gate's grey zone; without it the rule R ≥ `gateR` is used (tests, CLI). */
    decider?: DecisionProvider | null;
    /**
     * Saves the run's taste clusters as "yesterday's clusters" (default on). The CLI preview (`rank --at …`) sets
     * `false` so it does not overwrite the clusters in use.
     */
    persistInterests?: boolean;
    /**
     * Seed for the Gumbel top-k selection. WITH a seed: T comes from `config` or the default (0,03), and the rng is
     * mulberry32(seed). WITHOUT a seed: T = 0, deterministic selection (a preview does not change randomly).
     */
    selectSeed?: number;
  },
): Promise<RankResult> {
  const srcRows = await db.select().from(sources);
  const config: RankConfig = {
    ...DEFAULT_RANK_CONFIG,
    priors: new Map(srcRows.map((s) => [s.id, s.trustScore])),
    ...opts.config,
  };
  if (opts.selectSeed === undefined && opts.config?.temperature === undefined)
    config.temperature = 0;
  const kindOf = new Map(srcRows.map((s) => [s.id, s.kind]));

  const baseRows = await db.select().from(baselines);
  const key = (m: string, s: number | null, t: number | null) => `${m}|${s ?? ""}|${t ?? ""}`;
  const baseMap = new Map<string, Baseline>(
    baseRows.map((b) => [key(b.metric, b.sourceId, b.topicId), b]),
  );
  const base: Baselines = {
    relevance: (s, t) => baseMap.get(key("relevance", s, t)),
    engagement: (s) => baseMap.get(key("engagement", s, null)),
    coverage: () => baseMap.get(key("coverage", null, null)),
  };

  const topics = await loadProfileTopics(db, opts.profileId);
  const topicIds = topics.map((t) => t.id);

  // Candidates: events with at least one new document in the window.
  const at = sql`coalesce(${documents.publishedAt}, ${documents.fetchedAt})`;
  // Source documents flagged suspicious (inflated repo stars…) do not count toward item scores, though they are still stored and scored.
  const trusted = sql`(${documents.meta}->>'suspicious') is distinct from 'true'`;
  const evIds = (
    await db
      .selectDistinct({ id: eventDocuments.eventId })
      .from(eventDocuments)
      .innerJoin(documents, eq(documents.id, eventDocuments.documentId))
      .where(and(gte(at, period.start), lt(at, period.end), trusted))
  ).map((r) => r.id);

  const evRows = evIds.length
    ? await db
        .select({
          id: events.id,
          title: events.title,
          firstSeenAt: events.firstSeenAt,
          centroid: events.centroid,
        })
        .from(events)
        .where(inArray(events.id, evIds))
    : [];
  // Documents of an event count up to the end of the window (later articles are not taken, so re-running an old
  // day gives exactly that day's result).
  const docRows = evIds.length
    ? await db
        .select({
          eventId: eventDocuments.eventId,
          id: documents.id,
          sourceId: documents.sourceId,
          url: documents.urlCanonical,
        })
        .from(eventDocuments)
        .innerJoin(documents, eq(documents.id, eventDocuments.documentId))
        .where(and(inArray(eventDocuments.eventId, evIds), lt(at, period.end), trusted))
    : [];
  const docIds = docRows.map((d) => d.id);

  const scores = new Map<number, Map<number, number>>();
  if (docIds.length && topicIds.length) {
    for (const r of await db
      .select()
      .from(docTopicScores)
      .where(
        and(inArray(docTopicScores.documentId, docIds), inArray(docTopicScores.topicId, topicIds)),
      )) {
      const m = scores.get(r.documentId) ?? new Map<number, number>();
      m.set(r.topicId, r.score);
      scores.set(r.documentId, m);
    }
  }

  // URLs of EVERY document ever SEEN, to date (no 7-day cutoff: an item read on 16/10 is still read on 09/11).
  // "Seen" = sent in an event item, or a feed item already shown (decision 10/11/2026, score 5); a feed item not yet
  // scrolled to still qualifies the next day. The `end` cutoff keeps re-running an old day giving that day's exact result.
  // Only of THIS profile.
  const sent = new Set<string>();
  for (const r of await db.execute<{ url: string }>(sql`
    select distinct d.url_canonical as url
    from deliveries dl
    cross join lateral unnest(dl.document_ids) as x(id)
    join documents d on d.id = x.id
    where dl.profile_id = ${opts.profileId} and dl.kind = 'event' and dl.sent_at < ${period.end}
    union
    select distinct d.url_canonical as url
    from feed_impressions fi
    join feed_items it
      on it.profile_id = fi.profile_id and it.snapshot_id = fi.snapshot_id and it.position = fi.position
    cross join lateral unnest(it.document_ids) as x(id)
    join documents d on d.id = x.id
    where fi.profile_id = ${opts.profileId} and fi.seen_at < ${period.end}`))
    sent.add(r.url);

  // Taste: re-clusters the 👍 items from scratch at cutoff `end` on every ranking run (new clusters borrow the previous cluster's name).
  const interests = await computeInterestClusters(db, opts.profileId, period.end, config.interest, {
    persist: opts.persistInterests ?? true,
  });
  const hasTaste = interests.some((c) => c.status === "active");

  const build = async (
    signals: Map<number, Record<string, number>>,
    vectors?: ReadonlyMap<number, number[]>,
  ): Promise<RankEvent[]> => {
    const byEvent = new Map<number, RankDoc[]>();
    for (const d of docRows) {
      let engagement: number | null = null;
      const s = signals.get(d.id);
      const kind = kindOf.get(d.sourceId);
      if (s && kind) {
        try {
          engagement = adapterFor(kind).engagement?.(s) ?? null;
        } catch {
          engagement = null;
        }
      }
      const list = byEvent.get(d.eventId) ?? [];
      const vector = vectors?.get(d.id);
      list.push({
        documentId: d.id,
        sourceId: d.sourceId,
        urlCanonical: d.url,
        topicScores: scores.get(d.id) ?? new Map(),
        engagement,
        ...(vector ? { vector } : {}),
      });
      byEvent.set(d.eventId, list);
    }
    return evRows.map((e) => ({
      eventId: e.id,
      title: e.title,
      firstSeenAt: e.firstSeenAt,
      centroid: e.centroid,
      docs: byEvent.get(e.id) ?? [],
    }));
  };

  const loadSignals = async (ids: number[]) => {
    const out = new Map<number, Record<string, number>>();
    if (ids.length === 0) return out;
    for (const r of await db.select().from(docSignals).where(inArray(docSignals.documentId, ids))) {
      out.set(r.documentId, { ...out.get(r.documentId), [r.metric]: r.value });
    }
    return out;
  };

  // Pass 1: R gate (no signals needed); grey-zone events are asked of the decision model. Pass 2: re-fetch signals
  // for the events that pass the gate, then score them fully.
  const first = (await build(new Map())).map((e) => ({
    event: e,
    c: components(e, base, config, period.start, sent),
  }));
  const gateStarted = Date.now();
  const gateDecisions = await decideGate(db, grayZone(first, config), opts.decider, config);
  const gateMs = Date.now() - gateStarted;
  // Only the model's real answer replaces the rule; `fallback` leaves it for `select` to use R ≥ gateR.
  const verdicts = new Map(
    gateDecisions.filter((d) => !d.fallback).map((d) => [d.eventId, d.pass] as const),
  );
  const gateOf = (id: number) => verdicts.get(id);
  const passing = first
    .filter((x) => passesGate({ c: x.c, gate: gateOf(x.event.eventId) }, config))
    .map((x) => x.event);
  const passingDocIds = passing.flatMap((e) => e.docs.map((d) => d.documentId));
  if (opts.http) await refreshSignals(db, opts.http, passingDocIds);
  const signals = await loadSignals(passingDocIds);
  // Document vectors are loaded only when there is an active cluster, and only for events that pass the gate (the U of items dropped
  // by the gate is not used by anyone: they do not enter the pool or the plan).
  const vectors = hasTaste ? await loadDocVectors(db, passingDocIds) : undefined;
  const full = await build(signals, vectors);
  // Events that do not pass the gate are still scored (so the CLI can explain why they were dropped), without signals.
  const scored: Scored[] = full.map((e) => {
    const c = components(e, base, config, period.start, sent, interests);
    const gate = gateOf(e.eventId);
    return gate === undefined
      ? { event: e, c, S: scoreOf(c, config) }
      : { event: e, c, S: scoreOf(c, config), gate };
  });

  const { feed: feedFloor, notify: floor } = await resolveFloors(
    db,
    opts.profileId,
    period,
    config,
  );
  for (const [kind, f] of [
    ["feed", feedFloor],
    ["notify", floor],
  ] as const) {
    log.info("sàn điểm", {
      profileId: opts.profileId,
      kind,
      source: f.source,
      value: f.value,
      q: f.q ?? null,
      n: f.n ?? null,
      days: f.days,
    });
  }
  // `select` runs ONCE for the feed snapshot: cap K = feedMaxItems, per-source cap feedMaxPerSource, feed
  // floor. The gate, grey zone, MMR, slot reservation and T stay unchanged.
  const selectConfig: RankConfig = {
    ...config,
    maxItems: config.feedMaxItems,
    maxPerSource: config.feedMaxPerSource,
    floorS: feedFloor.value,
  };
  const selection = select(
    scored,
    selectConfig,
    undefined,
    opts.selectSeed === undefined ? undefined : mulberry32(opts.selectSeed),
  );
  return {
    ...selection,
    scored,
    selectConfig,
    selectSeed: config.temperature > 0 && opts.selectSeed !== undefined ? opts.selectSeed : null,
    floor,
    feedFloor,
    period,
    candidates: evRows.length,
    passedGate: passing.length,
    gateDecisions,
    gateCounts: countGate(gateDecisions),
    gateMs,
    config,
    interestClusters: interests,
    // Only save the baselines used: enabled topics, plus the same signal and coverage baselines.
    baselines: baseRows
      .filter((b) => b.topicId === null || topicIds.includes(b.topicId))
      .map((b) => ({
        metric: b.metric,
        sourceId: b.sourceId,
        topicId: b.topicId,
        median: b.median,
        p999: b.p999,
        n: b.n,
      })),
    topicLabels: new Map(topics.map((t) => [t.id, t.label])),
    topicNotes: new Map(topics.flatMap((t) => (t.note ? [[t.id, t.note] as const] : []))),
    sourceNames: new Map(srcRows.map((s) => [s.id, s.name])),
    sourceKinds: kindOf,
  };
}

const DAY_MS = 86_400_000;

/** Document vector (`coalesce(content_embedding, embedding)`), L2-normalized, for scoring U. */
async function loadDocVectors(
  db: Database,
  ids: readonly number[],
): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    for (const r of await db.execute<{ id: number; vec: string }>(sql`
      select document_id as id, coalesce(content_embedding, embedding)::text as vec
      from doc_text where document_id = any(${`{${chunk.join(",")}}`}::bigint[])`)) {
      const v = JSON.parse(r.vec) as number[];
      const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
      out.set(
        Number(r.id),
        v.map((x) => x / n),
      );
    }
  }
  return out;
}

/**
 * The two floors of the ranking run (feed and notification) share one pool: the percentile of score S in the profile's pool over [end − 30 days, end) (excluding
 * the day being ranked), dropping already-sent items (`not_new`, N = 0) from both the percentile and n. The "fixed" mode does not read the pool.
 *
 * SCORE SCALE NOTE (10/11/2026): old pool rows have S computed with the formula from before U existed (factor ×1.0, no U part),
 * new rows use the 0.9× + 0.10·U formula. The two scales are mixed within the 30-day window and are NOT
 * rescaled. During the first 14 days of the pool (`FLOOR_MIN_DAYS`), the fixed floor 0,59 is still used under the existing mechanism;
 * the floor logic does not change because of U.
 */
async function resolveFloors(
  db: Database,
  profileId: number,
  period: RankPeriod,
  config: RankConfig,
): Promise<{ feed: FloorResult; notify: FloorResult }> {
  const fixed: FloorResult = { value: config.floorS, source: "fixed", days: 0 };
  if (config.floorMode === "fixed") return { feed: fixed, notify: fixed };
  let rows: Awaited<ReturnType<typeof readCandidateScores>>;
  try {
    rows = await readCandidateScores(db, {
      profileId,
      from: new Date(period.end.getTime() - FLOOR_WINDOW_DAYS * DAY_MS),
      to: period.end,
    });
  } catch (err) {
    // The pool is auxiliary data: if reading it fails, use the fixed floor; this does not block ranking or sending.
    log.warn("không đọc được bể ứng viên, dùng sàn cố định", {
      profileId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return { feed: fixed, notify: fixed };
  }
  const days = new Set(rows.map((r) => r.periodEnd.getTime())).size;
  const scores = rows.filter((r) => r.rejectReason !== "not_new" && r.n !== 0).map((r) => r.score);
  return {
    // Feed floor: target ~30 items/day; if n ≤ the target (q clamped = 0), no floor filtering.
    feed: percentileFloor({
      scores,
      days,
      fixed: config.floorS,
      targetPerDay: config.feedFloorTargetPerDay,
      noFilterAtZeroQ: true,
    }),
    // Notification floor: same as the existing percentile floor (~12 items/day).
    notify: percentileFloor({
      scores,
      days,
      fixed: config.floorS,
      targetPerDay: config.notify.floorTargetPerDay,
    }),
  };
}

/**
 * Events with R in the gate's grey zone, with the topic and document that gave R, to ask the decision model. Skips
 * already-sent items with nothing new (N = 0): they are dropped anyway, so asking would only cost money.
 */
function grayZone(
  evs: readonly { event: RankEvent; c: Components }[],
  cfg: RankConfig,
): GateCandidate[] {
  const out: GateCandidate[] = [];
  for (const { event, c } of evs) {
    if (!needsDecision(c.R, cfg) || c.N === 0) continue;
    if (c.topicId === null || c.documentId === null) continue;
    out.push({ event, R: c.R, topicId: c.topicId, documentId: c.documentId });
  }
  return out;
}
