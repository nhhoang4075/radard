import { describe, expect, test } from "bun:test";
import {
  baselineOf,
  blendBaseline,
  components,
  DEFAULT_RANK_CONFIG,
  mmrPenalty,
  normalize,
  percentileCont,
  type RankConfig,
  type RankEvent,
  type Scored,
  scoreOf,
  select,
} from "../src/ranking.ts";

describe("percentileCont", () => {
  test("giống percentile_cont của Postgres: nội suy tuyến tính theo vị trí (n − 1) × p", () => {
    // select percentile_cont(p) within group (order by x) from unnest('{1,2,3,4,10}'::float[]) x
    //   p = 0.5 → 3 · p = 0.999 → 9.976 · p = 0.25 → 2
    const xs = [1, 2, 3, 4, 10];
    expect(percentileCont(xs, 0.5)).toBe(3);
    expect(percentileCont(xs, 0.25)).toBe(2);
    expect(percentileCont(xs, 0.999)).toBeCloseTo(9.976, 9);
    expect(percentileCont([7], 0.999)).toBe(7);
    expect(percentileCont([], 0.5)).toBeNaN();
  });

  test("baselineOf tự sắp mảng", () => {
    expect(baselineOf([10, 1, 3, 2, 4])).toEqual({
      median: 3,
      p999: percentileCont([1, 2, 3, 4, 10], 0.999),
      n: 5,
    });
  });
});

describe("blendBaseline", () => {
  const global = { median: 0.4, p999: 0.8, n: 16_000 };
  test("nguồn chưa có dữ liệu dùng hẳn mặt bằng chung", () => {
    expect(blendBaseline(undefined, global)).toEqual(global);
    expect(blendBaseline({ median: 0.9, p999: 1, n: 0 }, global)).toMatchObject({
      median: 0.4,
      p999: 0.8,
    });
  });
  test("w = n / (n + 1000): 1.000 mẫu thì mỗi bên một nửa", () => {
    const b = blendBaseline({ median: 0.6, p999: 1.0, n: 1000 }, global);
    expect(b.median).toBeCloseTo(0.5, 12);
    expect(b.p999).toBeCloseTo(0.9, 12);
  });
  test("số thật xep-hang.html: GitHub releases n = 91 → w ≈ 0,083", () => {
    const b = blendBaseline({ median: 1, p999: 1, n: 91 }, { median: 0, p999: 0, n: 1 });
    expect(b.median).toBeCloseTo(91 / 1091, 12);
  });
});

describe("normalize", () => {
  const b = { median: 1.099, p999: 7.04, n: 9093 };
  test("ví dụ xep-hang.html: 306 điểm, 201 bình luận → P ≈ 0,83; 11 điểm, 3 bình luận → ≈ 0,25", () => {
    expect(normalize(Math.log1p(306 + 0.5 * 201), b)).toBeCloseTo(0.826, 2);
    expect(normalize(Math.log1p(11 + 0.5 * 3), b)).toBeCloseTo(0.251, 2);
  });
  test("dưới trung vị thì 0, trên mốc 0,1% thì 1", () => {
    expect(normalize(0.5, b)).toBe(0);
    expect(normalize(100, b)).toBe(1);
  });
  test("mặt bằng phẳng (mọi giá trị bằng nhau) không chia cho 0", () => {
    expect(normalize(2, { median: 1, p999: 1, n: 3 })).toBe(1);
    expect(normalize(1, { median: 1, p999: 1, n: 3 })).toBe(0);
  });
});

const cfg: RankConfig = {
  ...DEFAULT_RANK_CONFIG,
  priors: new Map([
    [1, 0.6],
    [2, 0.6],
    [3, 0.8],
  ]),
};
const flat = { median: 0, p999: 1, n: 10_000 };
const base = {
  relevance: () => flat,
  engagement: () => ({ median: 1.099, p999: 7.04, n: 9093 }),
  coverage: () => ({ median: Math.log(2), p999: 2.5, n: 5000 }),
};
const start = new Date("2026-10-05T02:00:00Z");

function ev(
  id: number,
  docs: RankEvent["docs"],
  firstSeenAt = new Date("2026-10-05T10:00:00Z"),
): RankEvent {
  return { eventId: id, title: `e${id}`, firstSeenAt, centroid: [1, 0], docs };
}
const doc = (
  documentId: number,
  sourceId: number,
  url: string,
  score: number,
  engagement: number | null = null,
) => ({
  documentId,
  sourceId,
  urlCanonical: url,
  topicScores: new Map([[7, score]]),
  engagement,
});

describe("components", () => {
  test("R lấy cặp (tài liệu, chủ đề) cao nhất và ghi lại chủ đề, nguồn của nó", () => {
    const e = ev(1, [
      {
        ...doc(1, 1, "a", 0.5),
        topicScores: new Map([
          [7, 0.5],
          [8, 0.9],
        ]),
      },
      doc(2, 2, "b", 0.7),
    ]);
    const c = components(e, base, cfg, start, new Set());
    expect([c.R, c.topicId, c.sourceId]).toEqual([0.9, 8, 1]);
  });

  test("P cộng dồn lượt đăng lại cùng nguồn; không nguồn nào có tín hiệu thì 0,3", () => {
    const one = components(ev(1, [doc(1, 1, "a", 0.8, 300)]), base, cfg, start, new Set());
    const reposts = components(
      ev(1, [doc(1, 1, "a", 0.8, 150), doc(2, 1, "a", 0.8, 150)]),
      base,
      cfg,
      start,
      new Set(),
    );
    expect(reposts.P).toBeCloseTo(one.P, 12);
    expect(components(ev(1, [doc(1, 2, "a", 0.8)]), base, cfg, start, new Set()).P).toBe(0.3);
  });

  test("P = lớn nhất theo nguồn: nguồn không đo được góp 0,3, nên được nhắc ít điểm không bị phạt", () => {
    const p = (docs: RankEvent["docs"]) => components(ev(1, docs), base, cfg, start, new Set()).P;
    const lowHn = doc(1, 1, "a", 0.8, 2); // 2 điểm: dưới trung vị → 0
    const paper = doc(2, 2, "b", 0.8); // nguồn không có tín hiệu
    expect(p([lowHn])).toBe(0);
    expect(p([paper, lowHn])).toBe(0.3);
    expect(p([paper, doc(3, 1, "a", 0.8, 300)])).toBeCloseTo(
      (Math.log1p(300) - 1.099) / (7.04 - 1.099),
      12,
    );
    // Tài liệu của nguồn có tín hiệu mà chưa lấy được tín hiệu: coi như chưa biết → trung tính.
    expect(p([doc(4, 1, "a", 0.8, null)])).toBe(0.3);
  });

  test("C đếm URL khác nhau, không đếm lượt đăng lại; nguồn thứ hai được thưởng", () => {
    const reposts = components(
      ev(1, [doc(1, 1, "a", 0.8), doc(2, 1, "a", 0.8), doc(3, 1, "a", 0.8)]),
      base,
      cfg,
      start,
      new Set(),
    );
    expect(reposts.C).toBe(0); // 1 URL = trung vị (ln 2) → 0
    const two = components(
      ev(1, [doc(1, 1, "a", 0.8), doc(2, 2, "b", 0.8)]),
      base,
      cfg,
      start,
      new Set(),
    );
    expect(two.C).toBeCloseTo((Math.log(3) + 0.5 - Math.log(2)) / (2.5 - Math.log(2)), 12);
  });

  test("A là uy tín cao nhất trong các nguồn; F = 0,6 khi sự kiện bắt đầu trước khoảng digest", () => {
    const c = components(
      ev(1, [doc(1, 1, "a", 0.8), doc(2, 3, "b", 0.8)], new Date("2026-10-01T00:00:00Z")),
      base,
      cfg,
      start,
      new Set(),
    );
    expect([c.A, c.F]).toEqual([0.8, 0.6]);
  });

  test("N: chưa gửi 1; gửi rồi mà có 1/3 tài liệu mới 0,5 + 0,5/3; gửi rồi không có gì mới 0", () => {
    const e = ev(1, [doc(1, 1, "a", 0.8), doc(2, 1, "b", 0.8), doc(3, 1, "c", 0.8)]);
    expect(components(e, base, cfg, start, new Set()).N).toBe(1);
    expect(components(e, base, cfg, start, new Set([1, 2])).N).toBeCloseTo(0.5 + 0.5 / 3, 12);
    expect(components(e, base, cfg, start, new Set([1, 2, 3])).N).toBe(0);
  });

  test("S với trọng số mặc định", () => {
    expect(
      scoreOf({ R: 1, P: 0.5, C: 0, A: 0.6, F: 1, N: 1, topicId: 1, sourceId: 1 }, cfg),
    ).toBeCloseTo(0.4 + 0.125 + 0.06 + 0.1, 12);
  });
});

/** Ứng viên với điểm cho sẵn, để test thuật toán chọn đúng như ví dụ trong xep-hang.html. */
function cand(id: number, S: number, sourceId = 1, R = 0.9): Scored {
  return { event: ev(id, []), c: { R, P: 0, C: 0, A: 0, F: 0, N: 1, topicId: 1, sourceId }, S };
}

describe("select", () => {
  test("phạt trùng: cặp Nvidia giống 0,901 → 0,3 × 0,51 ≈ 0,15", () => {
    expect(mmrPenalty(0.901, cfg.mmr)).toBeCloseTo(0.153, 3);
    expect(mmrPenalty(0.84, cfg.mmr)).toBe(0);
    expect(mmrPenalty(0.99, cfg.mmr)).toBe(0.3);
  });

  test("ví dụ tab 06: A 0,80 · B 0,78 (giống A 0,901) · C 0,72 · D 0,70 → thứ tự chọn A, C, D, B", () => {
    const sims: Record<string, number> = {
      "1-2": 0.901,
      "1-3": 0.7,
      "1-4": 0.66,
      "3-4": 0.74,
      "2-3": 0.5,
      "2-4": 0.5,
    };
    const sim = (a: RankEvent, b: RankEvent) => {
      const [x, y] = [a.eventId, b.eventId].sort();
      return sims[`${x}-${y}`] ?? 0;
    };
    const all = [cand(1, 0.8), cand(2, 0.78), cand(3, 0.72), cand(4, 0.7)];
    const loose = { ...cfg, floorS: 0, maxPerSource: 7 };
    // Còn 3 chỗ: B (thứ 2 theo S) bị đẩy ra vì trùng A, C và D vào thay.
    const three = select(all, { ...loose, maxItems: 3 }, sim);
    expect(three.picked.map((p) => p.event.eventId)).toEqual([1, 3, 4]);
    // Còn chỗ thứ 4 thì B vẫn vào, ở cuối, sau khi bị phạt 0,153.
    const four = select(all, { ...loose, maxItems: 4 }, sim);
    expect(four.picked).toHaveLength(4);
    expect(four.picked.find((p) => p.event.eventId === 2)?.penalty).toBeCloseTo(0.153, 3);
    // Thứ tự gửi theo điểm sau phạt: B không đứng ngay sau A.
    expect(four.picked.map((p) => p.event.eventId)).toEqual([1, 3, 4, 2]);
  });

  test("ví dụ hạn mức: 7 HN + 1 arXiv + 1 releases; giữ chỗ + tối đa 3/nguồn → 5 tin", () => {
    const hn = [0.8, 0.77, 0.74, 0.71, 0.68, 0.65, 0.62].map((S, i) => cand(i + 1, S, 1));
    const r = select(
      [...hn, cand(20, 0.61, 2), cand(30, 0.63, 3)],
      { ...cfg, maxPerSource: 3 },
      () => 0,
    );
    expect(r.picked.map((p) => p.event.eventId).sort((a, b) => a - b)).toEqual([1, 2, 3, 20, 30]);
    expect(r.rejected.filter((x) => x.reason === "source_cap")).toHaveLength(4);
    const five = select(
      [...hn, cand(20, 0.61, 2), cand(30, 0.63, 3)],
      { ...cfg, maxPerSource: 5 },
      () => 0,
    );
    expect(five.picked).toHaveLength(7);
  });

  test("cổng R, sàn S, tin đã gửi không có gì mới bị loại kèm lý do", () => {
    const notNew = cand(3, 0.9);
    notNew.c.N = 0;
    const r = select([cand(1, 0.9, 1, 0.5), cand(2, 0.5), notNew], cfg, () => 0);
    expect(r.picked).toHaveLength(0);
    expect(r.rejected.map((x) => x.reason).sort()).toEqual(["floor", "gate", "not_new"]);
  });
});
