/**
 * Hai nguồn repo GitHub đang nổi: trang Trending (HTML thật lưu ngày 13/10/2026, rút gọn còn 4
 * repo) và Search API (phản hồi tự soạn theo đúng các trường API trả). HTTP giả, không gọi mạng.
 */
import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@radard/core";
import {
  githubNewReposSource,
  githubTrendingSource,
  isSuspicious,
  newRepoToItem,
  parseTrending,
} from "../src/sources/github-repos.ts";

const TRENDING = await Bun.file(`${import.meta.dir}/fixtures/github-trending.html`).text();

function fakeHttp(reply: (url: string) => string) {
  const urls: string[] = [];
  const http: HttpClient = {
    async get(url) {
      urls.push(url);
      return { status: 200, body: reply(url), headers: new Headers() };
    },
  };
  return { http, urls };
}

const repo = (n: number, over: Record<string, unknown> = {}) => ({
  full_name: `owner${n}/repo${n}`,
  html_url: `https://github.com/owner${n}/repo${n}`,
  description: `Repo ${n}`,
  fork: false,
  created_at: "2026-10-10T00:00:00Z",
  size: 4800,
  stargazers_count: 1000 - n,
  forks_count: 60,
  language: "TypeScript",
  topics: ["agents", "llm"],
  ...over,
});

describe("parseTrending", () => {
  test("đọc tên, mô tả, ngôn ngữ, tổng sao và sao tăng hôm nay từ HTML thật", () => {
    const repos = parseTrending(TRENDING);
    expect(repos.map((r) => [r.fullName, r.starsToday])).toEqual([
      ["morluto/rea", 54706],
      ["bilawalsidhu/gods-eye-view", 1961],
      ["debpalash/VoiceStudio", 1691],
      ["mksglu/context-mode", 978],
    ]);
    expect(repos[0]).toMatchObject({ stars: 195823, language: "TypeScript" });
    expect(repos[0]?.description).toStartWith("Reverse engineer anything with agents");
    expect(repos[0]?.html).toContain('class="Box-row"');
  });

  test("kiểm tra hợp lý: trang trống, thiếu 'stars today', tăng quá tổng sao đều là lỗi", () => {
    expect(() => parseTrending("<html><body></body></html>")).toThrow("không có repo");
    expect(() => parseTrending(TRENDING.replaceAll("stars today", "stars"))).toThrow(
      'thiếu "stars today"',
    );
    expect(() => parseTrending(TRENDING.replace("195,823", "1,000"))).toThrow("> tổng");
  });
});

describe("luật lọc rác (6A)", () => {
  test("< 10 KB, 0 fork, ≥ 300 sao là đáng ngờ; thiếu một điều kiện thì không", () => {
    expect(isSuspicious({ size: 2, forks: 0, stars: 500 })).toBe(true);
    expect(isSuspicious({ size: 2, forks: 1, stars: 500 })).toBe(false);
    expect(isSuspicious({ size: 2, forks: 0, stars: 299 })).toBe(false);
    expect(isSuspicious({ size: 4800, forks: 0, stars: 500 })).toBe(false);
  });

  test("repo đáng ngờ vẫn lưu, có meta.suspicious; repo thường thì không có trường này", () => {
    const bad = newRepoToItem(repo(1, { size: 2, forks_count: 0, stargazers_count: 512 }));
    expect(bad.meta?.suspicious).toBe(true);
    expect(newRepoToItem(repo(2)).meta?.suspicious).toBeUndefined();
  });
});

describe("githubNewReposSource", () => {
  test("hỏi repo tạo trong 7 ngày, nhiều sao; dừng khi trang không đầy; bỏ repo đã lưu trữ", async () => {
    const { http, urls } = fakeHttp(() =>
      JSON.stringify({ items: [repo(1), repo(2, { archived: true }), repo(3)] }),
    );
    const res = await githubNewReposSource.fetch({
      config: { createdDays: 7, minStars: 50, maxRepos: 5 },
      state: undefined,
      http,
      now: new Date("2026-10-13T23:00:00Z"),
    });
    expect(urls).toHaveLength(1);
    expect(decodeURIComponent(urls[0] ?? "")).toContain("created:>2026-10-06 stars:>50 fork:false");
    expect(res.items.map((i) => [i.externalId, i.url, i.title])).toEqual([
      ["owner1/repo1", "https://github.com/owner1/repo1", "owner1/repo1: Repo 1"],
      ["owner3/repo3", "https://github.com/owner3/repo3", "owner3/repo3: Repo 3"],
    ]);
    // Không đặt published_at: "mới" là lúc radard thấy repo nổi.
    expect(res.items[0]?.publishedAt).toBeUndefined();
  });

  test("văn bản để embed gồm tiêu đề, mô tả, topic, ngôn ngữ; README do job pages lấy", () => {
    const item = newRepoToItem(repo(1));
    expect(githubNewReposSource.toText?.(item.body, item.title ?? null)).toBe(
      "owner1/repo1: Repo 1\nRepo 1\nagents, llm\nTypeScript",
    );
    expect(githubNewReposSource.articleUrl?.("owner1/repo1", item.url)).toBe(item.url);
  });

  test("độ nổi = sao mỗi ngày tuổi; repo không còn thì vắng mặt", async () => {
    const { http } = fakeHttp((url) => {
      if (url.endsWith("/gone/x")) throw new Error("404");
      return JSON.stringify({
        stargazers_count: 3000,
        created_at: new Date(Date.now() - 3 * 864e5).toISOString(),
      });
    });
    const s = await githubNewReposSource.refreshSignals?.(["a/b", "gone/x"], http);
    expect([...(s?.keys() ?? [])]).toEqual(["a/b"]);
    const sig = s?.get("a/b") ?? {};
    expect(githubNewReposSource.engagement?.(sig) ?? 0).toBeCloseTo(1000, 0);
    expect(githubNewReposSource.engagement?.({})).toBeNull();
  });
});

describe("githubTrendingSource", () => {
  test("mỗi repo trên trang một tài liệu; độ nổi = sao tăng hôm nay, đọc lại lúc xếp hạng", async () => {
    const { http, urls } = fakeHttp(() => TRENDING);
    const res = await githubTrendingSource.fetch({
      config: {},
      state: undefined,
      http,
      now: new Date(),
    });
    expect(urls).toEqual(["https://github.com/trending"]);
    expect(res.items).toHaveLength(4);
    expect(res.items[0]).toMatchObject({
      externalId: "morluto/rea",
      url: "https://github.com/morluto/rea",
    });

    const s = await githubTrendingSource.refreshSignals?.(["morluto/rea", "khong/con"], http);
    expect(s?.get("morluto/rea")).toEqual({ gh_stars_today: 54706 });
    expect(s?.has("khong/con")).toBe(false);
    expect(githubTrendingSource.engagement?.({ gh_stars_today: 978 })).toBe(978);
  });
});
