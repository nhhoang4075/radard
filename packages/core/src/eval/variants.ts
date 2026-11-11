/**
 * Scoring variants. Adding a variant = adding an object (via `defineVariant`); do not edit the
 * scorer.
 */
import { mulberry32 } from "./bootstrap.ts";
import { type EvalDay, type EvalSample, gainOf } from "./types.ts";

export interface Variant<P = undefined> {
  name: string;
  /**
   * Optional: learn parameters on the training days. The scorer only passes normal days, never
   * locked days.
   */
  fit?: (trainDays: readonly EvalDay[]) => P;
  /** Score of one item; higher = ranked first. `params` is the result of `fit` (if any). */
  score: (item: EvalSample, params: P) => number;
}

/** A variant with the parameter type erased, so they can share one list. */
export interface AnyVariant {
  name: string;
  fit?: (trainDays: readonly EvalDay[]) => unknown;
  score: (item: EvalSample, params: unknown) => number;
}

export function defineVariant<P>(v: Variant<P>): AnyVariant {
  return v as unknown as AnyVariant;
}

/**
 * Weights of the current formula, HARD-COPIED here (not read from `DEFAULT_RANK_CONFIG`): changing the
 * real config must not make the baseline drift.
 * S = N × (0,40·R + 0,25·P + 0,15·C + 0,10·A + 0,10·F).
 */
export const BASELINE_WEIGHTS = { R: 0.4, P: 0.25, C: 0.15, A: 0.1, F: 0.1 } as const;

export const baselineVariant = defineVariant({
  name: "baseline",
  score: ({ score: c }: EvalSample) =>
    c.N *
    (BASELINE_WEIGHTS.R * c.R +
      BASELINE_WEIGHTS.P * c.P +
      BASELINE_WEIGHTS.C * c.C +
      BASELINE_WEIGHTS.A * c.A +
      BASELINE_WEIGHTS.F * c.F),
});

/** Ranks exactly by label: NDCG must be 1 on every day. Checks the scorer's correctness, not a competitor. */
export const oracleVariant = defineVariant({
  name: "oracle",
  score: (item: EvalSample) => gainOf(item),
});

/** Seed of the random variant. */
export const RANDOM_SEED = 7;

/** FNV-1a 32-bit hash of a string. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Seeded random score, deterministic by (day, position, url): serves as a floor. */
export const randomVariant = defineVariant({
  name: "random",
  score: (item: EvalSample) =>
    mulberry32(hashString(`${RANDOM_SEED}|${item.date}|${item.position}|${item.urls.join(" ")}`))(),
});

/** The three reference variants; the baseline is always first. */
export const REFERENCE_VARIANTS: readonly AnyVariant[] = [
  baselineVariant,
  oracleVariant,
  randomVariant,
];
