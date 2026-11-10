/**
 * Mô phỏng xác suất được chọn của từng tin (p_i) và của từng cặp tin (p_ij) khi chọn có nhiễu
 * Gumbel. Chạy CHÍNH hàm `select` thật nhiều lần với nhiễu mới mỗi lần: không làm trơn, không
 * xấp xỉ, nên cùng một hàm phục vụ sản xuất và mô phỏng.
 */
import { mulberry32 } from "./eval/bootstrap.ts";
import { type RankConfig, type RankEvent, type Scored, select } from "./ranking.ts";
import { cosine } from "./vector.ts";

export interface SimulateOptions {
  /** Số lần chạy Monte Carlo (mặc định 10.000). */
  runs?: number;
  /** Hạt giống: cùng hạt giống cùng kết quả. */
  seed: number;
  /** Tin cần quan tâm; mặc định mọi sự kiện trong `scored`. Tin ngoài tập này không được đếm. */
  focusEventIds?: readonly number[];
  /** Độ giống giữa hai sự kiện; mặc định cosine giữa tâm (được tính trước một lần cho cả mô phỏng). */
  sim?: (a: RankEvent, b: RankEvent) => number;
}

export interface InclusionResult {
  seed: number;
  runs: number;
  /** p̂_i: tỉ lệ số lần tin i được chọn trên tổng số lần chạy. */
  selectionProb: Map<number, number>;
  /** p̂_ij, khoá `"i:j"` với i < j: tỉ lệ số lần CẢ HAI tin cùng được chọn. */
  pairProb: Map<string, number>;
}

/** Khoá cặp có thứ tự: i < j. */
export function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Ma trận độ giống tính trước một lần cho mọi cặp; trả hàm tra bảng cho `select`. */
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
    const chosen = select(scored, cfg, sim, rng)
      .picked.map((p) => p.event.eventId)
      .filter((id) => focus.has(id));
    for (const [x, a] of chosen.entries()) {
      bump(single, a);
      for (const b of chosen.slice(x + 1)) bump(pair, pairKey(a, b));
    }
  }

  const selectionProb = new Map([...single].map(([k, v]) => [k, v / runs]));
  const pairProb = new Map([...pair].map(([k, v]) => [k, v / runs]));
  return { seed: opts.seed, runs, selectionProb, pairProb };
}

/** Trần mặc định của trọng số nghịch đảo xác suất. */
export const DEFAULT_WEIGHT_CAP = 20;

/**
 * weight = min(1 / p̂, cap): CẮT trần, không làm trơn. p̂ = 0 (cặp không bao giờ quan sát được
 * trong mô phỏng) thì 1/p̂ vô hạn nên trả đúng `cap`, tức trọng số lớn nhất cho phép; không loại.
 */
export function inverseProbWeight(p: number, cap = DEFAULT_WEIGHT_CAP): number {
  return p > 0 ? Math.min(1 / p, cap) : cap;
}
