import { describe, expect, test } from "bun:test";
import {
  baselineVariant,
  bootstrapMean,
  defineVariant,
  type EvalDay,
  type EvalSample,
  fingerprintOf,
  formatEvalReport,
  type Level,
  mulberry32,
  ndcg,
  ndcgOfDay,
  oracleVariant,
  pairwiseOfDay,
  parseSnapshot,
  REFERENCE_VARIANTS,
  randomVariant,
  runEval,
  splitDays,
  toSnapshot,
  verdictOf,
} from "../src/index.ts";

function sample(date: string, position: number, level: Level, R = 0.5): EvalSample {
  return {
    date,
    position,
    urls: [`https://x.com/${date}/${position}`],
    level,
    score: { S: 0, penalty: 0, R, P: 0.3, C: 0.2, A: 0.5, F: 1, N: 1 },
  };
}
const dayOf = (date: string, levels: Level[], R?: (i: number) => number): EvalDay => ({
  date,
  samples: levels.map((l, i) => sample(date, i + 1, l, R?.(i))),
});

describe("NDCG", () => {
  // Gain 2,2,1,0 theo thứ tự P,Q,R,S
  const gains = { P: 2, Q: 2, R: 1, S: 0 };

  test("thứ tự lý tưởng: DCG = 2/1 + 2/1,585 + 1/2 = 3,76 và NDCG = 1", () => {
    const order = [gains.P, gains.Q, gains.R, gains.S];
    const dcg = 2 / 1 + 2 / Math.log2(3) + 1 / 2 + 0;
    expect(dcg).toBeCloseTo(3.76, 2);
    expect(ndcg(order)).toBeCloseTo(1, 12);
  });

  test("thứ tự ngược S,R,P,Q: DCG = 2,49, NDCG = 0,66", () => {
    const order = [gains.S, gains.R, gains.P, gains.Q];
    const dcg = 0 / 1 + 1 / Math.log2(3) + 2 / 2 + 2 / Math.log2(5);
    expect(dcg).toBeCloseTo(2.49, 2);
    expect(ndcg(order)).toBeCloseTo(0.66, 2);
  });

  test("ndcgOfDay xếp theo điểm giảm dần, điểm bằng nhau thì theo vị trí", () => {
    const d = dayOf("2026-10-20", ["like", "like", "none", "dislike"]);
    expect(ndcgOfDay(d.samples, [4, 3, 2, 1])).toBeCloseTo(1, 12);
    expect(ndcgOfDay(d.samples, [1, 2, 3, 4])).toBeCloseTo(0.66, 2);
    // mọi điểm bằng nhau: giữ thứ tự gửi, ở đây trùng thứ tự lý tưởng
    expect(ndcgOfDay(d.samples, [0, 0, 0, 0])).toBeCloseTo(1, 12);
  });
});

describe("độ chính xác theo cặp", () => {
  const d = dayOf("2026-10-20", ["like", "none", "dislike"]);

  test("điểm giảm đúng nhãn: mọi cặp đúng; cặp sạch chỉ 👍–👎", () => {
    const r = pairwiseOfDay(d.samples, [3, 2, 1]);
    expect(r.all).toEqual({ pairs: 3, correct: 3 });
    expect(r.clean).toEqual({ pairs: 1, correct: 1 });
  });

  test("ngược hẳn: 0 đúng; điểm bằng nhau tính 0,5", () => {
    expect(pairwiseOfDay(d.samples, [1, 2, 3]).all).toEqual({ pairs: 3, correct: 0 });
    expect(pairwiseOfDay(d.samples, [1, 1, 1])).toEqual({
      clean: { pairs: 1, correct: 0.5 },
      all: { pairs: 3, correct: 1.5 },
    });
  });

  test("cặp cùng mức không được đếm", () => {
    const same = dayOf("2026-10-21", ["like", "like", "none"]);
    expect(pairwiseOfDay(same.samples, [1, 2, 3]).all.pairs).toBe(2);
    expect(pairwiseOfDay(same.samples, [1, 2, 3]).clean.pairs).toBe(0);
  });
});

describe("bootstrap", () => {
  test("mulberry32 xác định và nằm trong [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 50; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  test("cùng dữ liệu cho cùng khoảng; hiệu hằng số cho khoảng hẹp bằng chính nó", () => {
    const diffs = [0.1, -0.05, 0.2, 0.0, 0.15, 0.3];
    expect(bootstrapMean(diffs)).toEqual(bootstrapMean(diffs));
    const c = bootstrapMean([0.2, 0.2, 0.2, 0.2]);
    expect(c.lo).toBeCloseTo(0.2, 12);
    expect(c.hi).toBeCloseTo(0.2, 12);
  });

  test("kết luận: thắng chỉ khi cận dưới > 0", () => {
    expect(verdictOf({ lo: 0.01, hi: 0.2 })).toBe("win");
    expect(verdictOf({ lo: -0.01, hi: 0.2 })).toBe("tie");
    expect(verdictOf({ lo: -0.2, hi: -0.01 })).toBe("lose");
    expect(verdictOf({ lo: 0, hi: 0 })).toBe("tie");
  });
});

describe("chia ngày: tập khoá kín", () => {
  test("ngày có thông tin thứ k (từ 0) là khoá kín nếu k % 4 === 3; ngày không thông tin đứng ngoài", () => {
    const days: EvalDay[] = [];
    for (let i = 1; i <= 10; i++) {
      const date = `2026-10-${String(i).padStart(2, "0")}`;
      // ngày 5 không thông tin
      days.push(dayOf(date, i === 5 ? ["none", "none"] : ["like", "dislike"]));
    }
    // đảo thứ tự vào để chắc chắn splitDays tự sắp theo ngày
    const s = splitDays([...days].reverse());
    expect(s.uninformative.map((d) => d.date)).toEqual(["2026-10-05"]);
    // có thông tin: 01,02,03,04,06,07,08,09,10 → k=3 là 04, k=7 là 09
    expect(s.closed.map((d) => d.date)).toEqual(["2026-10-04", "2026-10-09"]);
    expect(s.regular.map((d) => d.date)).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-10",
    ]);
  });
});

/** 12 ngày; R của tin càng cao thì càng được 👍 (baseline có tín hiệu). */
function twelveDays(): EvalDay[] {
  const out: EvalDay[] = [];
  for (let i = 1; i <= 12; i++) {
    const date = `2026-10-${String(i).padStart(2, "0")}`;
    out.push(dayOf(date, ["like", "none", "none", "dislike"], (k) => 0.9 - k * 0.2));
  }
  return out;
}

describe("bộ chấm", () => {
  test("oracle: NDCG = 1 ở mọi ngày, mọi cặp đúng", () => {
    const r = runEval(twelveDays(), REFERENCE_VARIANTS, { includeClosed: true });
    const oracle = r.variants.find((v) => v.name === "oracle");
    expect(oracle).toBeDefined();
    for (const d of oracle?.regular.days ?? []) expect(d.ndcg).toBeCloseTo(1, 12);
    for (const d of oracle?.closed?.days ?? []) expect(d.ndcg).toBeCloseTo(1, 12);
    expect(oracle?.regular.pairwise.all.correct).toBe(oracle?.regular.pairwise.all.pairs);
    expect(oracle?.vsBaselineRegular?.verdict).not.toBe("lose");
  });

  test("baseline đứng đầu và so với chính nó là hoà, hiệu 0", () => {
    const r = runEval(twelveDays(), [randomVariant, baselineVariant, oracleVariant]);
    expect(r.variants.map((v) => v.name)).toEqual(["baseline", "random", "oracle"]);
    expect(r.variants[0]?.vsBaselineRegular).toBeUndefined();
  });

  test("xác định: cùng dữ liệu, cùng báo cáo (kể cả random và bootstrap)", () => {
    const a = runEval(twelveDays(), REFERENCE_VARIANTS, { includeClosed: true });
    const b = runEval(twelveDays(), REFERENCE_VARIANTS, { includeClosed: true });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(formatEvalReport(a)).toBe(formatEvalReport(b));
  });

  test("mặc định không có tập khoá kín và không có kết luận chung", () => {
    const r = runEval(twelveDays(), REFERENCE_VARIANTS);
    expect(r.closedIncluded).toBe(false);
    for (const v of r.variants) {
      expect(v.closed).toBeUndefined();
      expect(v.accepted).toBeUndefined();
    }
    expect(formatEvalReport(r)).not.toContain("Tập khoá kín:");
  });

  test("trọng số baseline là bản sao cứng, không đọc cấu hình đang chạy", () => {
    const s = sample("2026-10-01", 1, "none");
    s.score = { S: 99, penalty: 0, R: 1, P: 1, C: 1, A: 1, F: 1, N: 0.5 };
    expect(baselineVariant.score(s, undefined)).toBeCloseTo(
      0.5 * (0.4 + 0.25 + 0.15 + 0.1 + 0.1),
      12,
    );
  });

  test("bỏ-một-ngày: fit không bao giờ thấy ngày được chấm, cũng không thấy ngày khoá kín", () => {
    const seen: string[][] = [];
    const spy = defineVariant({
      name: "spy",
      fit: (train: readonly EvalDay[]) => {
        seen.push(train.map((d) => d.date));
        return 0;
      },
      score: (item: EvalSample) => item.score.R,
    });
    const days = twelveDays();
    const r = runEval(days, [spy], { includeClosed: true });
    const closed = new Set(["2026-10-04", "2026-10-08", "2026-10-12"]);
    expect(r.split.closed).toBe(3);
    // 9 ngày thường bỏ-một-ngày + 1 lần fit cho tập khoá kín
    expect(seen).toHaveLength(9 + 1);
    for (const train of seen) for (const d of train) expect(closed.has(d)).toBe(false);
    const regularDays =
      r.variants.find((v) => v.name === "spy")?.regular.days.map((d) => d.date) ?? [];
    seen.slice(0, 9).forEach((train, i) => {
      expect(train).toHaveLength(8);
      expect(train).not.toContain(regularDays[i] as string);
    });
  });

  test("biến thể tốt hơn hẳn thắng ở cả hai tập → nhận; tập khoá kín quá nhỏ → chưa đủ dữ liệu", () => {
    // baseline xếp ngược nhãn (R tăng theo vị trí), oracle xếp đúng
    const days: EvalDay[] = [];
    for (let i = 1; i <= 12; i++) {
      days.push(
        dayOf(
          `2026-10-${String(i).padStart(2, "0")}`,
          ["like", "none", "none", "dislike"],
          (k) => k * 0.2,
        ),
      );
    }
    const full = runEval(days, [oracleVariant], { includeClosed: true });
    expect(full.variants[1]?.vsBaselineRegular?.verdict).toBe("win");
    expect(full.variants[1]?.accepted).toBe("accept");

    const small = runEval(days.slice(0, 9), [oracleVariant], { includeClosed: true });
    expect(small.split.closed).toBe(2);
    expect(small.variants[1]?.vsBaselineClosed?.verdict).toBeNull();
    expect(small.variants[1]?.accepted).toBe("insufficient");
    expect(formatEvalReport(small)).toContain("chưa đủ dữ liệu");
  });

  test("random thua hoặc hoà baseline trên dữ liệu mà baseline có tín hiệu", () => {
    const r = runEval(twelveDays(), [randomVariant]);
    expect(r.variants[1]?.vsBaselineRegular?.verdict).not.toBe("win");
  });
});

describe("vân tay và ảnh chụp", () => {
  test("vân tay không phụ thuộc thứ tự nhập; đếm đúng 👍/👎/ngày/mẫu", () => {
    const days = [
      dayOf("2026-10-02", ["like", "dislike", "none"]),
      dayOf("2026-10-01", ["none", "none"]),
    ];
    const f = fingerprintOf(days);
    expect(f).toMatchObject({
      days: 2,
      informativeDays: 1,
      uninformativeDays: 1,
      samples: 5,
      likes: 1,
      dislikes: 1,
    });
    expect(f.sha256).toBe(fingerprintOf([...days].reverse()).sha256);
    const changed = [dayOf("2026-10-02", ["dislike", "like", "none"]), days[1] as EvalDay];
    expect(fingerprintOf(changed).sha256).not.toBe(f.sha256);
  });

  test("xuất rồi nhập lại cho đúng cùng báo cáo", () => {
    const days = twelveDays();
    const back = parseSnapshot(JSON.parse(JSON.stringify(toSnapshot(days))));
    expect(back).toEqual(days);
    expect(formatEvalReport(runEval(back, REFERENCE_VARIANTS, { includeClosed: true }))).toBe(
      formatEvalReport(runEval(days, REFERENCE_VARIANTS, { includeClosed: true })),
    );
  });

  test("ảnh chụp sai dạng thì ném lỗi rõ ràng", () => {
    expect(() => parseSnapshot({ version: 2, days: [] })).toThrow("không hợp lệ");
    expect(() =>
      parseSnapshot({ version: 1, days: [{ date: "2026-10-01", samples: [{ position: 1 }] }] }),
    ).toThrow("không hợp lệ");
  });
});
