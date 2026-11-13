/**
 * Simulates the selection probability of each item (p_i) and each item pair (p_ij) under noisy selection
 * Gumbel. Runs the REAL `select` function many times with fresh noise each time: no smoothing, no
 * approximation, so the same function serves production and simulation.
 */
import { mulberry32 } from "./eval/bootstrap.ts";
import { type RankConfig, type RankEvent, type Scored, type Selection, select } from "./ranking.ts";
import { cosine } from "./vector.ts";

export interface SimulateOptions {
  /** Number of Monte Carlo runs (default 10,000). */
  runs?: number;
  /** Seed: the same seed gives the same result. */
  seed: number;
  /** Items of interest; default all events in `scored`. Items outside this set are not counted. */
  focusEventIds?: readonly number[];
  /** Similarity between two events; default the cosine between centers (computed once for the whole simulation). */
  sim?: (a: RankEvent, b: RankEvent) => number;
  /**
   * From one `select` result, the events counted as "picked" (default: every `picked` item).
   * The feed flow passes the notification layer (first ≤ 7 items of the snapshot) so that p_i, p_ij are the probability of being
   * SENT, matching what was actually sent; the function must be pure (depend only on the selection result).
   */
  chosen?: (selection: Selection) => readonly number[];
}

export interface InclusionResult {
  seed: number;
  runs: number;
  /** p̂_i: fraction of runs in which item i was picked. */
  selectionProb: Map<number, number>;
  /** p̂_ij, key `"i:j"` with i < j: fraction of runs in which BOTH items were picked. */
  pairProb: Map<string, number>;
}

/** Ordered pair key: i < j. */
export function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Similarity matrix computed once for all pairs; returns a lookup function for `select`. */
function cachedSimilarity(
  scored: readonly Scored[],
  baseSim: (a: RankEvent, b: RankEvent) => number,
): (a: RankEvent, b: RankEvent) => number {
  const index = new Map<number, number>();
  scored.forEach((s, i) => {
    index.set(s.event.eventId, i);
  });
  const n = scored.length;
  const matrix = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = scored[i];
      const b = scored[j];
      if (!a || !b) continue;
      const v = baseSim(a.event, b.event);
      matrix[i * n + j] = v;
      matrix[j * n + i] = v;
    }
  }
  return (a, b) => {
    const i = index.get(a.eventId);
    const j = index.get(b.eventId);
    if (i === undefined || j === undefined || i === j) return baseSim(a, b);
    return matrix[i * n + j] ?? 0;
  };
}

function bump<K>(m: Map<K, number>, k: K) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

export function simulateInclusion(
  scored: readonly Scored[],
  cfg: RankConfig,
  opts: SimulateOptions,
): InclusionResult {
  const runs = opts.runs ?? 10_000;
  const rng = mulberry32(opts.seed);
  const sim = cachedSimilarity(scored, opts.sim ?? ((a, b) => cosine(a.centroid, b.centroid)));
  const ids = [...new Set(opts.focusEventIds ?? scored.map((s) => s.event.eventId))];
  const focus = new Set(ids);
  const single = new Map<number, number>(ids.map((id) => [id, 0]));
  const pair = new Map<string, number>();
  for (const [x, a] of ids.entries()) for (const b of ids.slice(x + 1)) pair.set(pairKey(a, b), 0);

  for (let r = 0; r < runs; r++) {
    const selection = select(scored, cfg, sim, rng);
    const chosen = (
      opts.chosen ? opts.chosen(selection) : selection.picked.map((p) => p.event.eventId)
    ).filter((id) => focus.has(id));
    for (const [x, a] of chosen.entries()) {
      bump(single, a);
      for (const b of chosen.slice(x + 1)) bump(pair, pairKey(a, b));
    }
  }

  const selectionProb = new Map([...single].map(([k, v]) => [k, v / runs]));
  const pairProb = new Map([...pair].map(([k, v]) => [k, v / runs]));
  return { seed: opts.seed, runs, selectionProb, pairProb };
}

/** Default cap on the inverse-probability weight. */
export const DEFAULT_WEIGHT_CAP = 20;

/**
 * weight = min(1 / p̂, cap): CLIPS at the cap, no smoothing. When p̂ = 0 (a pair never observed
 * in the simulation), 1/p̂ is infinite, so it returns exactly `cap`, the largest allowed weight; not dropped.
 */
export function inverseProbWeight(p: number, cap = DEFAULT_WEIGHT_CAP): number {
  return p > 0 ? Math.min(1 / p, cap) : cap;
}

/**
 * The simulation seed is derived from the selection seed (pure function): knowing the selection seed lets you reproduce
 * the simulation seed, so only one number needs saving. It differs from the selection seed so that the simulation's
 * random stream does not coincide with the stream of the real selection.
 */
export function deriveSimSeed(selectSeed: number): number {
  return (Math.imul((selectSeed ^ 0x5bd1e995) >>> 0, 0x9e3779b1) ^ 0x85ebca6b) >>> 0;
}

/**
 * ln P of the ordered list `order` (indices into `scores`) under the Plackett–Luce model with
 * logit = S / T (mo-hinh-de-xuat.html, Gumbel top-k tab): each step = chosen logit − logsumexp
 * of the remaining items. It is an APPROXIMATION of the real selection: it ignores the MMR penalty, the per-source reserved slots and the per-source
 * cap; the spec keeps it only for offline evaluation of the whole list (IPW uses p_ij, not logP).
 * With T ≤ 0 there is no distribution: returns null.
 */
export function orderedListLogProb(
  scores: readonly number[],
  order: readonly number[],
  temperature: number,
): number | null {
  if (!(temperature > 0)) return null;
  const logits = scores.map((s) => s / temperature);
  const left = new Set(logits.keys());
  let logP = 0;
  for (const i of order) {
    const li = logits[i];
    if (li === undefined || !left.has(i)) return null;
    const m = Math.max(...[...left].map((j) => logits[j] ?? Number.NEGATIVE_INFINITY));
    let sum = 0;
    for (const j of left) sum += Math.exp((logits[j] ?? 0) - m);
    logP += li - (m + Math.log(sum));
    left.delete(i);
  }
  return logP;
}
