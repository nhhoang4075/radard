import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@radard/core";
import { hitToItem, hnItemUrl, hnSource } from "../src/sources/hn.ts";
import fixture from "./fixtures/hn-search.json";

describe("hitToItem", () => {
  test("đọc được phản hồi thật đã lưu làm fixture", () => {
    const items = fixture.hits.map(hitToItem);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.externalId).toMatch(/^\d+$/);
      expect(item.url).toStartWith("http");
      expect(item.publishedAt).toBeInstanceOf(Date);
      expect(JSON.parse(item.body).objectID).toBe(item.externalId);
    }
  });

  test("Ask HN không có link ngoài thì dùng trang thảo luận", () => {
    const item = hitToItem({ objectID: "42", title: "Ask HN", url: null, created_at_i: 1 });
    expect(item.url).toBe(hnItemUrl("42"));
  });
});

/**
 * Fake Algolia: understands `numericFilters` in the form `created_at_i>lo,created_at_i<=hi`, sorts newest first,
 * and only paginates up to 1,000 results like the real API. Records the size of each window queried.
 */
function fakeAlgolia(times: number[], opts: { failAt?: number } = {}) {
  const urls: string[] = [];
  const hits = times.map((t, i) => ({
    objectID: String(i + 1),
    title: `s${i + 1}`,
    created_at_i: t,
  }));
  const http: HttpClient = {
    post: () => Promise.reject(new Error("test này không POST")),
    async get(url) {
      urls.push(url);
      if (opts.failAt === urls.length) throw new Error("mạng chập chờn");
      const q = new URL(url).searchParams;
      const [lo, hi] = (q.get("numericFilters") ?? "").match(/-?\d+/g)?.map(Number) ?? [];
      const size = Number(q.get("hitsPerPage"));
      const page = Number(q.get("page"));
      const match = hits
        .filter((h) => h.created_at_i > (lo ?? -Infinity) && h.created_at_i <= (hi ?? Infinity))
        .sort((a, b) => b.created_at_i - a.created_at_i);
      const reachable = match.slice(0, 1000);
      const body = {
        hits: reachable.slice(page * size, (page + 1) * size),
        nbHits: match.length,
        nbPages: Math.ceil(reachable.length / size),
        page,
      };
      return { status: 200, body: JSON.stringify(body), headers: new Headers() };
    },
  };
  return { http, urls, all: hits.map((h) => h.objectID) };
}

describe("hnSource.fetch", () => {
  const now = new Date("2026-10-06T02:00:00Z");
  const nowSec = now.getTime() / 1000;
  const ids = (items: { externalId: string }[]) =>
    [...new Set(items.map((i) => i.externalId))].sort();

  test("lần đầu lấy lùi theo backfillHours; con trỏ = hiện tại", async () => {
    const api = fakeAlgolia([nowSec - 100, nowSec - 50, nowSec - 9000]);
    const res = await hnSource.fetch({
      config: { backfillHours: 2 },
      state: undefined,
      http: api.http,
      now,
    });

    expect(ids(res.items)).toEqual(["1", "2"]);
    expect(decodeURIComponent(api.urls[0] ?? "")).toContain(
      `created_at_i>${nowSec - 7200},created_at_i<=${nowSec}`,
    );
    expect(res.state.lastCreatedAt).toBe(nowSec);
    expect(res.behind).toBeUndefined();
  });

  test("chạy bình thường (15 phút) chỉ tốn 1 request, lùi 300 giây để không sót", async () => {
    const api = fakeAlgolia([nowSec - 600]);
    const res = await hnSource.fetch({
      config: {},
      state: { lastCreatedAt: nowSec - 900 },
      http: api.http,
      now,
    });
    expect(api.urls).toHaveLength(1);
    expect(decodeURIComponent(api.urls[0] ?? "")).toContain(`created_at_i>${nowSec - 1200}`);
    expect(ids(res.items)).toEqual(["1"]);
  });

  test("daemon tắt 8 ngày, 7.000 story: lấy đủ, không cửa sổ nào vượt 1.000", async () => {
    const start = nowSec - 8 * 86400;
    const times = Array.from(
      { length: 7000 },
      (_, i) => start + 1 + Math.floor((i * 8 * 86400) / 7000),
    );
    const api = fakeAlgolia(times);
    const res = await hnSource.fetch({
      config: {},
      state: { lastCreatedAt: start + 300 },
      http: api.http,
      now,
    });

    expect(ids(res.items)).toEqual([...api.all].sort());
    expect(res.state.lastCreatedAt).toBe(nowSec);
    expect(res.behind).toBeUndefined();
  });

  test("hết ngân sách: dừng ở cuối cửa sổ đã lấy đủ, lượt sau lấy nốt, không sót", async () => {
    const start = nowSec - 8 * 86400;
    const times = Array.from(
      { length: 7000 },
      (_, i) => start + 1 + Math.floor((i * 8 * 86400) / 7000),
    );
    const api = fakeAlgolia(times);
    const first = await hnSource.fetch({
      config: { maxPerRun: 2500 },
      state: { lastCreatedAt: start + 300 },
      http: api.http,
      now,
    });
    expect(first.behind).toContain("ngân sách");
    expect(first.state.lastCreatedAt).toBeLessThan(nowSec);
    // Every story up to the cursor is already present: no gap behind the cursor.
    const got = new Set(ids(first.items));
    const beforeCursor = api.all.filter((_, i) => (times[i] ?? 0) <= first.state.lastCreatedAt);
    expect(beforeCursor.every((id) => got.has(id))).toBe(true);

    const second = await hnSource.fetch({
      config: { maxPerRun: 10_000 },
      state: first.state,
      http: api.http,
      now,
    });
    expect(second.behind).toBeUndefined();
    expect(ids([...first.items, ...second.items])).toEqual([...api.all].sort());
  });

  test("lỗi mạng sau khi đã xong vài cửa sổ: giữ phần đã có; lỗi ngay đầu: ném lỗi", async () => {
    const start = nowSec - 8 * 86400;
    const times = Array.from(
      { length: 7000 },
      (_, i) => start + 1 + Math.floor((i * 8 * 86400) / 7000),
    );
    const state = { lastCreatedAt: start + 300 };

    const mid = await hnSource.fetch({
      config: {},
      state,
      http: fakeAlgolia(times, { failAt: 40 }).http,
      now,
    });
    expect(mid.behind).toContain("lỗi giữa chừng");
    expect(mid.items.length).toBeGreaterThan(0);
    expect(mid.state.lastCreatedAt).toBeGreaterThan(state.lastCreatedAt);

    await expect(
      hnSource.fetch({ config: {}, state, http: fakeAlgolia(times, { failAt: 1 }).http, now }),
    ).rejects.toThrow("mạng chập chờn");
  });
});
