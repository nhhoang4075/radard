/**
 * Digest ranking: pure functions, no DB or network reads (design: docs/xep-hang.html).
 *
 * Every score component is scaled to 0–1 by comparing it with the BASELINE of its own source (and topic
 * ): the median maps to 0 (normal, like any post), the top-0.1% mark maps to 1 (rare).
 */
import { type InterestCluster, interestScore } from "./interest.ts";
import { cosine } from "./vector.ts";

/** Baseline of one signal: median, top-0.1% mark, and the number of samples used to compute it. */
export interface Baseline {
  median: number;
  p999: number;
  n: number;
}

/**
 * Linear-interpolated percentile, same as Postgres `percentile_cont`: position (n − 1) × p in the
 * ascending-sorted array, interpolating between the two adjacent elements. `sorted` must already be sorted.
 */
export function percentileCont(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

/** Baseline from any array of values. */
export function baselineOf(values: readonly number[]): Baseline {
  const sorted = [...values].sort((x, y) => x - y);
  return {
    median: percentileCont(sorted, 0.5),
    p999: percentileCont(sorted, 0.999),
    n: sorted.length,
  };
}

/**
 * Blending constant: this many samples are needed before the source's own baseline counts for half.
 * The 0.1% mark of n samples is the (n/1,000)-th highest, so below ~1,000 samples it is simply the highest sample.
 */
export const BLEND_K = 1000;

/**
 * Blends the source's own baseline with the global baseline, with w = n / (n + 1000), applied to both the median
 * and the 0.1% mark. A new source (n = 0) uses the global baseline entirely, then shifts gradually, with no breakpoint.
 */
export function blendBaseline(own: Baseline | undefined, global: Baseline | undefined): Baseline {
  if (!own) {
    if (!global) throw new Error("không có mặt bằng nào để chuẩn hoá");
    return global;
  }
  if (!global) return own;
  const w = own.n / (own.n + BLEND_K);
  return {
    median: w * own.median + (1 - w) * global.median,
    p999: w * own.p999 + (1 - w) * global.p999,
    n: own.n,
  };
}

/** Clamps x into [lo, hi]. */
export function clamp(x: number, lo = 0, hi = 1): number {
  return Math.min(hi, Math.max(lo, x));
}

/** z = clamp((x − median) / (0.1% mark − median)): 0 = normal, 1 = rare. */
export function normalize(x: number, b: Baseline): number {
  const span = b.p999 - b.median;
  if (!(span > 0)) return x > b.median ? 1 : 0;
  return clamp((x - b.median) / span);
}

// ---------------------------------------------------------------------------------------------
// Six components and the score S (xep-hang.html tab 04)

/** One document of the event, with enough information to score it. */
export interface RankDoc {
  documentId: number;
  sourceId: number;
  urlCanonical: string;
  /** Cosine with each enabled topic (`profile_topic_id` → score). */
  topicScores: ReadonlyMap<number, number>;
  /**
   * Raw engagement computed by the source adapter (`SourceAdapter.engagement`), additive. `null`: the source
   * has no signal (arXiv, releases), or the signal could not be fetched yet.
   */
  engagement: number | null;
  /**
   * Whole-document vector (L2-normalized) for the taste score U; if absent, the document does not contribute to U.
   * Only needs to be loaded when there are active taste clusters.
   */
  vector?: readonly number[];
}

export interface RankEvent {
  eventId: number;
  title: string;
  firstSeenAt: Date;
  centroid: readonly number[];
  docs: readonly RankDoc[];
}

/** Baseline pre-looked-up from the `baselines` table. */
export interface Baselines {
  /** By (source, topic) and the topic's global baseline (source key `null`). */
  relevance(sourceId: number | null, topicId: number): Baseline | undefined;
  engagement(sourceId: number): Baseline | undefined;
  coverage(): Baseline | undefined;
}

export interface RankConfig {
  weights: { R: number; P: number; C: number; A: number; F: number; U: number };
  /**
   * Gate: only events with R ≥ this threshold are considered ("does it belong to your topics?"). Events with R in the
   * `decision` zone are asked of the decision model instead of this rule; the rule is only used when the model cannot be asked.
   */
  gateR: number;
  /**
   * Gate gray zone: R ∈ [low, high) asks the decision model "is this item mainly about the topic or not", with
   * probability ≥ `minP` passing. R ≥ high always passes, R < low is always rejected.
   */
  decision: { low: number; high: number; minP: number };
  /** Floor: do not take items with S below this, even if the count is not met ("is it worth reading at all?"). */
  floorS: number;
  /**
   * Floor source: "fixed" always uses `floorS`; "percentile" uses the 30-day percentile (floor.ts) when the
   * pool has 14 days of data, and still uses `floorS` before that.
   */
  floorMode: "fixed" | "percentile";
  /** Engagement contributed by a source with no signal (fixed on 12/10/2026: 0.3). */
  neutralP: number;
  /** F when the event started before the digest window but has new items now. */
  followUpF: number;
  /**
   * Builds taste clusters from 👍 items (interest.ts). `distanceThreshold` is the Ward τ (measured 10/11/2026 on real
   * 👍 items; the project owner approved τ = 1.4). Each parameter here is passed straight down to `clusterInterests`.
   */
  interest: {
    distanceThreshold: number;
    maxClusters: number;
    minMembers: number;
    halfLifeDays: number;
    dropBelowWeight: number;
    nameCarryMinCosine: number;
  };
  /**
   * Caps used by `select`: maximum number of items and maximum items per source. The real flow (`rankPeriod`) sets these
   * two values to `feedMaxItems` / `feedMaxPerSource` when building the feed snapshot.
   */
  maxItems: number;
  maxPerSource: number;
  /**
   * Web feed (decision 10/11/2026): `select` runs ONCE with the cap K = `feedMaxItems` (a cap, not a target:
   * stop when no items reach the floor) and at most `feedMaxPerSource` items per source.
   */
  feedMaxItems: number;
  feedMaxPerSource: number;
  /** Items/day the feed's percentile floor targets (separate from the notification floor). */
  feedFloorTargetPerDay: number;
  /**
   * Notification layer (Telegram): takes at most `notify.maxItems` items FROM THE START of the snapshot with S ≥ the notification floor,
   * at most `notify.maxPerSource` per source ("5 of the first 7 items"); the notification floor targets
   * `notify.floorTargetPerDay` items/day. Does not affect feed selection.
   */
  notify: { maxItems: number; maxPerSource: number; floorTargetPerDay: number };
  /** Duplicate penalty: starts at similarity `start`, reaching at most `max` at `start + span`. */
  mmr: { start: number; span: number; max: number };
  /**
   * Temperature T of Gumbel top-k selection: the selection key is S + T·G (G ~ Gumbel(0,1)). T = 0: deterministic
   * selection as before. The gate, floor and already-sent filtering always use the true S, without noise.
   */
  temperature: number;
  /** Source reputation (A), 0–1, from `sources.trust_score`. */
  priors: ReadonlyMap<number, number>;
}

/** Cap K of the feed snapshot and per-source cap of the feed (decision 10/11/2026). */
const FEED_MAX_ITEMS = 30;
const FEED_MAX_PER_SOURCE = 10;

/** Starting constants (xep-hang.html), not yet validated: retune after the first week using 👍/👎. */
export const DEFAULT_RANK_CONFIG: Omit<RankConfig, "priors"> = {
  // Approved 10/11/2026: old weights (0.40/0.25/0.15/0.10/0.10) multiplied by 0.9, plus w_U = 0.10; sum = 1.
  // Re-normalizing L1 after the weekly fit is a later task.
  weights: { R: 0.36, P: 0.225, C: 0.135, A: 0.09, F: 0.09, U: 0.1 },
  interest: {
    distanceThreshold: 1.4,
    maxClusters: 6,
    minMembers: 3,
    halfLifeDays: 60,
    dropBelowWeight: 0.1,
    // A new cluster inherits an old cluster's name only when the centers' cosine >= this level. 0.8 = the implementer's
    // choice (the spec requires a level but gives none yet, not measured): close enough to count as "same taste".
    nameCarryMinCosine: 0.8,
  },
  gateR: 0.6,
  // Measured 13–16/10/2026 on real items with R in [0.5, 0.7): Jev at threshold 0.6 matches the reference labels
  // 84%, the old rule (R ≥ 0.6) only 53%; the project owner has confirmed the reference labels.
  decision: { low: 0.5, high: 0.7, minP: 0.6 },
  floorS: 0.59,
  floorMode: "percentile",
  neutralP: 0.3,
  followUpF: 0.6,
  // The real flow's `select` runs with the feed cap (rankPeriod is set from feedMaxItems/feedMaxPerSource).
  maxItems: FEED_MAX_ITEMS,
  maxPerSource: FEED_MAX_PER_SOURCE,
  // Web feed (decision 10/11/2026): K = 30 is a cap, not a target; 10 items/source is a guessed default,
  // not measured. The feed floor targets ~30 items/day, and uses percentiles only after FLOOR_MIN_DAYS days of pool data.
  feedMaxItems: FEED_MAX_ITEMS,
  feedMaxPerSource: FEED_MAX_PER_SOURCE,
  feedFloorTargetPerDay: 30,
  // Notification layer: 7 items like the old digest; 5 items/source (3 made the 12/10 digest only 4 items even though 5 HN items
  // passed the floor; raised to 5, fixed 13/10/2026); the floor targets ~12 items/day like the existing percentile floor.
  notify: { maxItems: 7, maxPerSource: 5, floorTargetPerDay: 12 },
  mmr: { start: 0.85, span: 0.1, max: 0.3 },
  // Temperature T of Gumbel top-k selection. 0.03 approved by the project owner 10/11/2026 (not yet measured on a real pool).
  // Retune after the first week with a pool, against the criteria: p̂ ≥ 0.05 for the top 12 and mean p̂ of the 7
  // sent items ≥ ~0.5. T > 0 needs an rng injected from outside with a seed; for trial runs set T = 0 or pass a seed.
  temperature: 0.03,
};

export interface Components {
  R: number;
  P: number;
  C: number;
  A: number;
  F: number;
  /** Taste score: 0 when there are no active clusters (or no document vector). */
  U: number;
  N: number;
  /** Topic with the highest R: the "why chosen" reason shown in the digest. */
  topicId: number | null;
  /** Source of the document with the highest R: used for reservations and per-source quotas. */
  sourceId: number;
  /** Document with the highest R: given to the decision model when R falls in the gate's gray zone. */
  documentId: number | null;
}

/**
 * Computes the six components of one event.
 *
 * `periodStart`: start of the digest window (24 hours ago). `sentUrls`: `url_canonical` of every document already
 * in sent items, no time limit (`deliveries.document_ids`), to compute N.
 * `interests`: the profile's active taste clusters (interest.ts); absent or empty means U = 0. The event's U is the
 * largest U over the documents that have vectors.
 */
export function components(
  ev: RankEvent,
  base: Baselines,
  cfg: RankConfig,
  periodStart: Date,
  sentUrls: ReadonlySet<string>,
  interests: readonly InterestCluster[] = [],
): Components {
  const r = relevanceOf(ev, base);
  return {
    R: r.R,
    P: popularityOf(ev, base, cfg.neutralP),
    C: coverageOf(ev, base),
    A: Math.max(0, ...ev.docs.map((d) => cfg.priors.get(d.sourceId) ?? 0.5)),
    F: ev.firstSeenAt >= periodStart ? 1 : cfg.followUpF,
    U: tasteOf(ev, interests),
    N: noveltyOf(ev, sentUrls),
    topicId: r.topicId,
    sourceId: r.sourceId,
    documentId: r.documentId,
  };
}

/** U: the largest `interestScore` over documents with vectors; 0 when there are no active clusters. */
function tasteOf(ev: RankEvent, interests: readonly InterestCluster[]): number {
  let u = 0;
  for (const d of ev.docs) if (d.vector) u = Math.max(u, interestScore(d.vector, interests));
  return u;
}

/** R: the largest over all (document, topic) pairs, after normalizing by the baseline of the source × topic. */
function relevanceOf(ev: RankEvent, base: Baselines) {
  let best = {
    R: 0,
    topicId: null as number | null,
    sourceId: ev.docs[0]?.sourceId ?? 0,
    documentId: null as number | null,
  };
  for (const d of ev.docs) {
    for (const [t, score] of d.topicScores) {
      const own = base.relevance(d.sourceId, t);
      const global = base.relevance(null, t);
      if (!own && !global) continue;
      const z = normalize(score, blendBaseline(own, global));
      if (z > best.R || best.topicId === null)
        best = { R: z, topicId: t, sourceId: d.sourceId, documentId: d.documentId };
    }
  }
  return best;
}

/**
 * P: each SOURCE present in the event contributes one value; P is the maximum (decision 13/10).
 *   - source with a signal: sum the engagement of that source's documents (5 reposts = 5 groups of people
 *     paying attention), take ln, normalize by the baseline of that SAME source;
 *   - source without a signal (or not fetched yet): neutral.
 * No source is special-cased; a measurable source being mentioned (even with low engagement) never lowers P
 * compared with it not being mentioned.
 */
function popularityOf(ev: RankEvent, base: Baselines, neutralP: number): number {
  const bySource = new Map<number, number | null>();
  for (const d of ev.docs) {
    const prev = bySource.get(d.sourceId) ?? null;
    bySource.set(d.sourceId, d.engagement === null ? prev : (prev ?? 0) + d.engagement);
  }
  let P = 0;
  for (const [s, sum] of bySource) {
    const b = sum === null ? undefined : base.engagement(s);
    P = Math.max(P, sum === null || !b ? neutralP : normalize(Math.log1p(sum), b));
  }
  return P;
}

/** C: number of DISTINCT ARTICLES (URLs), reposts not counted; independent sources reporting the same story are rewarded. */
function coverageOf(ev: RankEvent, base: Baselines): number {
  const urls = new Set(ev.docs.map((d) => d.urlCanonical)).size;
  const nSources = new Set(ev.docs.map((d) => d.sourceId)).size;
  const cov = base.coverage();
  return cov ? normalize(Math.log1p(urls) + 0.5 * (nSources - 1), cov) : 0;
}

/**
 * N: already sent with nothing new → dropped (0); with new items, reduced by the proportion already sent. "New" is judged by
 * canonical URL, not by document: an HN post re-sharing an arXiv paper already sent is a new document
 * but not a new item (decision 09/11/2026, the Next-Concept Modeling case sent 3 times).
 */
function noveltyOf(ev: RankEvent, sentUrls: ReadonlySet<string>): number {
  const urls = new Set(ev.docs.map((d) => d.urlCanonical));
  const sent = [...urls].filter((u) => sentUrls.has(u)).length;
  if (sent === 0) return 1;
  const fresh = (urls.size - sent) / Math.max(1, urls.size);
  return fresh === 0 ? 0 : 0.5 + 0.5 * fresh;
}

/** S = N × (0.36·R + 0.225·P + 0.135·C + 0.09·A + 0.09·F + 0.10·U) (approved 10/11/2026). */
export function scoreOf(c: Components, cfg: Pick<RankConfig, "weights">): number {
  const w = cfg.weights;
  return c.N * (w.R * c.R + w.P * c.P + w.C * c.C + w.A * c.A + w.F * c.F + w.U * c.U);
}

// ---------------------------------------------------------------------------------------------
// Select ≤ 7 items (xep-hang.html tab 06)

export interface Scored {
  event: RankEvent;
  c: Components;
  S: number;
  /**
   * The decision model's answer for the gate (R in the gray zone): `true` passes, `false` rejects. Absent
   * when not asked (R outside the gray zone) or the model could not be asked: then the rule R ≥ `gateR` is used.
   */
  gate?: boolean;
}

export interface Rejected {
  event: RankEvent;
  c: Components;
  S: number;
  /** `decision_reject`: R in the gray zone and the decision model answered "not about the topic". */
  reason: "gate" | "decision_reject" | "floor" | "not_new" | "source_cap" | "not_picked";
}

export interface Selection {
  picked: (Scored & { penalty: number; reserved: boolean })[];
  rejected: Rejected[];
}

/** Duplicate penalty: 0 when similar below `start`, rising linearly to `max` when similarity ≥ `start + span`. */
export function mmrPenalty(maxSim: number, mmr: RankConfig["mmr"]): number {
  return mmr.max * clamp((maxSim - mmr.start) / mmr.span);
}

/** Gumbel(0,1) noise from a number U ∈ [0,1): −ln(−ln U), U clamped into (ε, 1−ε) to avoid infinities. */
export function gumbelNoise(u: number): number {
  const eps = 1e-12;
  const x = Math.min(1 - eps, Math.max(eps, u));
  return -Math.log(-Math.log(x));
}

/**
 * Selects items: gate R, floor S, drop already-sent items with nothing new; reserve one slot for each source that has
 * candidates above the floor; the rest are chosen one at a time by key minus the duplicate penalty against the already-chosen
 * items (MMR, Carbonell & Goldstein 1998), at most `maxPerSource` items per source. The result is sorted by S − penalty.
 *
 * The selection key is S when `cfg.temperature` = 0 (deterministic, does not call `rng`); when T > 0 it is S + T·G with
 * G ~ Gumbel(0,1) drawn ONCE per pool candidate on each call, used for both the reservation step
 * and the MMR step (Gumbel top-k). The noisy key only decides which items enter the list; the returned duplicate penalty
 * and the result order still use the true S. `rng` returns a number in [0,1); T > 0 without `rng` is an error.
 */
export function select(
  scored: readonly Scored[],
  cfg: RankConfig,
  sim: (a: RankEvent, b: RankEvent) => number = (a, b) => cosine(a.centroid, b.centroid),
  rng?: () => number,
): Selection {
  const { pool, rejected } = screen(scored, cfg);
  const noisy = cfg.temperature > 0;
  if (noisy && !rng) throw new Error("temperature > 0 cần rng");
  const keyOf = new Map<Scored, number>();
  for (const s of pool)
    keyOf.set(s, noisy && rng ? s.S + cfg.temperature * gumbelNoise(rng()) : s.S);
  // Pool already sorted by S; re-sort by key (stable sort; T = 0 keeps the old order).
  const order = noisy ? [...pool].sort((a, b) => (keyOf.get(b) ?? 0) - (keyOf.get(a) ?? 0)) : pool;
  const picked: Selection["picked"] = [];
  const perSource = new Map<number, number>();
  const take = (s: Scored, penalty: number, reserved: boolean) => {
    picked.push({ ...s, penalty, reserved });
    perSource.set(s.c.sourceId, (perSource.get(s.c.sourceId) ?? 0) + 1);
  };
  const isPicked = (s: Scored) => picked.some((p) => p.event.eventId === s.event.eventId);

  // Reservation: the highest-key item of each source (order is sorted by key, so the first encountered is the best).
  const seen = new Set<number>();
  for (const s of order) {
    if (picked.length >= cfg.maxItems) break;
    if (seen.has(s.c.sourceId)) continue;
    seen.add(s.c.sourceId);
    take(s, 0, true);
  }

  // Remainder: one item at a time, by key minus the duplicate penalty against the already-chosen item it most resembles.
  while (picked.length < cfg.maxItems) {
    const open = order.filter(
      (s) => !isPicked(s) && (perSource.get(s.c.sourceId) ?? 0) < cfg.maxPerSource,
    );
    const best = bestByPenalizedScore(open, picked, cfg, sim, (s) => keyOf.get(s) ?? s.S);
    if (!best) break;
    take(best.s, best.penalty, false);
  }

  for (const s of pool.filter((x) => !isPicked(x))) {
    const capped = (perSource.get(s.c.sourceId) ?? 0) >= cfg.maxPerSource;
    rejected.push({ ...s, reason: capped ? "source_cap" : "not_picked" });
  }
  // Sorted by the score AFTER penalty, not by S: sorting by S would put a penalized duplicate (e.g. two Nvidia items)
  // right next to the item it duplicates, exactly what the penalty step is meant to avoid.
  picked.sort((a, b) => b.S - b.penalty - (a.S - a.penalty));
  return { picked, rejected };
}

/** R in the gate's gray zone: the decision model must be asked. */
export function needsDecision(R: number, cfg: Pick<RankConfig, "decision">): boolean {
  return R >= cfg.decision.low && R < cfg.decision.high;
}

/** Passes the gate: by the decision model's answer if present, otherwise R ≥ `gateR`. */
export function passesGate(
  s: { c: Pick<Components, "R">; gate?: boolean },
  cfg: Pick<RankConfig, "gateR">,
): boolean {
  return s.gate ?? s.c.R >= cfg.gateR;
}

/** Gate (R or decision model), already-sent items with nothing new, floor S; the rest sorted by S. */
function screen(scored: readonly Scored[], cfg: RankConfig) {
  const rejected: Rejected[] = [];
  const pool: Scored[] = [];
  for (const s of scored) {
    if (!passesGate(s, cfg))
      rejected.push({ ...s, reason: s.gate === false ? "decision_reject" : "gate" });
    else if (s.c.N === 0) rejected.push({ ...s, reason: "not_new" });
    else if (s.S < cfg.floorS) rejected.push({ ...s, reason: "floor" });
    else pool.push(s);
  }
  pool.sort((a, b) => b.S - a.S);
  return { pool, rejected };
}

function bestByPenalizedScore(
  open: readonly Scored[],
  picked: readonly Scored[],
  cfg: RankConfig,
  sim: (a: RankEvent, b: RankEvent) => number,
  keyOf: (s: Scored) => number,
) {
  let best: { s: Scored; penalty: number; value: number } | null = null;
  for (const s of open) {
    const maxSim = Math.max(...picked.map((p) => sim(s.event, p.event)));
    const penalty = mmrPenalty(maxSim, cfg.mmr);
    const value = keyOf(s) - penalty;
    if (!best || value > best.value) best = { s, penalty, value };
  }
  return best;
}
