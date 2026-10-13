/**
 * `rankPeriod` trên `radard_test`: đọc ứng viên đúng khoảng, chỉ lấy lại tín hiệu cho sự kiện qua
 * cổng R, và không gửi lại tin đã gửi không có gì mới. Dữ liệu dựng tay, Algolia giả.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { HttpClient } from "@radard/core";
import {
  baselines,
  createDatabase,
  deliveries,
  digests,
  docTopicScores,
  documents,
  eventDocuments,
  events,
  profile,
  profileTopics,
  runMigrations,
  sources,
} from "@radard/db";
import { sql } from "drizzle-orm";
import { periodEndingAt, rankPeriod } from "../src/jobs/rank.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const END = new Date("2026-10-06T02:00:00Z");
const IN = new Date("2026-10-05T12:00:00Z");
let hn = 0;
let topic = 0;
let seq = 0;

/** Một sự kiện một tài liệu HN, điểm chủ đề `score`. */
async function addEvent(score: number, at = IN): Promise<{ eventId: number; docId: number }> {
  const id = ++seq;
  const [d] = await db
    .insert(documents)
    .values({
      sourceId: hn,
      externalId: String(id),
      url: `https://x.com/${id}`,
      urlCanonical: `https://x.com/${id}`,
      title: `story ${id}`,
      publishedAt: at,
      contentSha256: `s${id}`,
      rawKey: `r/${id}`,
      contentType: "application/json",
    })
    .returning({ id: documents.id });
  const v = new Array(1024).fill(0);
  v[id % 1024] = 1;
  const [e] = await db
    .insert(events)
    .values({
      title: `story ${id}`,
      firstSeenAt: at,
      lastSeenAt: at,
      centroid: v,
      embeddingModel: "m",
    })
    .returning({ id: events.id });
  await db
    .insert(eventDocuments)
    .values({ eventId: e?.id ?? 0, documentId: d?.id ?? 0, similarity: 1, reason: "seed" });
  await db.insert(docTopicScores).values({ documentId: d?.id ?? 0, profileTopicId: topic, score });
  return { eventId: e?.id ?? 0, docId: d?.id ?? 0 };
}

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  await db.execute(
    sql`truncate sources, events, profile, topics, documents, digests restart identity cascade`,
  );
  const [s] = await db
    .insert(sources)
    .values({ kind: "hn", name: "HN", cadence: "*/15 * * * *", trustScore: 0.6 })
    .returning({ id: sources.id });
  hn = s?.id ?? 0;
  await db.insert(profile).values({ description: "x" });
  const [t] = await db
    .insert(profileTopics)
    .values({ label: "Agent", descriptionEn: "agents", origin: "custom", descriptionUser: "a" })
    .returning({ id: profileTopics.id });
  topic = t?.id ?? 0;
  // Mặt bằng: cosine 0,4 là bình thường, 0,8 là hiếm. 0,64 → z = 0,6 (đúng cổng).
  await db.insert(baselines).values([
    {
      metric: "relevance",
      sourceId: hn,
      profileTopicId: topic,
      median: 0.4,
      p999: 0.8,
      n: 10_000,
      windowDays: 30,
    },
    { metric: "engagement", sourceId: hn, median: 1, p999: 7, n: 10_000, windowDays: 30 },
    { metric: "coverage", median: Math.log(2), p999: 2, n: 10_000, windowDays: 30 },
  ]);
});

afterAll(async () => {
  await db.$bun.close();
});

describe("rankPeriod", () => {
  test("chỉ lấy lại điểm HN cho sự kiện qua cổng R; bài ngoài khoảng không là ứng viên", async () => {
    const hot = await addEvent(0.79);
    await addEvent(0.5); // z = 0,25: dưới cổng
    await addEvent(0.79, new Date("2026-10-03T00:00:00Z")); // ngoài khoảng 24 giờ
    const asked: string[] = [];
    const http: HttpClient = {
      async get(url) {
        asked.push(url);
        const hits = [
          { objectID: String(hot.docId), points: 300, num_comments: 100, created_at_i: 0 },
        ];
        return {
          status: 200,
          body: JSON.stringify({ hits, nbHits: 1, nbPages: 1, page: 0 }),
          headers: new Headers(),
        };
      },
    };
    const r = await rankPeriod(db, periodEndingAt(END), { http });
    expect(r.candidates).toBe(2);
    expect(r.passedGate).toBe(1);
    expect(asked).toHaveLength(1);
    expect(decodeURIComponent(asked[0] ?? "")).toContain(`story_${hot.docId})`);
    expect(r.picked.map((p) => p.event.eventId)).toEqual([hot.eventId]);
    // P lấy từ điểm vừa lấy lại: ln(1 + 300 + 50) so với mặt bằng (1, 7).
    expect(r.picked[0]?.c.P ?? 0).toBeCloseTo((Math.log1p(350) - 1) / 6, 6);
    expect(r.rejected.map((x) => x.reason)).toEqual(["gate"]);
  });

  test("tin đã gửi trong 7 ngày mà không có tài liệu mới thì bị loại (N = 0)", async () => {
    const e = await addEvent(0.79);
    const [dg] = await db
      .insert(digests)
      .values({
        channel: "telegram",
        recipient: "1",
        periodStart: new Date("2026-10-04T02:00:00Z"),
        periodEnd: new Date("2026-10-05T02:00:00Z"),
        lang: "vi",
      })
      .returning({ id: digests.id });
    await db.insert(deliveries).values({
      digestId: dg?.id ?? 0,
      channel: "telegram",
      recipient: "1",
      messageId: "10",
      kind: "event",
      documentIds: [e.docId],
      body: "đã gửi",
      sentAt: new Date("2026-10-05T23:00:00Z"),
    });
    const r = await rankPeriod(db, periodEndingAt(END));
    expect(r.picked).toHaveLength(0);
    expect(r.rejected[0]?.reason).toBe("not_new");
  });
});
