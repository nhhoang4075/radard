/**
 * Dữ liệu học của chọn Gumbel top-k (mo-hinh-de-xuat.html, mục "Hai nhịp"): ngay sau khi chọn, chạy
 * lại CHÍNH `select` 10.000 lần với đúng đầu vào của ngày đó (cùng cấu hình gồm T và sàn, cùng
 * bể ứng viên) để ước lượng p_i của từng ứng viên và p_ij của các cặp trong tin đã gửi; lưu cùng
 * logP của danh sách thật, hạt giống chọn và hạt giống mô phỏng.
 *
 * Nơi lưu: `digests.meta.learning` (JSON), không thêm bảng. Lý do: dữ liệu gắn đúng một lần digest
 * (đã có `profile_id`, khoá chạy lại, vòng đời chung), chỉ đọc theo lô hằng tuần, vài KB mỗi ngày.
 * Bảng riêng chỉ đáng khi cần truy vấn p theo từng tin qua nhiều ngày; khi đó migration từ JSON dễ.
 *
 * Bể = tin ĐÃ gửi + tin qua cổng/sàn nhưng không được chọn (`not_picked`, `source_cap`); tin bị
 * cổng, sàn hay `not_new` loại có p = 0 nên không ghi. p_ij chỉ ghi cho các cặp trong tin đã gửi.
 */
import { deriveSimSeed, orderedListLogProb, pairKey, simulateInclusion } from "@radard/core";
import type { RankResult } from "./rank.ts";

/** Số lần chạy Monte Carlo mỗi bản tin (duyệt 10/11/2026). */
export const SIMULATION_RUNS = 10_000;

export interface SelectionLearning {
  version: 1;
  /** Hạt giống của lần chọn thật; chạy lại với hạt này ra đúng tập tin đã chọn. */
  selectSeed: number;
  /** Hạt giống mô phỏng = deriveSimSeed(selectSeed). */
  simSeed: number;
  temperature: number;
  runs: number;
  /** ln P của danh sách đã gửi theo Plackett–Luce (xấp xỉ, xem `orderedListLogProb`). */
  logP: number | null;
  /** p̂_i của mọi tin trong bể, S giảm dần. */
  pool: { eventId: number; S: number; p: number; sent: boolean }[];
  /** p̂_ij của các cặp trong tin đã gửi (n·(n−1)/2 cặp), a < b. */
  pairs: { a: number; b: number; p: number }[];
  ms: number;
}

/** Hạt giống mạnh (crypto), số nguyên không dấu 32 bit. */
export function newSelectSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

/** Null khi chọn xác định (T = 0, không hạt) hoặc không có tin nào được chọn. */
export function computeSelectionLearning(rank: RankResult): SelectionLearning | null {
  const seed = rank.selectSeed;
  const cfg = rank.selectConfig;
  if (seed === null || !(cfg.temperature > 0) || rank.picked.length === 0) return null;
  const started = Date.now();
  const simSeed = deriveSimSeed(seed);
  const sent = rank.picked.map((p) => ({ eventId: p.event.eventId, S: p.S, sent: true }));
  const rest = rank.rejected
    .filter((r) => r.reason === "not_picked" || r.reason === "source_cap")
    .map((r) => ({ eventId: r.event.eventId, S: r.S, sent: false }));
  const members = [...sent, ...rest];
  const sim = simulateInclusion(rank.scored, cfg, {
    runs: SIMULATION_RUNS,
    seed: simSeed,
    focusEventIds: members.map((m) => m.eventId),
  });
  const ids = sent.map((s) => s.eventId);
  const pairs: SelectionLearning["pairs"] = [];
  for (const [x, a] of ids.entries()) {
    for (const b of ids.slice(x + 1)) {
      pairs.push({ a: Math.min(a, b), b: Math.max(a, b), p: sim.pairProb.get(pairKey(a, b)) ?? 0 });
    }
  }
  return {
    version: 1,
    selectSeed: seed,
    simSeed,
    temperature: cfg.temperature,
    runs: sim.runs,
    logP: orderedListLogProb(
      members.map((m) => m.S),
      sent.map((_, i) => i),
      cfg.temperature,
    ),
    pool: members
      .map((m) => ({ ...m, p: sim.selectionProb.get(m.eventId) ?? 0 }))
      .sort((a, b) => b.S - a.S),
    pairs,
    ms: Date.now() - started,
  };
}
