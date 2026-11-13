import { describe, expect, test } from "bun:test";
import { pickNotify } from "../src/feed.ts";
import { percentileFloor } from "../src/floor.ts";

const item = (position: number, S: number, sourceId = 1) => ({ position, S, sourceId });

describe("pickNotify (lớp thông báo)", () => {
  test("tối đa 7 tin ĐẦU của bản chụp không có sàn riêng, theo vị trí", () => {
    const items = Array.from({ length: 12 }, (_, i) => item(i + 1, 0.7, (i % 3) + 1));
    const out = pickNotify(items, { maxItems: 7, maxPerSource: 5 });
    expect(out.map((x) => x.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("không có sàn thông báo: tin điểm thấp ở đầu bản chụp vẫn được báo; ít tin hơn 7 thì báo ít hơn 7", () => {
    const items = [item(1, 0.5), item(2, 0.8), item(3, 0.55), item(4, 0.61)];
    expect(pickNotify(items, { maxItems: 7, maxPerSource: 5 }).map((x) => x.position)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  test("5 tin mỗi nguồn trong 7 tin báo", () => {
    const items = [...Array.from({ length: 8 }, (_, i) => item(i + 1, 0.9, 1)), item(9, 0.9, 2)];
    const out = pickNotify(items, { maxItems: 7, maxPerSource: 5 });
    expect(out.map((x) => x.position)).toEqual([1, 2, 3, 4, 5, 9]);
  });

  test("không phụ thuộc thứ tự đầu vào", () => {
    const items = [item(3, 0.9), item(1, 0.9), item(2, 0.9)];
    expect(pickNotify(items, { maxItems: 2, maxPerSource: 5 }).map((x) => x.position)).toEqual([
      1, 2,
    ]);
  });
});

describe("sàn feed: n ≤ mục tiêu thì không lọc", () => {
  test("q kẹp = 0 với noFilterAtZeroQ cho sàn 0; không có cờ thì giữ cách cũ (điểm thấp nhất)", () => {
    const scores = Array.from({ length: 14 * 20 }, (_, i) => 0.3 + (i % 20) * 0.01);
    const feed = percentileFloor({
      scores,
      days: 14,
      fixed: 0.59,
      targetPerDay: 30,
      noFilterAtZeroQ: true,
    });
    expect(feed).toEqual({ value: 0, source: "percentile", q: 0, n: 20, days: 14 });
    const old = percentileFloor({ scores, days: 14, fixed: 0.59, targetPerDay: 30 });
    expect(old.value).toBeCloseTo(0.3, 9);
  });

  test("dưới 14 ngày vẫn dùng sàn cố định", () => {
    const r = percentileFloor({
      scores: [0.9],
      days: 13,
      fixed: 0.59,
      targetPerDay: 30,
      noFilterAtZeroQ: true,
    });
    expect(r).toEqual({ value: 0.59, source: "fixed", days: 13 });
  });
});
