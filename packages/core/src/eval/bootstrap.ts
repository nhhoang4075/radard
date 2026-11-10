/** Lấy mẫu lại (bootstrap) theo NGÀY với bộ sinh ngẫu nhiên có hạt giống: cùng dữ liệu, cùng số. */
import { percentileCont } from "../ranking.ts";

/** Số lần lấy mẫu lại và hạt giống CỐ ĐỊNH của bộ chấm: đổi hai số này là đổi phép đo. */
export const BOOTSTRAP_B = 2000;
export const BOOTSTRAP_SEED = 20261110;

/** mulberry32: bộ sinh giả ngẫu nhiên 32 bit, trả số trong [0, 1). */
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
  /** Cận dưới / trên của khoảng tin cậy 95% (phân vị 2,5% và 97,5% của trung bình lấy mẫu lại). */
  lo: number;
  hi: number;
  /** Số ngày. */
  n: number;
}

export const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Khoảng tin cậy 95% của trung bình `diffs` (một số mỗi ngày), lấy mẫu lại theo ngày có hoàn lại. */
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

/** "Thắng" chỉ khi CẬN DƯỚI > 0; "thua" khi cận trên < 0; còn lại là hoà trong nhiễu. */
export function verdictOf(ci: Pick<MeanInterval, "lo" | "hi">): Verdict {
  if (ci.lo > 0) return "win";
  if (ci.hi < 0) return "lose";
  return "tie";
}
