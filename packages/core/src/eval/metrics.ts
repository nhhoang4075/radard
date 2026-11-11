/** Ranking metrics: per-day NDCG and pairwise accuracy. Pure functions. */
import { type EvalSample, gainOf } from "./types.ts";

/**
 * Order of ranked variants: descending score; equal scores by send position (smaller first), so the result
 * is deterministic. Does not mutate the input array.
 */
export function rankSamples(
  samples: readonly EvalSample[],
  scores: readonly number[],
): EvalSample[] {
  return samples
    .map((s, i) => ({ s, score: scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.s.position - b.s.position)
    .map((x) => x.s);
}

/** DCG = Σ gain_i / log2(i + 1), i starts at 1 (here the array index k = i − 1, so log2(k + 2)). */
export function dcg(gains: readonly number[]): number {
  let sum = 0;
  for (let k = 0; k < gains.length; k++) sum += (gains[k] ?? 0) / Math.log2(k + 2);
  return sum;
}

/** NDCG = DCG / DCG of the ideal order (gains descending). A day with all gains 0 returns 0. */
export function ndcg(gainsInRankedOrder: readonly number[]): number {
  const ideal = dcg([...gainsInRankedOrder].sort((a, b) => b - a));
  return ideal > 0 ? dcg(gainsInRankedOrder) / ideal : 0;
}

/** NDCG of one day when the variant gives `scores[i]` to `samples[i]`. */
export function ndcgOfDay(samples: readonly EvalSample[], scores: readonly number[]): number {
  return ndcg(rankSamples(samples, scores).map(gainOf));
}

/** Number of pairs with different levels, and number of pairs the variant orders correctly (ties count 0.5). */
export interface PairCount {
  pairs: number;
  correct: number;
}

export interface PairwiseResult {
  /** Clean pair: one 👍 item with one 👎 item. */
  clean: PairCount;
  /** All pairs with different levels (including clean pairs). */
  all: PairCount;
}

export const emptyPairwise = (): PairwiseResult => ({
  clean: { pairs: 0, correct: 0 },
  all: { pairs: 0, correct: 0 },
});

/** Sums the pairwise results of several days. */
export function addPairwise(a: PairwiseResult, b: PairwiseResult): PairwiseResult {
  return {
    clean: { pairs: a.clean.pairs + b.clean.pairs, correct: a.clean.correct + b.clean.correct },
    all: { pairs: a.all.pairs + b.all.pairs, correct: a.all.correct + b.all.correct },
  };
}

/** 1 if the higher-level item has the higher score, 0.5 if equal, 0 if reversed. */
const pairOutcome = (scoreHigher: number, scoreLower: number): number =>
  scoreHigher > scoreLower ? 1 : scoreHigher === scoreLower ? 0.5 : 0;

/** Pairwise accuracy within ONE day. */
export function pairwiseOfDay(
  samples: readonly EvalSample[],
  scores: readonly number[],
): PairwiseResult {
  const out = emptyPairwise();
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const a = samples[i];
      const b = samples[j];
      if (!a || !b || a.level === b.level) continue;
      const si = scores[i] ?? 0;
      const sj = scores[j] ?? 0;
      const ok = gainOf(a) > gainOf(b) ? pairOutcome(si, sj) : pairOutcome(sj, si);
      out.all.pairs += 1;
      out.all.correct += ok;
      if (a.level !== "none" && b.level !== "none") {
        out.clean.pairs += 1;
        out.clean.correct += ok;
      }
    }
  }
  return out;
}

/** Ratio correct; NaN when there are no pairs. */
export const pairAccuracy = (c: PairCount): number =>
  c.pairs === 0 ? Number.NaN : c.correct / c.pairs;
