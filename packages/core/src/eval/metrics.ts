/** Chỉ số xếp hạng: NDCG mỗi ngày và độ chính xác theo cặp. Hàm thuần. */
import { type EvalSample, gainOf } from "./types.ts";

/**
 * Thứ tự biến thể xếp: điểm giảm dần; điểm bằng nhau thì theo vị trí gửi (nhỏ trước), để kết quả
 * xác định. Không sửa mảng vào.
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

/** DCG = Σ gain_i / log2(i + 1), i bắt đầu từ 1 (ở đây chỉ số mảng k = i − 1 nên log2(k + 2)). */
export function dcg(gains: readonly number[]): number {
  let sum = 0;
  for (let k = 0; k < gains.length; k++) sum += (gains[k] ?? 0) / Math.log2(k + 2);
  return sum;
}

/** NDCG = DCG / DCG của thứ tự lý tưởng (gain giảm dần). Ngày toàn gain 0 trả 0. */
export function ndcg(gainsInRankedOrder: readonly number[]): number {
  const ideal = dcg([...gainsInRankedOrder].sort((a, b) => b - a));
  return ideal > 0 ? dcg(gainsInRankedOrder) / ideal : 0;
}

/** NDCG của một ngày khi biến thể cho `scores[i]` tới `samples[i]`. */
export function ndcgOfDay(samples: readonly EvalSample[], scores: readonly number[]): number {
  return ndcg(rankSamples(samples, scores).map(gainOf));
}

/** Số cặp khác mức và số cặp biến thể xếp đúng (điểm bằng nhau tính 0,5). */
export interface PairCount {
  pairs: number;
  correct: number;
}

export interface PairwiseResult {
  /** Cặp sạch: một tin 👍 với một tin 👎. */
  clean: PairCount;
  /** Mọi cặp khác mức (gồm cả cặp sạch). */
  all: PairCount;
}

export const emptyPairwise = (): PairwiseResult => ({
  clean: { pairs: 0, correct: 0 },
  all: { pairs: 0, correct: 0 },
});

/** Cộng dồn kết quả theo cặp của nhiều ngày. */
export function addPairwise(a: PairwiseResult, b: PairwiseResult): PairwiseResult {
  return {
    clean: { pairs: a.clean.pairs + b.clean.pairs, correct: a.clean.correct + b.clean.correct },
    all: { pairs: a.all.pairs + b.all.pairs, correct: a.all.correct + b.all.correct },
  };
}

/** 1 nếu điểm tin mức cao hơn lớn hơn điểm tin mức thấp hơn, 0,5 nếu bằng nhau, 0 nếu ngược. */
const pairOutcome = (scoreHigher: number, scoreLower: number): number =>
  scoreHigher > scoreLower ? 1 : scoreHigher === scoreLower ? 0.5 : 0;

/** Độ chính xác theo cặp trong MỘT ngày. */
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

/** Tỉ lệ đúng; NaN khi không có cặp nào. */
export const pairAccuracy = (c: PairCount): number =>
  c.pairs === 0 ? Number.NaN : c.correct / c.pairs;
