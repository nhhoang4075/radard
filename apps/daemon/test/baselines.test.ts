/**
 * Signals and baselines on `radard_test`: fake Algolia, hand-built data so the expected answers are known in advance.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { baselineOf, type HttpClient } from "@radard/core";
import {
  baselines,
  createDatabase,
  docSignals,
  docTopicScores,
  documents,
  eventDocuments,
  events,
  profile,
  runMigrations,
  sources,
} from "@radard/db";
import { asc, sql } from "drizzle-orm";
import { runBaselines } from "../src/jobs/baselines.ts";
import { refreshSignals } from "../src/jobs/signals.ts";

import { addTopic } from "./topic-fixture.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const NOW = new Date("2026-10-12T00:00:00Z");
const DAY = 86_400_000;

let hn = 0;
let arxiv = 0;
let topicId = 0;
let seq = 0;

async function addDoc(sourceId: number, at: Date, url = `https://x.com/${seq + 1}`) {
  const id = ++seq;
  const [row] = await db
    .insert(documents)
    .values({
      sourceId,
      externalId: String(id),
      url,
      urlCanonical: url,
      title: `doc ${id}`,
      publishedAt: at,
      contentSha256: `sha${id}`,
      rawKey: `raw/${id}`,
      contentType: "application/json",
    })
    .returning({ id: documents.id });
  return row?.id ?? 0;
}

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  await db.execute(
    sql`truncate sources, events, profile, topics, documents restart identity cascade`,
  );
  const [h, a] = await db
    .insert(sources)
    .values([
      { kind: "hn", name: "HN", cadence: "*/15 * * * *" },
      { kind: "arxiv", name: "arXiv", cadence: "30 1 * * *" },
    ])
    .returning({ id: sources.id });
  hn = h?.id ?? 0;
  arxiv = a?.id ?? 0;
  await db.insert(profile).values({ promptContext: "x" });
  topicId = await addTopic(db, "Agent", { embedText: "agents" });
});

afterAll(async () => {
  await db.$bun.close();
});

describe("refreshSignals", () => {
  test("ghi điểm mới nhất, ghi đè lần trước; bài không còn trên nguồn thì đếm là thiếu", async () => {
    const a = await addDoc(hn, new Date(NOW.getTime() - DAY));
    const b = await addDoc(hn, new Date(NOW.getTime() - DAY));
    const x = await addDoc(arxiv, new Date(NOW.getTime() - DAY));
    let points = 10;
    const http: HttpClient = {
      post: () => Promise.reject(new Error("test này không POST")),
      async get(url) {
        expect(url).toContain("story_1");
        // Return only story 1: story 2 counts as deleted from HN.
        const hits = [{ objectID: "1", points, num_comments: 4, created_at_i: 0 }];
        return {
          status: 200,
          body: JSON.stringify({ hits, nbHits: 1, nbPages: 1, page: 0 }),
          headers: new Headers(),
        };
      },
    };
    const out = await refreshSignals(db, http, [a, b, x]);
    // arXiv has no refreshSignals: not asked.
    expect(out).toEqual({ asked: 2, updated: 1, missing: 1, local: 0 });
    points = 25;
    await refreshSignals(db, http, [a]);
    const rows = await db.select().from(docSignals).orderBy(asc(docSignals.metric));
    expect(rows.map((r) => [r.metric, r.value])).toEqual([
      ["hn_comments", 4],
      ["hn_points", 25],
    ]);
  });
});

describe("runBaselines", () => {
  test("relevance theo (nguồn × chủ đề) và mặt bằng chung; bỏ tài liệu ngoài 30 ngày", async () => {
    const hnScores = [0.1, 0.2, 0.3, 0.4, 0.9];
    const arxivScores = [0.5, 0.6];
    for (const s of hnScores) {
      const d = await addDoc(hn, new Date(NOW.getTime() - 2 * DAY));
      await db.insert(docTopicScores).values({ documentId: d, topicId: topicId, score: s });
    }
    for (const s of arxivScores) {
      const d = await addDoc(arxiv, new Date(NOW.getTime() - 3 * DAY));
      await db.insert(docTopicScores).values({ documentId: d, topicId: topicId, score: s });
    }
    const old = await addDoc(hn, new Date(NOW.getTime() - 40 * DAY));
    await db.insert(docTopicScores).values({ documentId: old, topicId: topicId, score: 0.99 });

    const rows = (await runBaselines(db, NOW)).filter((r) => r.metric === "relevance");
    const of = (sourceId: number | null) => rows.find((r) => r.sourceId === sourceId);
    const near = (got: number | undefined, want: number) => expect(got ?? 0).toBeCloseTo(want, 5);
    near(of(hn)?.median, baselineOf(hnScores).median);
    near(of(hn)?.p999, baselineOf(hnScores).p999);
    expect(of(hn)?.n).toBe(5);
    expect(of(arxiv)?.n).toBe(2);
    near(of(null)?.median, baselineOf([...hnScores, ...arxivScores]).median);
    expect(of(null)?.n).toBe(7);
  });

  test("engagement chỉ tính tín hiệu quan sát sau 24 giờ; ln(1 + điểm + 0,5 × bình luận)", async () => {
    const posted = new Date(NOW.getTime() - 5 * DAY);
    const mature = [
      [10, 4],
      [100, 20],
      [1, 0],
    ];
    for (const [p, c] of mature) {
      const d = await addDoc(hn, posted);
      await db.insert(docSignals).values([
        { documentId: d, metric: "hn_points", value: p ?? 0, observedAt: NOW },
        { documentId: d, metric: "hn_comments", value: c ?? 0, observedAt: NOW },
      ]);
    }
    // Signal fetched 1 hour after posting: says nothing yet, must be dropped.
    const fresh = await addDoc(hn, posted);
    await db.insert(docSignals).values({
      documentId: fresh,
      metric: "hn_points",
      value: 1,
      observedAt: new Date(posted.getTime() + 3_600_000),
    });
    const [eng] = (await runBaselines(db, NOW)).filter((r) => r.metric === "engagement");
    const want = baselineOf(mature.map(([p, c]) => Math.log1p((p ?? 0) + 0.5 * (c ?? 0))));
    expect(eng?.sourceId).toBe(hn);
    expect(eng?.n).toBe(3);
    expect(eng?.median ?? 0).toBeCloseTo(want.median, 9);
  });

  test("coverage đếm bài viết khác nhau (URL), không đếm lượt đăng lại; chạy lại thì ghi đè", async () => {
    const at = new Date(NOW.getTime() - DAY);
    const [ev] = await db
      .insert(events)
      .values({
        title: "e",
        firstSeenAt: at,
        lastSeenAt: at,
        centroid: new Array(1024).fill(0.1),
        embeddingModel: "m",
      })
      .returning({ id: events.id });
    // 3 documents, 2 URLs, 2 sources → ln(1 + 2) + 0,5 × 1
    for (const [src, url] of [
      [hn, "https://a.com"],
      [hn, "https://a.com"],
      [arxiv, "https://b.com"],
    ] as const) {
      const d = await addDoc(src, at, url);
      await db
        .insert(eventDocuments)
        .values({ eventId: ev?.id ?? 0, documentId: d, similarity: 1, reason: "seed" });
    }
    await runBaselines(db, NOW);
    await runBaselines(db, NOW);
    const cov = (await db.select().from(baselines)).filter((r) => r.metric === "coverage");
    expect(cov).toHaveLength(1);
    expect(cov[0]?.median ?? 0).toBeCloseTo(Math.log(3) + 0.5, 5);
  });
});
