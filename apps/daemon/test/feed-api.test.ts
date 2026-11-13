/**
 * Web feed routes (docs/cau-truc-web.html section 4): GET /api/feed, /api/feed/dates, GET /api/events/:id,
 * PUT /api/feedback, POST /api/impressions, and Origin checks. Expected values come from the contract; data
 * is built directly into the DB (profile A = project owner, profile B = invited guest).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createDatabase,
  documents,
  eventSummaries,
  feedback,
  feedImpressions,
  feedItems,
  feedSnapshots,
  invites,
  profile,
  profileTopics,
  runMigrations,
  sources,
  topics,
} from "@radard/db";
import { testUtils } from "better-auth/plugins";
import { sql } from "drizzle-orm";
import { hc } from "hono/client";
import { type AppType, createWebApp } from "../src/web/app.ts";
import { createAuth } from "../src/web/auth.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 4 });
const OWNER = "chu.du.an@example.com";
const GUEST = "khach@example.com";
const BASE = "http://localhost:8080";
const DAY = 86_400_000;
const D10 = new Date("2026-11-10T00:00:00Z"); // 07:00 VN on 2026-11-10

const auth = createAuth({
  db,
  config: {
    secret: "khoa-thu-nghiem-0123456789-0123456789",
    baseURL: BASE,
    bootstrapOwnerEmails: [OWNER],
    providers: {},
  },
  plugins: [testUtils()],
});
const app = createWebApp({ db, secret: undefined, auth: { auth, providers: [] } }).app;

async function login(email: string): Promise<Headers> {
  const ctx = await auth.$context;
  const { user } = await ctx.internalAdapter.createOAuthUser(
    { email, name: email, emailVerified: true },
    { providerId: "github", accountId: `gh-${email}` },
  );
  const t = (await auth.$context) as unknown as {
    test: { login(o: { userId: string }): Promise<{ headers: Headers }> };
  };
  return (await t.test.login({ userId: user.id })).headers;
}

type Ids = { snap10: number; snap09: number; items: number[]; events: number[] };
let A: Ids;
let B: Ids;
let hA: Headers;
let hB: Headers;
let profileB = 0;
let srcHn = 0;
let srcArxiv = 0;
let topicId = 0;

async function snapshot(profileId: number, periodEnd: Date, status = "ready", itemCount = 0) {
  const [s] = await db
    .insert(feedSnapshots)
    .values({
      profileId,
      periodStart: new Date(periodEnd.getTime() - DAY),
      periodEnd,
      status,
      selectSeed: 1,
      itemCount,
    })
    .returning({ id: feedSnapshots.id });
  return s?.id ?? 0;
}

/** K items for (profile, snapshot); item 2 is a continuing item (n<1) with 2 articles from 2 sources; item 3 goes into the digest. */
async function seedItems(
  profileId: number,
  snapshotId: number,
  tag: string,
  eventBase: number,
  k: number,
) {
  const out: number[] = [];
  const events: number[] = [];
  for (let i = 1; i <= k; i++) {
    const eventId = eventBase + i;
    const mk = async (n: number, sourceId: number, host: string) =>
      (
        await db
          .insert(documents)
          .values({
            sourceId,
            externalId: `${tag}-${i}-${n}`,
            url: `https://www.${host}/${tag}/${i}/${n}`,
            urlCanonical: `https://${host}/${tag}/${i}/${n}`,
            title: `Bài ${tag}${i}.${n}`,
            publishedAt: new Date(D10.getTime() - i * 3_600_000),
            contentSha256: `${tag}${i}${n}`,
            rawKey: `r/${tag}${i}${n}`,
            contentType: "text/html",
          })
          .returning({ id: documents.id })
      )[0]?.id ?? 0;
    const docIds = [await mk(1, srcHn, "hn.test")];
    if (i === 2) docIds.push(await mk(2, srcArxiv, "arxiv.test"));
    if (i === 4) docIds.push(await mk(2, srcHn, "hn.test")); // one source, two articles
    let summaryId: number | null = null;
    if (i === 1) {
      summaryId =
        (
          await db
            .insert(eventSummaries)
            .values({
              eventId,
              lang: "vi",
              docsHash: `h${tag}${i}`,
              title: "Tiêu đề chung",
              summary: `Tóm tắt chung ${tag}${i}`,
              model: "m",
            })
            .returning({ id: eventSummaries.id })
        )[0]?.id ?? null;
    }
    const [row] = await db
      .insert(feedItems)
      .values({
        profileId,
        snapshotId,
        position: i,
        eventId,
        documentIds: docIds,
        sourceId: srcHn,
        topicId: i <= 2 ? topicId : null,
        title: `Tin ${tag}${i}`,
        score: 0.9 - i / 100,
        penalty: 0,
        r: 0.8,
        p: 0.5,
        c: 0.3,
        a: 0.2,
        f: 0.1,
        u: 0.05,
        n: i === 2 ? 0.4 : 1,
        reserved: false,
        notifyPosition: i === 3 ? 1 : null,
        summaryId,
      })
      .returning({ id: feedItems.id });
    out.push(row?.id ?? 0);
    events.push(eventId);
  }
  return { items: out, events };
}

const get = (path: string, headers?: Headers) => app.request(path, headers ? { headers } : {});
const send = (
  method: string,
  path: string,
  body: unknown,
  headers: Headers,
  extra: Record<string, string> = {},
) => {
  const h = new Headers(headers);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return app.request(path, {
    method,
    headers: h,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
};
const impressionRows = async () => (await db.select().from(feedImpressions)).length;
const feedbackRows = async () => (await db.select().from(feedback)).length;

beforeAll(async () => {
  await runMigrations(TEST_URL);
});
afterAll(async () => {
  await db.$bun.close();
});

beforeEach(async () => {
  await db.execute(
    sql`truncate "user", session, account, verification, invites, sources, documents, profile, topics, event_summaries restart identity cascade`,
  );
  await db.insert(profile).values({ id: 1, promptContext: "A", displayLang: "vi" });
  await db.insert(invites).values({ email: GUEST });
  hA = await login(OWNER);
  hB = await login(GUEST);
  profileB = (await (await get("/api/me", hB)).json()).profileId;
  const [s1] = await db
    .insert(sources)
    .values({ kind: "hn", name: "HN", cadence: "*/15 * * * *", trustScore: 0.6 })
    .returning({ id: sources.id });
  const [s2] = await db
    .insert(sources)
    .values({ kind: "arxiv", name: "arXiv", cadence: "0 * * * *", trustScore: 0.9 })
    .returning({ id: sources.id });
  srcHn = s1?.id ?? 0;
  srcArxiv = s2?.id ?? 0;
  const [t] = await db
    .insert(topics)
    .values({
      name: "Agent AI",
      embedText: "Agent AI",
      description: "Agent AI",
      origin: "custom",
      ownerProfileId: 1,
    })
    .returning({ id: topics.id });
  topicId = t?.id ?? 0;
  await db.insert(profileTopics).values({ topicId, active: true });

  // A: 09/11 (2 items), 10/11 (5 items), 11/11 being built (not shown). B: 10/11 (3 items), shares event 101.
  const snap08 = await snapshot(1, new Date(D10.getTime() - 2 * DAY));
  const snap09 = await snapshot(1, new Date(D10.getTime() - DAY), "ready", 2);
  const snap10 = await snapshot(1, D10, "ready", 5);
  await snapshot(1, new Date(D10.getTime() + DAY), "building", 0);
  void snap08;
  const a10 = await seedItems(1, snap10, "a", 100, 5);
  await seedItems(1, snap09, "z", 900, 2);
  const bSnap = await snapshot(profileB, D10, "ready", 3);
  const b10 = await seedItems(profileB, bSnap, "b", 100, 3); // events 101..103 overlap with A
  A = { snap10, snap09, items: a10.items, events: a10.events };
  B = { snap10: bSnap, snap09: 0, items: b10.items, events: b10.events };
});

describe("401 khi chưa có phiên", () => {
  test("mọi route mới", async () => {
    const cases: [string, string][] = [
      ["GET", "/api/feed"],
      ["GET", "/api/feed/dates"],
      ["GET", "/api/events/101"],
      ["PUT", "/api/feedback"],
      ["POST", "/api/impressions"],
    ];
    for (const [m, p] of cases) {
      const res = await app.request(p, { method: m, body: m === "GET" ? undefined : "{}" });
      expect(`${m} ${p} ${res.status}`).toBe(`${m} ${p} 401`);
    }
  });
});

describe("GET /api/feed", () => {
  test("intro và eventCount lấy từ meta của bản chụp; bản chụp cũ hoặc của hồ sơ khác thì null", async () => {
    await db
      .update(feedSnapshots)
      .set({ meta: { intro: "Hôm nay nổi bật là X.", eventCount: 132 } })
      .where(sql`id = ${A.snap10}`);
    const today = await (await get("/api/feed?limit=1", hA)).json();
    expect(today).toMatchObject({ intro: "Hôm nay nổi bật là X.", eventCount: 132 });
    // The old snapshot (09/11) has no meta.intro: both fields are null, not missing.
    const old = await (await get("/api/feed?date=2026-11-09", hA)).json();
    expect(old.intro).toBeNull();
    expect(old.eventCount).toBeNull();
    // Another profile's snapshot of the same day never shows A's values.
    const other = await (await get("/api/feed?limit=1", hB)).json();
    expect(other.intro).toBeNull();
    expect(other.eventCount).toBeNull();
  });

  test("trang đầu: hình dạng item đúng với dữ liệu dựng sẵn", async () => {
    const res = await get("/api/feed?limit=3", hA);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ snapshotId: A.snap10, date: "2026-11-10", total: 5 });
    expect(typeof j.nextCursor).toBe("string");
    expect(j.items).toHaveLength(3);
    expect(j.items[0]).toEqual({
      position: 1,
      feedItemId: A.items[0],
      eventId: 101,
      title: "Tin a1",
      summary: "Tóm tắt chung a1",
      topic: "Agent AI",
      sourceCount: 1,
      articleCount: 1,
      sources: ["HN"],
      updated: false,
      inDigest: false,
      notifyPosition: null,
      feedback: "none",
      score: { s: 0.89, r: 0.8, p: 0.5, c: 0.3, a: 0.2, f: 0.1, u: 0.05, n: 1 },
    });
    expect(j.items[1]).toMatchObject({
      eventId: 102,
      summary: null,
      topic: "Agent AI",
      sourceCount: 2,
      articleCount: 2,
      sources: ["HN", "arXiv"],
      updated: true,
      inDigest: false,
    });
    expect(j.items[2]).toMatchObject({
      eventId: 103,
      topic: null,
      inDigest: true,
      notifyPosition: 1,
      updated: false,
    });
  });

  test("một nguồn nhiều bài: sourceCount = 1, articleCount = 2", async () => {
    const j = await (await get("/api/feed", hA)).json();
    expect(j.items[3]).toMatchObject({ sources: ["HN"], sourceCount: 1, articleCount: 2 });
  });

  test("phân trang theo cursor đủ K tin; hết thì nextCursor = null", async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(`/api/feed?limit=2${cursor ? `&cursor=${cursor}` : ""}`, hA);
      expect(res.status).toBe(200);
      const j = await res.json();
      seen.push(...j.items.map((i: { position: number }) => i.position));
      cursor = j.nextCursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(pages).toBe(3);
    // default limit 10 → one page, done.
    const all = await (await get("/api/feed", hA)).json();
    expect(all.items).toHaveLength(5);
    expect(all.nextCursor).toBeNull();
  });

  test("date: chọn đúng ngày VN; không có bản chụp → 404 no_snapshot; ngày sai định dạng → 400", async () => {
    const r9 = await (await get("/api/feed?date=2026-11-09", hA)).json();
    expect(r9).toMatchObject({ snapshotId: A.snap09, date: "2026-11-09", total: 2 });
    expect(r9.items).toHaveLength(2);
    for (const d of ["2026-11-07", "2026-11-11", "2025-01-01", "2026-02-31"]) {
      const res = await get(`/api/feed?date=${d}`, hA);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "no_snapshot" });
    }
    expect((await get("/api/feed?date=10-11-2026", hA)).status).toBe(400);
  });

  test("cursor rác → 400; cursor của ngày khác → 400; limit ngoài 1..50 → 400", async () => {
    for (const c of [
      "abc",
      "!!!",
      "YWJj",
      Buffer.from("c1:1:0").toString("base64url"),
      "x".repeat(300),
    ]) {
      const res = await get(`/api/feed?cursor=${encodeURIComponent(c)}`, hA);
      expect(`${c.slice(0, 10)} ${res.status}`).toBe(`${c.slice(0, 10)} 400`);
    }
    const page1 = await (await get("/api/feed?limit=1", hA)).json();
    const res = await get(`/api/feed?date=2026-11-09&cursor=${page1.nextCursor}`, hA);
    expect(res.status).toBe(400);
    for (const l of ["0", "51", "abc", "-1", "1.5"])
      expect((await get(`/api/feed?limit=${l}`, hA)).status).toBe(400);
    expect((await get("/api/feed?limit=50", hA)).status).toBe(200);
  });

  test("hồ sơ chưa có bản chụp → 404", async () => {
    await db.execute(sql`delete from feed_snapshots where profile_id = ${profileB}`);
    expect((await get("/api/feed", hB)).status).toBe(404);
  });

  test("phản hồi hiện trong feed theo dòng mới nhất", async () => {
    await send("PUT", "/api/feedback", { feedItemId: A.items[0], kind: "like" }, hA);
    const j = await (await get("/api/feed?limit=2", hA)).json();
    expect(j.items[0].feedback).toBe("like");
    expect(j.items[1].feedback).toBe("none");
  });
});

describe("GET /api/feed/dates", () => {
  test("mới nhất trước, chỉ bản ready của hồ sơ", async () => {
    const res = await get("/api/feed/dates", hA);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      dates: [
        { date: "2026-11-10", snapshotId: A.snap10, itemCount: 5 },
        { date: "2026-11-09", snapshotId: A.snap09, itemCount: 2 },
        { date: "2026-11-08", snapshotId: A.snap09 - 1, itemCount: 0 },
      ],
    });
    expect((await (await get("/api/feed/dates", hB)).json()).dates).toEqual([
      { date: "2026-11-10", snapshotId: B.snap10, itemCount: 3 },
    ]);
  });

  test("tối đa 60 ngày", async () => {
    for (let i = 3; i < 70; i++) await snapshot(1, new Date(D10.getTime() - i * DAY));
    const j = await (await get("/api/feed/dates", hA)).json();
    expect(j.dates).toHaveLength(60);
    expect(j.dates[0].date).toBe("2026-11-10");
  });
});

describe("GET /api/events/:id", () => {
  test("chi tiết: docs, score, why, feedItemId, feedback", async () => {
    await send("PUT", "/api/feedback", { feedItemId: A.items[1], kind: "dislike" }, hA);
    const res = await get("/api/events/102", hA);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toEqual({
      eventId: 102,
      title: "Tin a2",
      summary: null,
      topic: "Agent AI",
      docs: [
        {
          title: "Bài a2.1",
          url: "https://www.hn.test/a/2/1",
          sourceName: "HN",
          publishedAt: "2026-11-09T22:00:00.000Z",
        },
        {
          title: "Bài a2.2",
          url: "https://www.arxiv.test/a/2/2",
          sourceName: "arXiv",
          publishedAt: "2026-11-09T22:00:00.000Z",
        },
      ],
      score: { s: 0.88, r: 0.8, p: 0.5, c: 0.3, a: 0.2, f: 0.1, u: 0.05, n: 0.4 },
      why: "Cập nhật · Chủ đề: Agent AI · 2 bài từ HN, arXiv",
      feedItemId: A.items[1],
      feedback: "dislike",
    });
    expect((await (await get("/api/events/101", hA)).json()).summary).toBe("Tóm tắt chung a1");
  });

  test("sự kiện không có trong feed của hồ sơ, hoặc id rác → 404 not_found", async () => {
    for (const id of ["999", "0", "abc", "1e3", "-1"]) {
      const res = await get(`/api/events/${id}`, hA);
      expect(`${id} ${res.status}`).toBe(`${id} 404`);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    // Event only present in B's feed.
    await seedItems(profileB, B.snap10, "bx", 700, 0);
    await db.insert(feedItems).values({
      profileId: profileB,
      snapshotId: B.snap10,
      position: 9,
      eventId: 777,
      documentIds: [],
      sourceId: srcHn,
      title: "Chỉ của B",
      score: 1,
      penalty: 0,
      r: 1,
      p: 1,
      c: 1,
      a: 1,
      f: 1,
      u: 0,
      n: 1,
      reserved: false,
    });
    expect((await get("/api/events/777", hA)).status).toBe(404);
    expect((await get("/api/events/777", hB)).status).toBe(200);
  });
});

describe("PUT /api/feedback", () => {
  test("like → like; bấm lại → none; dislike; đổi sang like", async () => {
    const put = async (kind: string) => {
      const res = await send("PUT", "/api/feedback", { feedItemId: A.items[0], kind }, hA);
      expect(res.status).toBe(200);
      return (await res.json()).state;
    };
    expect(await put("like")).toBe("like");
    expect(await put("like")).toBe("none");
    expect(await put("dislike")).toBe("dislike");
    expect(await put("like")).toBe("like");
    expect((await (await get("/api/events/101", hA)).json()).feedback).toBe("like");
  });

  test("thân sai → 400 và không ghi gì; thân text/plain vẫn đọc được", async () => {
    for (const body of [
      {},
      { feedItemId: "1", kind: "like" },
      { feedItemId: A.items[0], kind: "love" },
      { feedItemId: 1.5, kind: "like" },
      { feedItemId: A.items[0], kind: "like", extra: 1 },
      "không phải json",
      [],
    ]) {
      expect((await send("PUT", "/api/feedback", body, hA)).status).toBe(400);
    }
    expect(await feedbackRows()).toBe(0);
    const res = await send(
      "PUT",
      "/api/feedback",
      JSON.stringify({ feedItemId: A.items[0], kind: "like" }),
      hA,
      { "content-type": "text/plain" },
    );
    expect(await res.json()).toEqual({ state: "like" });
  });
});

describe("POST /api/impressions", () => {
  const items = (ps: number[], snapshotId = 0) => ({
    items: ps.map((position) => ({ snapshotId: snapshotId || A.snap10, position })),
  });

  test("204; ghi lại cùng mục vẫn 204 và không thêm dòng", async () => {
    expect((await send("POST", "/api/impressions", items([1, 2, 3]), hA)).status).toBe(204);
    expect(await impressionRows()).toBe(3);
    expect((await send("POST", "/api/impressions", items([2, 3, 4]), hA)).status).toBe(204);
    expect(await impressionRows()).toBe(4);
    expect((await send("POST", "/api/impressions", { items: [] }, hA)).status).toBe(204);
  });

  test("mục sai (vị trí không có, bản chụp của hồ sơ khác) → 400 invalid và KHÔNG ghi gì", async () => {
    const mixed = {
      items: [
        { snapshotId: A.snap10, position: 1 },
        { snapshotId: A.snap10, position: 99 },
        { snapshotId: B.snap10, position: 1 },
      ],
    };
    const res = await send("POST", "/api/impressions", mixed, hA);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid",
      invalid: [
        { snapshotId: A.snap10, position: 99 },
        { snapshotId: B.snap10, position: 1 },
      ],
    });
    expect(await impressionRows()).toBe(0);
  });

  test("thân text/plain (sendBeacon) được chấp nhận", async () => {
    const res = await send("POST", "/api/impressions", JSON.stringify(items([1])), hA, {
      "content-type": "text/plain;charset=UTF-8",
    });
    expect(res.status).toBe(204);
    expect(await impressionRows()).toBe(1);
  });

  test("thân sai: không phải JSON, quá 100 mục, trường lạ → 400; quá 16 KB → 413; không ghi gì", async () => {
    expect((await send("POST", "/api/impressions", "xyz", hA)).status).toBe(400);
    expect(
      (
        await send(
          "POST",
          "/api/impressions",
          items(Array.from({ length: 101 }, (_, i) => i + 1)),
          hA,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await send(
          "POST",
          "/api/impressions",
          { items: [{ snapshotId: A.snap10, position: 1, x: 1 }] },
          hA,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await send(
          "POST",
          "/api/impressions",
          { items: [{ snapshotId: A.snap10, position: 0 }] },
          hA,
        )
      ).status,
    ).toBe(400);
    expect(
      (await send("POST", "/api/impressions", { items: [], pad: "x".repeat(20_000) }, hA)).status,
    ).toBe(413);
    expect(await impressionRows()).toBe(0);
  });

  test("tối đa 100 mục được nhận", async () => {
    await db.insert(feedItems).values(
      Array.from({ length: 95 }, (_, i) => ({
        profileId: 1,
        snapshotId: A.snap10,
        position: 6 + i,
        eventId: 5000 + i,
        documentIds: [],
        sourceId: srcHn,
        title: "t",
        score: 0.1,
        penalty: 0,
        r: 0,
        p: 0,
        c: 0,
        a: 0,
        f: 0,
        u: 0,
        n: 1,
        reserved: false,
      })),
    );
    const res = await send(
      "POST",
      "/api/impressions",
      items(Array.from({ length: 100 }, (_, i) => i + 1)),
      hA,
    );
    expect(res.status).toBe(204);
    expect(await impressionRows()).toBe(100);
  });
});

describe("cách ly hai hồ sơ", () => {
  test("A không đọc được bản chụp, tin, phản hồi của B (và ngược lại)", async () => {
    // B likes its own item 1 (event 101 overlaps with A).
    await send("PUT", "/api/feedback", { feedItemId: B.items[0], kind: "like" }, hB);
    const a = await (await get("/api/feed", hA)).json();
    expect(a.snapshotId).toBe(A.snap10);
    expect(a.items.map((i: { title: string }) => i.title)).toEqual([
      "Tin a1",
      "Tin a2",
      "Tin a3",
      "Tin a4",
      "Tin a5",
    ]);
    expect(a.items[0].feedback).toBe("none");
    expect((await (await get("/api/events/101", hA)).json()).feedItemId).toBe(A.items[0]);
    const b = await (await get("/api/feed", hB)).json();
    expect(b.total).toBe(3);
    expect(b.items[0]).toMatchObject({ title: "Tin b1", feedback: "like", feedItemId: B.items[0] });
    // B's cursor cannot be used for A (different snapshot).
    const bc = await (await get("/api/feed?limit=1", hB)).json();
    expect((await get(`/api/feed?cursor=${bc.nextCursor}`, hA)).status).toBe(400);
  });

  test("A không ghi được phản hồi hay lượt hiện vào tin/bản chụp của B", async () => {
    const res = await send("PUT", "/api/feedback", { feedItemId: B.items[0], kind: "like" }, hA);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(await feedbackRows()).toBe(0);
    const imp = await send(
      "POST",
      "/api/impressions",
      { items: [{ snapshotId: B.snap10, position: 1 }] },
      hA,
    );
    expect(imp.status).toBe(400);
    expect(await impressionRows()).toBe(0);
    // Also cannot be spoofed via profileId in the body/query.
    const forged = await send(
      "PUT",
      "/api/feedback",
      { feedItemId: B.items[0], kind: "like", profileId: profileB },
      hA,
    );
    expect(forged.status).toBe(400);
    const q = await (await get(`/api/feed?profileId=${profileB}`, hA)).json();
    expect(q.snapshotId).toBe(A.snap10);
    expect(await feedbackRows()).toBe(0);
  });

  test("dates và chi tiết sự kiện cũng tách theo hồ sơ", async () => {
    expect((await (await get("/api/feed/dates", hB)).json()).dates).toHaveLength(1);
    expect((await get("/api/events/104", hB)).status).toBe(404); // B only has 101..103
    expect((await get("/api/events/104", hA)).status).toBe(200);
  });
});

describe("kiểm Origin (CSRF)", () => {
  const cases = (h: Headers, extra: Record<string, string>) => [
    send("POST", "/api/impressions", { items: [] }, h, extra),
    send("PUT", "/api/feedback", { feedItemId: A.items[0], kind: "like" }, h, extra),
    send("POST", "/api/events/101/for-me", {}, h, extra),
  ];

  test("Origin lạ (hoặc null) → 403, không ghi gì", async () => {
    for (const origin of [
      "https://evil.example.com",
      "null",
      "http://localhost:8081",
      "https://localhost:8080",
    ]) {
      for (const res of await Promise.all(cases(hA, { origin }))) {
        expect(`${origin} ${res.status}`).toBe(`${origin} 403`);
      }
    }
    expect(await feedbackRows()).toBe(0);
  });

  test("không có Origin hoặc đúng origin của BETTER_AUTH_URL → qua", async () => {
    expect((await send("POST", "/api/impressions", { items: [] }, hA)).status).toBe(204);
    expect(
      (await send("POST", "/api/impressions", { items: [] }, hA, { origin: BASE })).status,
    ).toBe(204);
    expect(
      (
        await send("PUT", "/api/feedback", { feedItemId: A.items[0], kind: "like" }, hA, {
          origin: BASE,
        })
      ).status,
    ).toBe(200);
  });

  test("GET không bị chặn theo Origin", async () => {
    const h = new Headers(hA);
    h.set("origin", "https://evil.example.com");
    expect((await get("/api/feed", h)).status).toBe(200);
  });
});

describe("AppType cho client hc", () => {
  test("có các đường dẫn của hợp đồng (kiểm lúc typecheck) và gọi được lúc chạy", async () => {
    type Client = ReturnType<typeof hc<AppType>>;
    const has: "feed" | "feedback" | "impressions" | "events" extends keyof Client ? true : never =
      true;
    const sub: "dates" extends keyof Client["feed"] ? true : never = true;
    type Detail = Client["events"][":id"]["$get"];
    type Put = Client["feedback"]["$put"];
    type Post = Client["impressions"]["$post"];
    const verbs: [Detail, Put, Post] | null = null;
    expect(verbs).toBeNull();
    expect(sub).toBe(true);
    expect(has).toBe(true);
    const client = hc<AppType>(`${BASE}/api`, {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        app.request(new Request(input, init)),
    });
    const res = await client.feed.$get(
      { query: { limit: "1" } },
      { headers: Object.fromEntries(hA) },
    );
    expect(res.status).toBe(200);
    if (res.status === 200) {
      const j = await res.json();
      const first: number | undefined = j.items[0]?.position;
      expect(first).toBe(1);
    }
    const dates = await client.feed.dates.$get({}, { headers: Object.fromEntries(hA) });
    expect(dates.status).toBe(200);
  });
});
