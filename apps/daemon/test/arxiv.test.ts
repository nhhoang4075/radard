import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@radard/core";
import {
  arxivMinute,
  arxivSource,
  entryToItem,
  parseArxivId,
  splitEntries,
  totalResults,
} from "../src/sources/arxiv.ts";

const fixture = await Bun.file(new URL("./fixtures/arxiv-query.xml", import.meta.url)).text();

/** Build a minimal entry with the given publication time. */
const entry = (id: string, published: string) => `<entry>
  <id>http://arxiv.org/abs/${id}v1</id><title>Bài ${id}</title><summary>s</summary>
  <published>${published}</published><updated>${published}</updated>
  <author><name>A</name></author><category term="cs.CL"/>
</entry>`;

/**
 * Fake arXiv: understands `submittedDate:[YYYYMMDDHHMM TO YYYYMMDDHHMM]` (both ends inclusive), `start`,
 * `max_results`, and returns `opensearch:totalResults` like the real API.
 */
function fakeArxiv(papers: Array<{ id: string; published: string }>) {
  const urls: string[] = [];
  const toMin = (s: string) =>
    Date.UTC(
      +s.slice(0, 4),
      +s.slice(4, 6) - 1,
      +s.slice(6, 8),
      +s.slice(8, 10),
      +s.slice(10, 12),
    ) / 60_000;
  const http: HttpClient = {
    post: () => Promise.reject(new Error("test này không POST")),
    async get(url) {
      urls.push(url);
      const q = new URL(url).searchParams;
      const m = /submittedDate:\[(\d{12}) TO (\d{12})\]/.exec(q.get("search_query") ?? "");
      const lo = m ? toMin(m[1] ?? "") : -Infinity;
      const hi = m ? toMin(m[2] ?? "") : Infinity;
      const match = papers
        .filter((p) => {
          const t = Math.floor(Date.parse(p.published) / 60_000);
          return t >= lo && t <= hi;
        })
        .sort((a, b) => a.published.localeCompare(b.published));
      const start = Number(q.get("start"));
      const page = match.slice(start, start + Number(q.get("max_results")));
      const body = `<feed><opensearch:totalResults xmlns:opensearch="x">${match.length}</opensearch:totalResults>${page
        .map((p) => entry(p.id, p.published))
        .join("")}</feed>`;
      return { status: 200, body, headers: new Headers() };
    },
  };
  return { http, urls };
}

describe("parse", () => {
  test("bỏ hậu tố phiên bản khỏi id", () => {
    expect(parseArxivId("http://arxiv.org/abs/2609.31619v2")).toEqual({
      id: "2609.31619",
      version: "v2",
    });
    expect(parseArxivId("http://arxiv.org/abs/cs/0112017v1").id).toBe("cs/0112017");
  });

  test("đọc được phản hồi thật đã lưu làm fixture", () => {
    const raws = splitEntries(fixture);
    expect(raws.length).toBe(3);
    for (const raw of raws) {
      const item = entryToItem(raw);
      expect(item.externalId).toMatch(/^\d{4}\.\d{4,5}$/);
      expect(item.url).toBe(`https://arxiv.org/abs/${item.externalId}`);
      expect(item.title).not.toContain("\n");
      expect(item.body).toStartWith("<entry>");
      expect((item.meta?.authors as string[] | undefined)?.length).toBeGreaterThan(0);
      expect(item.meta?.categories).toBeArray();
    }
  });
});

describe("helpers", () => {
  test("phút Unix ↔ định dạng submittedDate", () => {
    expect(arxivMinute(Date.parse("2026-09-01T07:34:00Z") / 60_000)).toBe("202609010734");
  });
  test("đọc totalResults", () => {
    expect(totalResults(fixture)).toBe(473927);
  });
});

describe("arxivSource.fetch", () => {
  const now = new Date("2026-10-06T02:00:00Z");
  const config = { categories: ["cs.CL", "cs.AI"], lookbackDays: 5 };
  const ids = (items: { externalId: string }[]) =>
    [...new Set(items.map((i) => i.externalId))].sort();
  const spread = (n: number, fromIso: string, days: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `2609.${String(i + 1).padStart(5, "0")}`,
      published: new Date(Date.parse(fromIso) + Math.floor((i * days * 86_400_000) / n))
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
    }));

  test("truy vấn theo thể loại và khoảng submittedDate", async () => {
    const api = fakeArxiv([]);
    await arxivSource.fetch({
      config,
      state: { lastPublished: "2026-10-05T00:00:00.000Z" },
      http: api.http,
      now,
    });
    const q = new URL(api.urls[0] ?? "").searchParams.get("search_query");
    expect(q).toBe("(cat:cs.CL OR cat:cs.AI) AND submittedDate:[202609300000 TO 202610060200]");
  });

  test("bài công bố muộn, nộp trước con trỏ, vẫn được đọc; con trỏ không lùi", async () => {
    const api = fakeArxiv([{ id: "2609.00009", published: "2026-10-03T18:00:00Z" }]);
    const res = await arxivSource.fetch({
      config,
      state: { lastPublished: "2026-10-05T10:00:00.000Z" },
      http: api.http,
      now,
    });
    expect(ids(res.items)).toEqual(["2609.00009"]);
    expect(Date.parse(res.state.lastPublished)).toBe(now.getTime());
  });

  test("daemon tắt 13 ngày, 4.500 bài: lấy đủ, cửa sổ tự thu hẹp dưới 2.000", async () => {
    const papers = spread(4500, "2026-09-21T00:00:00Z", 15);
    const api = fakeArxiv(papers);
    const res = await arxivSource.fetch({
      config,
      state: { lastPublished: "2026-09-25T17:59:52.000Z" },
      http: api.http,
      now,
    });
    const want = papers
      .filter((p) => p.published >= "2026-09-20T17:59")
      .map((p) => p.id)
      .sort();
    expect(ids(res.items)).toEqual(want);
    expect(res.behind).toBeUndefined();
  });

  test("hết ngân sách: lượt sau đọc tiếp, không sót", async () => {
    const papers = spread(4500, "2026-09-21T00:00:00Z", 15);
    const api = fakeArxiv(papers);
    const state = { lastPublished: "2026-09-26T00:00:00.000Z" };
    const first = await arxivSource.fetch({
      config: { ...config, maxPerRun: 1500 },
      state,
      http: api.http,
      now,
    });
    expect(first.behind).toContain("ngân sách");
    const second = await arxivSource.fetch({ config, state: first.state, http: api.http, now });
    expect(second.behind).toBeUndefined();
    const want = papers
      .filter((p) => p.published >= "2026-09-21T00:00")
      .map((p) => p.id)
      .sort();
    expect(ids([...first.items, ...second.items])).toEqual(want);
  });
});
