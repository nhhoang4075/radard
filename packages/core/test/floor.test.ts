import { describe, expect, test } from "bun:test";
import { percentileFloor } from "../src/floor.ts";

describe("percentileFloor", () => {
  test("dưới 14 ngày: sàn cố định", () => {
    expect(percentileFloor({ scores: [0.9, 0.8], days: 13, fixed: 0.59 })).toEqual({
      value: 0.59,
      source: "fixed",
      days: 13,
    });
  });

  test("điểm rỗng: sàn cố định", () => {
    expect(percentileFloor({ scores: [], days: 20, fixed: 0.59 }).source).toBe("fixed");
  });

  test("n = 40 → q = 0,7; 20 điểm 1…20 trong 0,5 ngày? dùng 2 ngày × 20 điểm", () => {
    // 40 points 1..40 in 1 day (minDays 1): n = 40, q = 0,7, position 39 × 0,7 = 27,3 → 28 + 0,3 = 28,3.
    const scores = Array.from({ length: 40 }, (_, i) => i + 1);
    const r = percentileFloor({ scores, days: 1, fixed: 0.59, minDays: 1 });
    expect(r.q).toBeCloseTo(0.7, 12);
    expect(r.n).toBe(40);
    expect(r.value).toBeCloseTo(28.3, 9);
  });

  test("n ≤ 12: q = 0, sàn là điểm nhỏ nhất", () => {
    const r = percentileFloor({ scores: [0.4, 0.2, 0.9], days: 1, fixed: 0.59, minDays: 1 });
    expect(r.q).toBe(0);
    expect(r.value).toBe(0.2);
  });

  test("n rất lớn: q kẹp ở 0,99", () => {
    const scores = Array.from({ length: 5000 }, (_, i) => i);
    // n = 5000, 1 − 12/5000 = 0,9976 → 0,99; position 4999 × 0,99 = 4949,01.
    const r = percentileFloor({ scores, days: 1, fixed: 0.59, minDays: 1 });
    expect(r.q).toBe(0.99);
    expect(r.value).toBeCloseTo(4949.01, 6);
  });
});
