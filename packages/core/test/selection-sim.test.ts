import { describe, expect, test } from "bun:test";
import { mulberry32 } from "../src/eval/bootstrap.ts";
import {
  DEFAULT_RANK_CONFIG,
  gumbelNoise,
  mmrPenalty,
  type RankConfig,
  type RankEvent,
  type Scored,
  select,
} from "../src/ranking.ts";
import {
  deriveSimSeed,
  inverseProbWeight,
  orderedListLogProb,
  pairKey,
  simulateInclusion,
} from "../src/selection-sim.ts";
import { cosine } from "../src/vector.ts";

const cfg: RankConfig = {
  ...DEFAULT_RANK_CONFIG,
  temperature: 0,
  floorS: 0,
  maxPerSource: 7,
  priors: new Map(),
};

function cand(id: number, S: number, sourceId = 1, centroid: number[] = [1, 0]): Scored {
  const event: RankEvent = {
    eventId: id,
    title: `e${id}`,
    firstSeenAt: new Date("2026-10-05T10:00:00Z"),
    centroid,
    docs: [],
  };
  return {
    event,
    c: { R: 0.9, P: 0, C: 0, A: 0, F: 0, U: 0, N: 1, topicId: 1, sourceId, documentId: null },
    S,
  };
}

/** Oracle: bản sao NGUYÊN VĂN logic chọn cũ (T = 0) viết lại độc lập trong test. */
function oldSelect(
  scored: readonly Scored[],
  c: RankConfig,
  sim: (a: RankEvent, b: RankEvent) => number,
) {
  const pool = scored.filter((s) => s.c.R >= c.gateR && s.c.N !== 0 && s.S >= c.floorS);
  pool.sort((a, b) => b.S - a.S);
  const picked: { s: Scored; penalty: number; reserved: boolean }[] = [];
  const per = new Map<number, number>();
  const has = (s: Scored) => picked.some((p) => p.s === s);
  const take = (s: Scored, penalty: number, reserved: boolean) => {
    picked.push({ s, penalty, reserved });
    per.set(s.c.sourceId, (per.get(s.c.sourceId) ?? 0) + 1);
  };
  const seen = new Set<number>();
  for (const s of pool) {
    if (picked.length >= c.maxItems) break;
    if (seen.has(s.c.sourceId)) continue;
    seen.add(s.c.sourceId);
    take(s, 0, true);
  }
  while (picked.length < c.maxItems) {
    let best: { s: Scored; penalty: number; value: number } | null = null;
    for (const s of pool) {
      if (has(s) || (per.get(s.c.sourceId) ?? 0) >= c.maxPerSource) continue;
      const maxSim = Math.max(...picked.map((p) => sim(s.event, p.s.event)));
      const penalty = mmrPenalty(maxSim, c.mmr);
      const value = s.S - penalty;
      if (!best || value > best.value) best = { s, penalty, value };
    }
    if (!best) break;
    take(best.s, best.penalty, false);
  }
  picked.sort((a, b) => b.s.S - b.penalty - (a.s.S - a.penalty));
  return picked.map((p) => ({ id: p.s.event.eventId, penalty: p.penalty, reserved: p.reserved }));
}

describe("select với T = 0", () => {
  test("(a) giống hệt cách chọn cũ trên 300 bộ dữ liệu ngẫu nhiên, và không gọi rng", () => {
    const r = mulberry32(7);
    let withReserve = 0;
    let withCap = 0;
    let withPenalty = 0;
    for (let t = 0; t < 300; t++) {
      const n = 3 + Math.floor(r() * 20);
      const nSources = 1 + Math.floor(r() * 4);
      const items = Array.from({ length: n }, (_, i) => {
        // Tâm gần nhau theo nhóm để có phạt trùng.
        const group = Math.floor(r() * 3);
        const centroid = [1 + 0.05 * r() * (group === 0 ? 1 : 0), group, 0.02 * r()];
        const gate = r() < 0.9 ? 0.9 : 0.3;
        const s = cand(
          i + 1,
          Math.round(r() * 100) / 100,
          1 + Math.floor(r() * nSources),
          centroid,
        );
        s.c.R = gate;
        if (r() < 0.05) s.c.N = 0;
        return s;
      });
      const c: RankConfig = {
        ...cfg,
        floorS: r() < 0.5 ? 0 : 0.3,
        maxItems: 1 + Math.floor(r() * 8),
        maxPerSource: 1 + Math.floor(r() * 4),
      };
      const sim = (a: RankEvent, b: RankEvent) => cosine(a.centroid, b.centroid);
      const got = select(items, c, sim, () => {
        throw new Error("không được gọi rng khi T = 0");
      });
      const want = oldSelect(items, c, sim);
      expect(
        got.picked.map((p) => ({ id: p.event.eventId, penalty: p.penalty, reserved: p.reserved })),
      ).toEqual(want);
      if (want.some((w) => w.reserved)) withReserve++;
      if (want.some((w) => w.penalty > 0)) withPenalty++;
      if (items.length > c.maxItems && nSources === 1) withCap++;
      // Cũng đúng khi không truyền rng và chữ ký cũ.
      expect(select(items, c).picked.map((p) => p.event.eventId)).toEqual(want.map((w) => w.id));
    }
    // Bảo đảm bộ dữ liệu thật sự phủ các ca khó.
    expect(withReserve).toBeGreaterThan(100);
    expect(withPenalty).toBeGreaterThan(20);
    expect(withCap).toBeGreaterThan(5);
  });
});

describe("select với T > 0", () => {
  const items = [cand(1, 0.7, 1), cand(2, 0.65, 2), cand(3, 0.6, 3), cand(4, 0.55, 1)];
  const hot = { ...cfg, temperature: 0.2, maxItems: 2 };

  test("(b) RNG cố định cho kết quả xác định; T > 0 mà thiếu rng là lỗi", () => {
    const a = select(items, hot, undefined, mulberry32(5)).picked.map((p) => p.event.eventId);
    const b = select(items, hot, undefined, mulberry32(5)).picked.map((p) => p.event.eventId);
    expect(a).toEqual(b);
    expect(() => select(items, hot)).toThrow();
  });

  test("rng được gọi đúng một lần cho mỗi ứng viên của pool", () => {
    let calls = 0;
    const rng = mulberry32(1);
    select([...items, cand(9, -1, 1)], { ...hot, floorS: 0.5 }, undefined, () => {
      calls++;
      return rng();
    });
    expect(calls).toBe(4);
  });

  test("gumbelNoise: công thức −ln(−ln U) và kẹp U", () => {
    expect(gumbelNoise(Math.exp(-1))).toBeCloseTo(0, 12);
    expect(Number.isFinite(gumbelNoise(0))).toBe(true);
    expect(Number.isFinite(gumbelNoise(1))).toBe(true);
  });

  test("thứ tự kết quả và phạt trùng vẫn theo S thật", () => {
    // Nhiễu rất lớn: khoá gần như ngẫu nhiên, nhưng kết quả vẫn sắp theo S − phạt.
    const big = { ...cfg, temperature: 5, maxItems: 4 };
    for (let seed = 1; seed < 30; seed++) {
      const r = select(items, big, () => 0, mulberry32(seed)).picked;
      const vals = r.map((p) => p.S - p.penalty);
      expect(vals).toEqual([...vals].sort((x, y) => y - x));
    }
  });
});

describe("simulateInclusion", () => {
  const SEED = 20261110;
  const z = 4.5; // sai số cho phép, theo độ lệch chuẩn

  test("(c) hai tin S bằng nhau, chọn 1: p ≈ 0,5 trong 4,5 độ lệch chuẩn", () => {
    const runs = 10_000;
    const res = simulateInclusion(
      [cand(1, 0.7, 1), cand(2, 0.7, 2)],
      { ...cfg, temperature: 0.1, maxItems: 1 },
      { seed: SEED, runs },
    );
    const sd = Math.sqrt((0.5 * 0.5) / runs);
    expect(Math.abs((res.selectionProb.get(1) ?? 0) - 0.5)).toBeLessThan(z * sd);
    // Chọn đúng 1 tin mỗi lần: p1 + p2 = 1 chính xác.
    expect((res.selectionProb.get(1) ?? 0) + (res.selectionProb.get(2) ?? 0)).toBeCloseTo(1, 12);
  });

  test("(d) Gumbel-max: p_i = softmax(S_i / T) với 3 tin, T = 0,1", () => {
    const S = [0.7, 0.65, 0.6];
    const T = 0.1;
    // Tính tay: e^7 = 1096,633; e^6,5 = 665,142; e^6 = 403,429; tổng = 2165,204.
    const expected = [1096.633 / 2165.204, 665.142 / 2165.204, 403.429 / 2165.204];
    expect(expected[0]).toBeCloseTo(0.50648, 4);
    const runs = 10_000;
    const res = simulateInclusion(
      S.map((s, i) => cand(i + 1, s, i + 1)),
      { ...cfg, temperature: T, maxItems: 1 },
      { seed: SEED, runs },
    );
    for (let i = 0; i < 3; i++) {
      const p = expected[i] ?? 0;
      const sd = Math.sqrt((p * (1 - p)) / runs);
      expect(Math.abs((res.selectionProb.get(i + 1) ?? 0) - p)).toBeLessThan(z * sd);
    }
  });

  test("(e) tin dưới sàn (và tin không qua cổng, đã gửi) có p = 0 chính xác", () => {
    const gateOut = cand(3, 0.9, 3);
    gateOut.c.R = 0.1;
    const sent = cand(4, 0.9, 4);
    sent.c.N = 0;
    const items = [cand(1, 0.7, 1), cand(2, 0.2, 2), gateOut, sent];
    const res = simulateInclusion(
      items,
      { ...cfg, floorS: 0.5, temperature: 5, maxItems: 4 },
      { seed: SEED, runs: 2000 },
    );
    expect(res.selectionProb.get(1)).toBe(1);
    expect(res.selectionProb.get(2)).toBe(0);
    expect(res.selectionProb.get(3)).toBe(0);
    expect(res.selectionProb.get(4)).toBe(0);
    expect(res.pairProb.get(pairKey(1, 2))).toBe(0);
  });

  test("(f) hai tin S rất cao: p_ij ≈ 1; hai tin loại trừ nhau (cùng nguồn, cap 1): p_ij = 0", () => {
    const items = [cand(1, 5, 1), cand(2, 5, 2), cand(3, 0.6, 3), cand(4, 0.6, 4), cand(5, 0.6, 5)];
    const res = simulateInclusion(
      items,
      { ...cfg, temperature: 0.05, maxItems: 3 },
      { seed: SEED, runs: 5000 },
    );
    expect(res.pairProb.get("1:2") ?? 0).toBeGreaterThan(0.999);
    const same = [cand(1, 0.7, 1), cand(2, 0.7, 1), cand(3, 0.69, 2)];
    const r2 = simulateInclusion(
      same,
      { ...cfg, temperature: 0.3, maxItems: 3, maxPerSource: 1 },
      { seed: SEED, runs: 3000 },
    );
    expect(r2.pairProb.get("1:2")).toBe(0);
    expect(r2.pairProb.get("1:3") ?? 0).toBeGreaterThan(0);
  });

  test("focusEventIds giới hạn tập trả về: 7 tin → 7 p_i và 21 cặp", () => {
    const items = Array.from({ length: 12 }, (_, i) => cand(i + 1, 0.9 - 0.02 * i, i + 1));
    const focus = [1, 2, 3, 4, 5, 6, 7];
    const res = simulateInclusion(
      items,
      { ...cfg, temperature: 0.05 },
      { seed: SEED, runs: 500, focusEventIds: focus },
    );
    expect(res.selectionProb.size).toBe(7);
    expect(res.pairProb.size).toBe(21);
    for (const k of res.pairProb.keys()) {
      const [i, j] = k.split(":").map(Number);
      expect(i).toBeLessThan(j as number);
    }
  });

  test("(g) cùng hạt giống cho kết quả y hệt; khác hạt giống thì khác", () => {
    const items = Array.from({ length: 10 }, (_, i) => cand(i + 1, 0.8 - 0.01 * i, 1 + (i % 3)));
    const c = { ...cfg, temperature: 0.1, maxItems: 4 };
    const a = simulateInclusion(items, c, { seed: 1, runs: 1000 });
    const b = simulateInclusion(items, c, { seed: 1, runs: 1000 });
    const d = simulateInclusion(items, c, { seed: 2, runs: 1000 });
    expect([...a.selectionProb]).toEqual([...b.selectionProb]);
    expect([...a.pairProb]).toEqual([...b.pairProb]);
    expect([...a.selectionProb]).not.toEqual([...d.selectionProb]);
    expect(a.seed).toBe(1);
    expect(a.runs).toBe(1000);
  });

  test("T = 0: mô phỏng cho p chỉ 0 hoặc 1 và trùng với select xác định", () => {
    const items = Array.from({ length: 8 }, (_, i) => cand(i + 1, 0.9 - 0.05 * i, 1 + (i % 2)));
    const c = { ...cfg, maxItems: 3 };
    const res = simulateInclusion(items, c, { seed: 3, runs: 50 });
    const picked = new Set(select(items, c).picked.map((p) => p.event.eventId));
    for (const [id, p] of res.selectionProb) expect(p).toBe(picked.has(id) ? 1 : 0);
  });

  test("hiệu năng: 25 ứng viên, vector 1024 chiều, 10.000 lần chạy dưới 2 giây", () => {
    const r = mulberry32(11);
    const items = Array.from({ length: 25 }, (_, i) =>
      cand(
        i + 1,
        0.6 + 0.3 * r(),
        1 + (i % 4),
        Array.from({ length: 1024 }, () => r() - 0.5),
      ),
    );
    const t0 = performance.now();
    const res = simulateInclusion(items, { ...cfg, temperature: 0.05 }, { seed: SEED });
    const ms = performance.now() - t0;
    expect(res.runs).toBe(10_000);
    expect(ms).toBeLessThan(2000);
  });
});

describe("inverseProbWeight", () => {
  test("(h) min(1/p, cap): 0,5 → 2; 0,01 → 20 (cắt); p = 0 → cap", () => {
    expect(inverseProbWeight(0.5)).toBe(2);
    expect(inverseProbWeight(0.01)).toBe(20);
    expect(inverseProbWeight(0)).toBe(20);
    expect(inverseProbWeight(0.01, 50)).toBe(50);
    expect(inverseProbWeight(0.2, 3)).toBe(3);
  });
});

describe("deriveSimSeed và orderedListLogProb", () => {
  test("hạt mô phỏng suy ra được, là số nguyên 32 bit không dấu, khác hạt chọn", () => {
    for (const s of [0, 1, 12345, 4294967295]) {
      const d = deriveSimSeed(s);
      expect(d).toBe(deriveSimSeed(s));
      expect(Number.isInteger(d) && d >= 0 && d < 2 ** 32).toBe(true);
      expect(d).not.toBe(s);
    }
  });

  test("ví dụ spec: S = 0,80/0,75/0,70/0,60, T = 0,05, chọn tin 0 rồi tin 1", () => {
    // Tay: P(0) = e^16/(e^16+e^15+e^14+e^12), P(1 | còn 1,2,3) = e^15/(e^15+e^14+e^12).
    const e = Math.exp;
    const want =
      Math.log(e(16) / (e(16) + e(15) + e(14) + e(12))) + Math.log(e(15) / (e(15) + e(14) + e(12)));
    const got = orderedListLogProb([0.8, 0.75, 0.7, 0.6], [0, 1], 0.05);
    expect(got).toBeCloseTo(want, 9);
  });

  test("T = 0 không có phân phối: null", () => {
    expect(orderedListLogProb([0.8, 0.7], [0], 0)).toBeNull();
  });
});
