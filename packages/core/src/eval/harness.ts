/**
 * Scorer: splits days (normal / locked / uninformative), runs leave-one-day-out variants, compares against
 * the baseline by per-day NDCG difference with a bootstrap confidence interval. Pure, deterministic functions.
 */
import { sha256 } from "../hash.ts";
import { bootstrapMean, type MeanInterval, mean, type Verdict, verdictOf } from "./bootstrap.ts";
import {
  addPairwise,
  emptyPairwise,
  ndcgOfDay,
  type PairwiseResult,
  pairwiseOfDay,
} from "./metrics.ts";
import { type EvalDay, isInformative } from "./types.ts";
import { type AnyVariant, baselineVariant } from "./variants.ts";

/** The k-th informative day (0-based, in time order) is a locked day if k % 4 === 3. */
export const CLOSED_EVERY = 4;
export const CLOSED_REMAINDER = 3;
/** Fewer days than this is not enough for a confidence interval: report "not enough data", no verdict. */
export const MIN_DAYS_FOR_INTERVAL = 5;

export interface DaySplit {
  /** Days used to fit and for leave-one-day-out scoring. */
  regular: EvalDay[];
  /** Locked set: never used to fit or to choose parameters. */
  closed: EvalDay[];
  /** Days where all items share the same level: excluded from the mean. */
  uninformative: EvalDay[];
}

export function splitDays(days: readonly EvalDay[]): DaySplit {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const out: DaySplit = { regular: [], closed: [], uninformative: [] };
  let k = 0;
  for (const d of sorted) {
    if (!isInformative(d)) {
      out.uninformative.push(d);
      continue;
    }
    (k % CLOSED_EVERY === CLOSED_REMAINDER ? out.closed : out.regular).push(d);
    k++;
  }
  return out;
}

export interface DayScore {
  date: string;
  ndcg: number;
  pairwise: PairwiseResult;
}

export interface SetScore {
  days: DayScore[];
  meanNdcg: number;
  pairwise: PairwiseResult;
}

function scoreDay(variant: AnyVariant, day: EvalDay, params: unknown): DayScore {
  const scores = day.samples.map((s) => variant.score(s, params));
  return {
    date: day.date,
    ndcg: ndcgOfDay(day.samples, scores),
    pairwise: pairwiseOfDay(day.samples, scores),
  };
}

function summarize(days: DayScore[]): SetScore {
  return {
    days,
    meanNdcg: mean(days.map((d) => d.ndcg)),
    pairwise: days.reduce((acc, d) => addPairwise(acc, d.pairwise), emptyPairwise()),
  };
}

/** Leave-one-day-out on the normal set: for each day d, fit on the other normal days, then score d. */
export function scoreRegular(variant: AnyVariant, regular: readonly EvalDay[]): SetScore {
  const days = regular.map((d) => {
    const params = variant.fit?.(regular.filter((x) => x !== d));
    return scoreDay(variant, d, params);
  });
  return summarize(days);
}

/** Locked set: fit on ALL normal days (no locked day included), then score. */
export function scoreClosed(
  variant: AnyVariant,
  regular: readonly EvalDay[],
  closed: readonly EvalDay[],
): SetScore {
  const params = variant.fit?.(regular);
  return summarize(closed.map((d) => scoreDay(variant, d, params)));
}

export interface Comparison {
  /** Per-day NDCG difference (variant − baseline) and the 95% confidence interval of its mean. */
  interval: MeanInterval;
  /** `null`: too few days for a confidence interval ("not enough data"). */
  verdict: Verdict | null;
}

/** Compares two results over the SAME list of days (same order). */
export function compareSets(variant: SetScore, base: SetScore): Comparison {
  const diffs = variant.days.map((d, i) => d.ndcg - (base.days[i]?.ndcg ?? 0));
  const interval = bootstrapMean(diffs);
  return {
    interval,
    verdict: diffs.length < MIN_DAYS_FOR_INTERVAL ? null : verdictOf(interval),
  };
}

export interface VariantReport {
  name: string;
  regular: SetScore;
  /** Only present when run with `includeClosed`. */
  closed?: SetScore;
  /** Compared with the baseline; absent for the baseline itself. */
  vsBaselineRegular?: Comparison;
  vsBaselineClosed?: Comparison;
  /** "Accept" requires a win on both sets; only present with `includeClosed`. */
  accepted?: "accept" | "reject" | "insufficient";
}

export interface DataFingerprint {
  sha256: string;
  days: number;
  informativeDays: number;
  uninformativeDays: number;
  samples: number;
  likes: number;
  dislikes: number;
}

/** Data fingerprint: sha256 of the sorted list (day, canonical url, level), plus the counts. */
export function fingerprintOf(days: readonly EvalDay[]): DataFingerprint {
  const lines: string[] = [];
  let samples = 0;
  let likes = 0;
  let dislikes = 0;
  for (const d of days) {
    for (const s of d.samples) {
      samples++;
      if (s.level === "like") likes++;
      if (s.level === "dislike") dislikes++;
      for (const u of s.urls) lines.push(`${d.date}\t${u}\t${s.level}`);
    }
  }
  lines.sort();
  const informativeDays = days.filter(isInformative).length;
  return {
    sha256: sha256(lines.join("\n")),
    days: days.length,
    informativeDays,
    uninformativeDays: days.length - informativeDays,
    samples,
    likes,
    dislikes,
  };
}

export interface EvalReport {
  fingerprint: DataFingerprint;
  split: { regular: number; closed: number; uninformative: number };
  closedIncluded: boolean;
  /** The first element is always the baseline. */
  variants: VariantReport[];
}

export interface EvalOptions {
  /** Also score the locked set and produce the "accept" verdict. Default: normal set only. */
  includeClosed?: boolean;
}

/** Overall verdict: accept only if it wins on both sets; if the locked set is too small, not enough data. */
export function acceptOf(
  regular: Verdict | null,
  closed: Verdict | null,
): "accept" | "reject" | "insufficient" {
  if (regular === null) return "insufficient";
  if (regular !== "win") return "reject";
  if (closed === null) return "insufficient";
  return closed === "win" ? "accept" : "reject";
}

interface BaselineScores {
  regular: SetScore;
  closed: SetScore | undefined;
}

function reportVariant(
  v: AnyVariant,
  split: DaySplit,
  includeClosed: boolean,
  base: BaselineScores,
): VariantReport {
  const isBase = v.name === baselineVariant.name;
  const regular = isBase ? base.regular : scoreRegular(v, split.regular);
  const closed = includeClosed
    ? isBase
      ? base.closed
      : scoreClosed(v, split.regular, split.closed)
    : undefined;
  const r: VariantReport = { name: v.name, regular };
  if (closed) r.closed = closed;
  if (isBase) return r;
  r.vsBaselineRegular = compareSets(regular, base.regular);
  if (closed && base.closed) {
    r.vsBaselineClosed = compareSets(closed, base.closed);
    r.accepted = acceptOf(r.vsBaselineRegular.verdict, r.vsBaselineClosed.verdict);
  }
  return r;
}

/** Runs the baseline (always first), then the other variants. Variants named like the baseline are skipped. */
export function runEval(
  days: readonly EvalDay[],
  variants: readonly AnyVariant[],
  opts: EvalOptions = {},
): EvalReport {
  const split = splitDays(days);
  const includeClosed = opts.includeClosed === true;
  const base: BaselineScores = {
    regular: scoreRegular(baselineVariant, split.regular),
    closed: includeClosed ? scoreClosed(baselineVariant, split.regular, split.closed) : undefined,
  };
  const all = [baselineVariant, ...variants.filter((x) => x.name !== baselineVariant.name)];
  return {
    fingerprint: fingerprintOf(days),
    split: {
      regular: split.regular.length,
      closed: split.closed.length,
      uninformative: split.uninformative.length,
    },
    closedIncluded: includeClosed,
    variants: all.map((v) => reportVariant(v, split, includeClosed, base)),
  };
}
