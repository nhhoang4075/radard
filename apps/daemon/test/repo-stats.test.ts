/**
 * `repo_stats` trên database test thật: chụp số sao qua GraphQL (HTTP giả, không gọi mạng), tập repo
 * theo dõi, tăng 24 giờ với luật ≥ 20 giờ, tăng tốc, cách tạm khi mới có một lần đo, ghi lần đọc
 * trang Trending lúc fetch, và tín hiệu `gh_gain_24h` mà job signals ghi cho xếp hạng.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsObjectStore } from "@radard/adapters/object-store-fs";
import type { HttpClient } from "@radard/core";
import {
  createDatabase,
  docSignals,
  documents,
  repoStats,
  runMigrations,
  sources,
} from "@radard/db";
import { asc, eq, sql } from "drizzle-orm";
import { runFetch } from "../src/jobs/fetch.ts";
import {
  growthOf,
  listRepos,
  type Observation,
  repoOfDoc,
  runRepoStats,
  trackedRepos,
} from "../src/jobs/repo-stats.ts";
import { refreshSignals } from "../src/jobs/signals.ts";
import {
  fetchStarCounts,
  githubNewReposSource,
  githubTrendingSource,
} from "../src/sources/github-repos.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const HOUR = 3_600_000;
const TRENDING = await Bun.file(`${import.meta.dir}/fixtures/github-trending.html`).text();

/** GraphQL giả: trả sao theo tên repo trong truy vấn; repo trong `gone` coi như đã bị xoá. */
function fakeGraphql(stars: Record<string, number>, gone: string[] = []) {
  const queries: string[] = [];
  const http: HttpClient = {
    get: () => Promise.reject(new Error("test này không GET")),
    async post(url, body, opts) {
      expect(url).toBe("https://api.github.com/graphql");
      expect(opts?.headers?.["content-type"]).toBe("application/json");
      const query = (JSON.parse(body) as { query: string }).query;
      queries.push(query);
      const data: Record<string, unknown> = {};
      const errors: { message: string }[] = [];
      for (const m of query.matchAll(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)) {
        const [, alias = "", owner, name] = m;
        const repo = `${owner}/${name}`;
        if (gone.includes(repo)) {
          data[alias] = null;
          errors.push({ message: `Could not resolve to a Repository with the name '${repo}'.` });
        } else data[alias] = { stargazerCount: stars[repo] ?? 0, forkCount: 7 };
      }
      return { status: 200, body: JSON.stringify({ data, errors }), headers: new Headers() };
    },
  };
  return { http, queries };
}

const ids: Record<string, number> = {};
let seq = 0;

async function addDoc(
  kind: string,
  externalId: string,
  url: string,
  opts: { meta?: Record<string, unknown>; fetchedAt?: Date } = {},
): Promise<number> {
  const id = ++seq;
  const [row] = await db
    .insert(documents)
    .values({
      sourceId: ids[kind] ?? 0,
      externalId,
      url,
      urlCanonical: url,
      title: externalId,
      fetchedAt: opts.fetchedAt ?? new Date(),
      contentSha256: `sha${id}`,
      rawKey: `raw/${id}`,
      contentType: "application/json",
      meta: opts.meta ?? {},
    })
    .returning({ id: documents.id });
  return row?.id ?? 0;
}

async function observe(repo: string, at: Date, stars: number, extra: Partial<Observation> = {}) {
  await db.insert(repoStats).values({
    repo,
    observedAt: at,
    stars,
    forks: extra.forks ?? null,
    source: (extra.source as "github_stars" | "trending_daily" | undefined) ?? "github_stars",
    reportedGain: extra.reportedGain ?? null,
  });
}

const obs = (hoursAgo: number, stars: number, now: Date): Observation => ({
  at: new Date(now.getTime() - hoursAgo * HOUR),
  stars,
  forks: null,
  source: "github_stars",
  reportedGain: null,
});

beforeAll(async () => {
  await runMigrations(TEST_URL);
  process.env.GITHUB_TOKEN = "test-token";
});

beforeEach(async () => {
  await db.execute(sql`truncate sources, documents, repo_stats restart identity cascade`);
  const rows = await db
    .insert(sources)
    .values([
      { kind: "github_new_repos", name: "GitHub mới", cadence: "0 23 * * *" },
      { kind: "github_trending", name: "GitHub Trending", cadence: "10 23 * * *" },
      { kind: "hn", name: "HN", cadence: "*/15 * * * *" },
    ])
    .returning({ id: sources.id, kind: sources.kind });
  for (const r of rows) ids[r.kind] = r.id;
});

afterAll(async () => {
  delete process.env.GITHUB_TOKEN;
  await db.$bun.close();
});

describe("fetchStarCounts", () => {
  test("chia lô theo batchSize, mỗi repo một bí danh; repo đã xoá vắng mặt; tên lạ bị bỏ", async () => {
    const { http, queries } = fakeGraphql({ "a/one": 10, "b/two": 20, "c/x.y": 30 }, ["d/gone"]);
    const out = await fetchStarCounts(
      ["a/one", "b/two", "c/x.y", "d/gone", "e/five", 'bad"/name'],
      http,
      2,
    );
    expect(queries).toHaveLength(3);
    expect(queries[0]).toBe(
      '{ r0: repository(owner: "a", name: "one") { stargazerCount forkCount } r1: repository(owner: "b", name: "two") { stargazerCount forkCount } }',
    );
    expect(queries[2]).toContain('r0: repository(owner: "e", name: "five")');
    expect([...out]).toEqual([
      ["a/one", { stars: 10, forks: 7 }],
      ["b/two", { stars: 20, forks: 7 }],
      ["c/x.y", { stars: 30, forks: 7 }],
      ["e/five", { stars: 0, forks: 7 }],
    ]);
  });

  test("100 repo mỗi request mặc định; lô không có data (token sai…) là lỗi", async () => {
    const { http, queries } = fakeGraphql({});
    await fetchStarCounts(
      Array.from({ length: 250 }, (_, i) => `o/r${i}`),
      http,
    );
    expect(queries.map((q) => q.match(/repository\(/g)?.length)).toEqual([100, 100, 50]);

    const broken: HttpClient = {
      get: () => Promise.reject(new Error("không GET")),
      post: async () => ({
        status: 200,
        body: JSON.stringify({ data: null, errors: [{ message: "Bad credentials" }] }),
        headers: new Headers(),
      }),
    };
    await expect(fetchStarCounts(["a/b"], broken)).rejects.toThrow("Bad credentials");
  });
});

describe("tập theo dõi", () => {
  test("repo mới, Trending, bài HN link tới repo, trong 30 ngày; bỏ repo đáng ngờ", async () => {
    const now = new Date();
    await addDoc("github_new_repos", "Alice/One", "https://github.com/Alice/One", {
      meta: { createdAt: "2026-10-10T00:00:00Z" },
    });
    await addDoc("github_trending", "bob/two", "https://github.com/bob/two");
    await addDoc("hn", "101", "https://github.com/carol/three");
    await addDoc("hn", "102", "https://github.com/carol/three/issues/1");
    await addDoc("hn", "103", "https://github.com/topics/agents");
    await addDoc("hn", "104", "https://example.com/blog");
    await addDoc("github_new_repos", "dave/bad", "https://github.com/dave/bad", {
      meta: { suspicious: true },
    });
    // Cùng repo đáng ngờ được HN link tới: vẫn bỏ.
    await addDoc("hn", "105", "https://github.com/dave/bad");
    await addDoc("github_new_repos", "eve/old", "https://github.com/eve/old", {
      fetchedAt: new Date(now.getTime() - 40 * 24 * HOUR),
    });

    const tracked = await trackedRepos(db, now);
    expect([...tracked.keys()].sort()).toEqual(["alice/one", "bob/two", "carol/three"]);
    expect(tracked.get("alice/one")?.createdAt).toBe("2026-10-10T00:00:00Z");
    expect(repoOfDoc({ kind: "hn", externalId: "1", urlCanonical: "https://github.com/a" })).toBe(
      null,
    );
  });
});

describe("runRepoStats", () => {
  test("chụp repo đang theo dõi, ghi viết thường; chạy lại ngay thì không ghi trùng", async () => {
    const now = new Date();
    await addDoc("github_new_repos", "Alice/One", "https://github.com/Alice/One");
    await addDoc("github_trending", "bob/two", "https://github.com/bob/two");
    await addDoc("hn", "101", "https://github.com/carol/three");
    const { http, queries } = fakeGraphql(
      { "alice/one": 120, "bob/two": 3400, "carol/three": 55 },
      ["carol/three"],
    );

    const first = await runRepoStats({ db, http, now: () => now, batchSize: 2 });
    expect(first).toEqual({ tracked: 3, fresh: 0, observed: 2, missing: 1 });
    expect(queries).toHaveLength(2);
    const rows = await db.select().from(repoStats).orderBy(asc(repoStats.repo));
    expect(rows.map((r) => [r.repo, r.stars, r.forks, r.source, r.reportedGain])).toEqual([
      ["alice/one", 120, 7, "github_stars", null],
      ["bob/two", 3400, 7, "github_stars", null],
    ]);

    // Một giờ sau (chạy tay, hay pg-boss thử lại): repo đã chụp được bỏ qua, chỉ hỏi lại repo thiếu.
    const again = await runRepoStats({ db, http, now: () => new Date(now.getTime() + HOUR) });
    expect(again).toEqual({ tracked: 3, fresh: 2, observed: 0, missing: 1 });
    expect(queries[2]).not.toContain('"alice"');
    expect(await db.$count(repoStats)).toBe(2);
  });

  test("thiếu GITHUB_TOKEN thì bỏ qua, không gọi mạng", async () => {
    await addDoc("github_trending", "bob/two", "https://github.com/bob/two");
    const { http, queries } = fakeGraphql({});
    delete process.env.GITHUB_TOKEN;
    try {
      const out = await runRepoStats({ db, http });
      expect(out.skipped).toContain("GITHUB_TOKEN");
      expect(queries).toHaveLength(0);
    } finally {
      process.env.GITHUB_TOKEN = "test-token";
    }
  });
});

describe("growthOf", () => {
  const now = new Date("2026-10-13T23:20:00Z");

  test("tham chiếu là lần đo gần nhất cách ≥ 20 giờ, bỏ qua lần đo sát nhau", () => {
    // Trending 06:10 và tự chụp 06:20 hôm nay; hôm qua chụp 06:20; một lần chạy tay 14 giờ trước.
    const g = growthOf([
      obs(0, 1500, now),
      obs(1 / 6, 1480, now),
      obs(14, 1300, now),
      obs(24, 1000, now),
    ]);
    expect(g.gain24h).toBe(500);
  });

  test("chưa có lần đo nào cách ≥ 20 giờ thì chưa có tăng 24 giờ", () => {
    expect(growthOf([obs(0, 1500, now), obs(19.9, 1000, now)])).toEqual({
      gain24h: null,
      accel: null,
    });
    expect(growthOf([obs(0, 1500, now)])).toEqual({ gain24h: null, accel: null });
    expect(growthOf([])).toEqual({ gain24h: null, accel: null });
  });

  test("tăng tốc = tăng hôm nay − tăng hôm qua, thứ tự đầu vào không quan trọng", () => {
    const heating = growthOf([obs(48, 100, now), obs(0, 600, now), obs(24, 300, now)]);
    expect(heating).toEqual({ gain24h: 300, accel: 100 });
    const cooling = growthOf([obs(0, 2000, now), obs(24, 1900, now), obs(48, 1500, now)]);
    expect(cooling).toEqual({ gain24h: 100, accel: -300 });
  });
});

describe("listRepos", () => {
  test("đủ lần đo thì số đo; mới một lần thì số GitHub báo (Trending) hoặc sao / tuổi", async () => {
    const now = new Date();
    const ago = (h: number) => new Date(now.getTime() - h * HOUR);
    await addDoc("github_new_repos", "a/measured", "https://github.com/a/measured");
    await addDoc("github_trending", "b/trending", "https://github.com/b/trending");
    await addDoc("github_new_repos", "c/new", "https://github.com/c/new", {
      meta: { createdAt: ago(96).toISOString() },
    });
    await addDoc("hn", "9", "https://github.com/d/never");
    await observe("a/measured", ago(48), 100);
    await observe("a/measured", ago(24), 300);
    await observe("a/measured", ago(0), 600);
    await observe("b/trending", ago(1), 5000, { source: "trending_daily", reportedGain: 800 });
    await observe("c/new", ago(0), 400);

    const rows = await listRepos(db, now);
    expect(rows.map((r) => [r.repo, r.stars, r.gain24h, r.accel, r.basis])).toEqual([
      ["b/trending", 5000, 800, null, "reported"],
      ["a/measured", 600, 300, 100, "measured"],
      ["c/new", 400, 100, null, "age"],
      ["d/never", null, null, null, null],
    ]);
  });
});

describe("tín hiệu cho xếp hạng", () => {
  test("job signals ghi gh_gain_24h từ repo_stats; engagement ưu tiên nó, không có thì cách tạm", async () => {
    const now = Date.now();
    const repoDoc = await addDoc("github_new_repos", "a/one", "https://github.com/a/one");
    const lone = await addDoc("github_new_repos", "b/lone", "https://github.com/b/lone");
    await observe("a/one", new Date(now - 48 * HOUR), 1000);
    await observe("a/one", new Date(now - 24 * HOUR), 1200);
    await observe("a/one", new Date(now - HOUR), 1250);
    await observe("b/lone", new Date(now - HOUR), 900);
    const http: HttpClient = {
      async get() {
        const body = { stargazers_count: 1250, created_at: new Date(now - 5 * 24 * HOUR) };
        return { status: 200, body: JSON.stringify(body), headers: new Headers() };
      },
      post: () => Promise.reject(new Error("signals không chụp sao")),
    };

    const out = await refreshSignals(db, http, [repoDoc, lone]);
    expect(out).toEqual({ asked: 2, updated: 2, missing: 0, local: 1 });
    const signals = await db
      .select({ doc: docSignals.documentId, metric: docSignals.metric, value: docSignals.value })
      .from(docSignals)
      .where(eq(docSignals.documentId, repoDoc))
      .orderBy(asc(docSignals.metric));
    expect(signals.map((s) => [s.metric, s.value])).toEqual([
      ["gh_accel_24h", -150],
      ["gh_age_days", expect.closeTo(5, 1)],
      ["gh_gain_24h", 50],
      ["gh_stars", 1250],
    ]);
    const s = Object.fromEntries(signals.map((r) => [r.metric, r.value]));
    expect(githubNewReposSource.engagement?.(s)).toBe(50);
    // Chưa đủ hai lần đo: sao / tuổi như trước.
    expect(githubNewReposSource.engagement?.({ gh_stars: 900, gh_age_days: 3 })).toBe(300);
    expect(githubTrendingSource.engagement?.({ gh_gain_24h: 40, gh_stars_today: 978 })).toBe(40);
    expect(githubTrendingSource.engagement?.({ gh_gain_24h: -5 })).toBe(0);
    expect(githubTrendingSource.engagement?.({ gh_stars_today: 978 })).toBe(978);
  });
});

describe("Trending lúc fetch", () => {
  test("mỗi repo trên trang một lần đo trending_daily, cả repo đã là tài liệu từ trước", async () => {
    await addDoc(
      "github_trending",
      "mksglu/context-mode",
      "https://github.com/mksglu/context-mode",
    );
    const at = new Date("2026-10-13T23:10:00Z");
    const http: HttpClient = {
      get: async () => ({ status: 200, body: TRENDING, headers: new Headers() }),
      post: () => Promise.reject(new Error("fetch Trending không POST")),
    };
    const store = fsObjectStore(await mkdtemp(join(tmpdir(), "radard-repo-stats-")));
    const outcome = await runFetch(ids.github_trending ?? 0, { db, store, http, now: () => at });
    expect(outcome).toMatchObject({ status: "ok", nFetched: 4, nNew: 3 });

    const rows = await db.select().from(repoStats).orderBy(asc(repoStats.id));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      repo: "morluto/rea",
      stars: 195823,
      forks: 47832,
      source: "trending_daily",
      reportedGain: 54706,
      observedAt: at,
    });
    expect(rows.map((r) => r.repo)).toContain("mksglu/context-mode");
  });
});
