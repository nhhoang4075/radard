/** Day-level bootstrap resampling with a seeded PRNG: same data, same numbers. */
import { percentileCont } from "../ranking.ts";

/** Fixed resample count and seed of the scorer: changing these two numbers changes the measurement. */
export const BOOTSTRAP_B = 2000;
export const BOOTSTRAP_SEED = 20261110;

/** mulberry32: 32-bit PRNG returning a number in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MeanInterval {
  mean: number;
  /** Lower / upper bounds of the 95% confidence interval (2.5% and 97.5% percentiles of resampled means). */
  lo: number;
  hi: number;
  /** Number of days. */
  n: number;
}

export const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;

/** 95% confidence interval of the mean of `diffs` (one number per day), resampling days with replacement. */
export function bootstrapMean(
  diffs: readonly number[],
  b = BOOTSTRAP_B,
  seed = BOOTSTRAP_SEED,
): MeanInterval {
  const n = diffs.length;
  if (n === 0) return { mean: Number.NaN, lo: Number.NaN, hi: Number.NaN, n };
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let k = 0; k < b; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += diffs[Math.floor(rand() * n)] ?? 0;
    means.push(sum / n);
  }
  means.sort((x, y) => x - y);
  return {
    mean: mean(diffs),
    lo: percentileCont(means, 0.025),
    hi: percentileCont(means, 0.975),
    n,
  };
}

export type Verdict = "win" | "tie" | "lose";

/** "Wins" only when the LOWER bound > 0; "loses" when the upper bound < 0; otherwise a tie within noise. */
export function verdictOf(ci: Pick<MeanInterval, "lo" | "hi">): Verdict {
  if (ci.lo > 0) return "win";
  if (ci.hi < 0) return "lose";
  return "tie";
}
