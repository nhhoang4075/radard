/**
 * Bộ chấm: chia ngày (thường / khoá kín / không thông tin), chạy biến thể bỏ-một-ngày, so với
 * baseline bằng hiệu NDCG theo ngày kèm khoảng tin cậy bootstrap. Hàm thuần, xác định.
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

/** Ngày thứ k (đếm từ 0, trong các ngày có thông tin, theo thời gian) là khoá kín nếu k % 4 === 3. */
export const CLOSED_EVERY = 4;
export const CLOSED_REMAINDER = 3;
/** Ít hơn số ngày này thì không đủ để lấy khoảng tin cậy: báo "chưa đủ dữ liệu", không kết luận. */
export const MIN_DAYS_FOR_INTERVAL = 5;

export interface DaySplit {
  /** Ngày dùng để fit và chấm bỏ-một-ngày. */
  regular: EvalDay[];
  /** Tập khoá kín: không bao giờ dùng để fit hay chọn tham số. */
  closed: EvalDay[];
  /** Ngày mọi tin cùng mức: loại khỏi trung bình. */
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

/** Bỏ-một-ngày trên tập thường: mỗi ngày d, fit trên các ngày thường còn lại rồi chấm d. */
export function scoreRegular(variant: AnyVariant, regular: readonly EvalDay[]): SetScore {
  const days = regular.map((d) => {
    const params = variant.fit?.(regular.filter((x) => x !== d));
    return scoreDay(variant, d, params);
  });
  return summarize(days);
}

/** Tập khoá kín: fit trên TOÀN BỘ ngày thường (không có ngày khoá kín nào), rồi chấm. */
export function scoreClosed(
  variant: AnyVariant,
  regular: readonly EvalDay[],
  closed: readonly EvalDay[],
): SetScore {
  const params = variant.fit?.(regular);
  return summarize(closed.map((d) => scoreDay(variant, d, params)));
}

export interface Comparison {
  /** Hiệu NDCG theo ngày (biến thể − baseline) và khoảng tin cậy 95% của trung bình. */
  interval: MeanInterval;
  /** `null`: quá ít ngày để có khoảng tin cậy ("chưa đủ dữ liệu"). */
  verdict: Verdict | null;
}

/** So hai kết quả trên CÙNG danh sách ngày (cùng thứ tự). */
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
  /** Chỉ có khi chạy với `includeClosed`. */
  closed?: SetScore;
  /** So với baseline; vắng ở chính baseline. */
  vsBaselineRegular?: Comparison;
  vsBaselineClosed?: Comparison;
  /** "Nhận" cần thắng ở cả hai tập; chỉ có khi `includeClosed`. */
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

/** Vân tay dữ liệu: sha256 của danh sách (ngày, url chuẩn, mức) đã sắp xếp, cộng các số đếm. */
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
  /** Phần tử đầu luôn là baseline. */
  variants: VariantReport[];
}

export interface EvalOptions {
  /** Chấm cả tập khoá kín và đưa kết luận "nhận". Mặc định: chỉ tập thường. */
  includeClosed?: boolean;
}

/** Kết luận chung: thắng ở cả hai tập mới nhận; tập khoá kín quá nhỏ thì chưa đủ dữ liệu. */
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

/** Chạy baseline (luôn đứng đầu) rồi các biến thể còn lại. Biến thể trùng tên baseline bị bỏ qua. */
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
