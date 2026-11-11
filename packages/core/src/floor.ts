/**
 * Percentile-based score floor (approved 10/11/2026): floor = the q-th percentile of the S scores of the events passing the gate in the
 * last 30 days, with q = 1 − 12/n (n = average number of events passing the gate per day), so about 12 items/day
 * clear the floor; on quiet days fewer items. Before 14 days of data exist, use the fixed floor.
 * Note (10/11/2026): S values in the pool from before the taste score U existed use the old formula (no U, factor ×1.0),
 * then the new formula (0.9× + 0.10·U); the 30-day window mixes the two scales, old data is not modified.
 * Pure function: reading the pool and filtering rows happen in `apps/daemon/src/jobs/rank.ts`.
 */
import { percentileCont } from "./ranking.ts";

/** Number of items per day that the floor targets. */
export const FLOOR_TARGET_PER_DAY = 12;
/** Score window: [end − 30 days, end). */
export const FLOOR_WINDOW_DAYS = 30;
/** Minimum number of days with data to use percentiles; below this, use the fixed floor. */
export const FLOOR_MIN_DAYS = 14;
/** Clamps q to [0, 0.99]. n ≤ 12 gives q ≤ 0 (floor = lowest score, no further filtering); 0.99 caps q → 1. */
export const FLOOR_MAX_Q = 0.99;

export type FloorSource = "percentile" | "fixed";

export interface FloorResult {
  value: number;
  source: FloorSource;
  /** Only present when the source is a percentile. */
  q?: number;
  /** Average number of events passing the gate per day; only present when the source is a percentile. */
  n?: number;
  /** Number of days with data in the window. */
  days: number;
}

/**
 * @param scores S scores (before penalty) of the events passing the gate in the window, with already-sent items removed
 * @param days number of distinct days with data in the window
 * @param fixed fixed floor, used when there are not enough days or no scores
 */
export function percentileFloor(args: {
  scores: readonly number[];
  days: number;
  fixed: number;
  minDays?: number;
  targetPerDay?: number;
  maxQ?: number;
  /**
   * Feed floor (decision 10/11/2026): when n ≤ target, q clamps to 0, meaning NO filtering by floor
   * (value 0; S is always ≥ 0), instead of taking the lowest score in the window. The notification floor keeps the old method.
   */
  noFilterAtZeroQ?: boolean;
}): FloorResult {
  const { scores, days, fixed } = args;
  const minDays = args.minDays ?? FLOOR_MIN_DAYS;
  if (days < minDays || scores.length === 0) return { value: fixed, source: "fixed", days };
  const n = scores.length / days;
  const target = args.targetPerDay ?? FLOOR_TARGET_PER_DAY;
  const q = Math.min(Math.max(1 - target / n, 0), args.maxQ ?? FLOOR_MAX_Q);
  if (q === 0 && args.noFilterAtZeroQ) return { value: 0, source: "percentile", q, n, days };
  const sorted = [...scores].sort((a, b) => a - b);
  return { value: percentileCont(sorted, q), source: "percentile", q, n, days };
}
