/**
 * `rankPeriod` on `radard_test`: reads candidates in the right range, only re-fetches signals for events that pass
 * gate R, and does not resend already-sent items with nothing new. Hand-built data, fake Algolia.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { fakeDecision } from "@radard/adapters/ai-fake";
import type { DecisionState, HttpClient, UsageEvent } from "@radard/core";
import {
  baselines,
  createDatabase,
  deliveries,
  digests,
  docText,
  docTopicScores,
  documents,
  eventDocuments,
  events,
  profile,
  profileTopics,
  runMigrations,
  sources,
  topics,
} from "@radard/db";
import { eq, sql } from "drizzle-orm";
import { periodEndingAt, rankPeriod } from "../src/jobs/rank.ts";

import { addTopic } from "./topic-fixture.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const END = new Date("2026-10-06T02:00:00Z");
const IN = new Date("2026-10-05T12:00:00Z");
let hn = 0;
let topic = 0;
let seq = 0;

/** One HN event with one document, topic score `score`. */
async function addEvent(
  score: number,
  at = IN,
): Promise<{ eventId: number; docId: number; title: string }> {
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
  await db.insert(docTopicScores).values({ documentId: d?.id ?? 0, topicId: topic, score });
  await db.insert(docText).values({
    documentId: d?.id ?? 0,
    text: `story ${id}. Body of story ${id}.`,
    lang: "eng",
    embedding: v,
    embeddingModel: "m",
  });
  return { eventId: e?.id ?? 0, docId: d?.id ?? 0, title: `story ${id}` };
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
  await db.insert(profile).values({ promptContext: "x" });
  topic = await addTopic(db, "Agent", {
    embedText: "AI agents: LLM agents that plan and use tools",
  });
  await db.execute(
    sql`update topics set label_guide = 'Agents. Not: coding agents (→ Lập trình với AI).' where id = ${topic}`,
  );
  await addTopic(db, "Lập trình với AI", {
    embedText: "AI for software development: coding assistants",
    active: false,
  });
  // Baseline: cosine 0,4 is normal, 0,8 is rare. 0,64 → z = 0,6 (exactly at the gate).
  await db.insert(baselines).values([
    {
      metric: "relevance",
      sourceId: hn,
      topicId: topic,
      median: 0.4,
      p999: 0.8,
      n: 10_000,
      windowDays: 30,
    },
    { metric: "engagement", sourceId: hn, median: 1, p999: 7, n: 10_000, windowDays: 30 },
    { metric: "coverage", median: 0.3, p999: 2, n: 10_000, windowDays: 30 },
  ]);
});

afterAll(async () => {
  await db.$bun.close();
});

describe("rankPeriod", () => {
  test("chỉ lấy lại điểm HN cho sự kiện qua cổng R; bài ngoài khoảng không là ứng viên", async () => {
    const hot = await addEvent(0.79);
    await addEvent(0.5); // z = 0,25: below the gate
    await addEvent(0.79, new Date("2026-10-03T00:00:00Z")); // outside the 24-hour range
    const asked: string[] = [];
    const http: HttpClient = {
      post: () => Promise.reject(new Error("test này không POST")),
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
    const r = await rankPeriod(db, periodEndingAt(END), { profileId: 1, http });
    expect(r.candidates).toBe(2);
    expect(r.passedGate).toBe(1);
    expect(asked).toHaveLength(1);
    expect(decodeURIComponent(asked[0] ?? "")).toContain(`story_${hot.docId})`);
    expect(r.picked.map((p) => p.event.eventId)).toEqual([hot.eventId]);
    // P taken from the score just fetched: ln(1 + 300 + 50) compared with the baseline (1, 7).
    expect(r.picked[0]?.c.P ?? 0).toBeCloseTo((Math.log1p(350) - 1) / 6, 6);
    expect(r.rejected.map((x) => x.reason)).toEqual(["gate"]);
  });

  test("tài liệu nguồn đánh dấu đáng ngờ (meta.suspicious) không thành ứng viên", async () => {
    const ok = await addEvent(0.79);
    const bad = await addEvent(0.79);
    await db
      .update(documents)
      .set({ meta: { suspicious: true } })
      .where(eq(documents.id, bad.docId));
    const r = await rankPeriod(db, periodEndingAt(END), { profileId: 1 });
    expect(r.candidates).toBe(1);
    expect(r.picked.map((p) => p.event.eventId)).toEqual([ok.eventId]);
  });

  test("tin đã gửi mà không có tài liệu mới thì bị loại (N = 0)", async () => {
    const e = await addEvent(0.79);
    const [dg] = await db
      .insert(digests)
      .values({
        profileId: 1,
        channel: "telegram",
        recipient: "1",
        periodStart: new Date("2026-10-04T02:00:00Z"),
        periodEnd: new Date("2026-10-05T02:00:00Z"),
        lang: "vi",
      })
      .returning({ id: digests.id });
    await db.insert(deliveries).values({
      profileId: 1,
      digestId: dg?.id ?? 0,
      channel: "telegram",
      recipient: "1",
      messageId: "10",
      kind: "event",
      position: 1,
      eventId: e.eventId,
      documentIds: [e.docId],
      body: "đã gửi",
      sentAt: new Date("2026-10-05T23:00:00Z"),
    });
    const r = await rankPeriod(db, periodEndingAt(END), { profileId: 1 });
    expect(r.picked).toHaveLength(0);
    expect(r.rejected[0]?.reason).toBe("not_new");
  });

  test("tin gửi từ 40 ngày trước, nay chỉ có bài HN đăng lại cùng URL: vẫn bị loại, không cắt 7 ngày", async () => {
    const old = new Date("2026-08-27T02:00:00Z");
    const e = await addEvent(0.79, old);
    const [first] = await db.select().from(documents).where(eq(documents.id, e.docId));
    const [dg] = await db
      .insert(digests)
      .values({
        profileId: 1,
        channel: "telegram",
        recipient: "1",
        periodStart: new Date("2026-08-26T02:00:00Z"),
        periodEnd: old,
        lang: "vi",
      })
      .returning({ id: digests.id });
    await db.insert(deliveries).values({
      profileId: 1,
      digestId: dg?.id ?? 0,
      channel: "telegram",
      recipient: "1",
      messageId: "11",
      kind: "event",
      position: 1,
      eventId: e.eventId,
      documentIds: [e.docId],
      body: "đã gửi",
      sentAt: old,
    });
    // Today another HN post reposts the same article: new document, old URL.
    const [repost] = await db
      .insert(documents)
      .values({
        sourceId: hn,
        externalId: "repost",
        url: first?.url ?? "",
        urlCanonical: first?.urlCanonical ?? "",
        title: "đăng lại",
        publishedAt: IN,
        contentSha256: "repost",
        rawKey: "r/repost",
        contentType: "application/json",
      })
      .returning({ id: documents.id });
    await db
      .insert(eventDocuments)
      .values({ eventId: e.eventId, documentId: repost?.id ?? 0, similarity: 1, reason: "url" });
    const r = await rankPeriod(db, periodEndingAt(END), { profileId: 1 });
    expect(r.picked).toHaveLength(0);
    expect(r.rejected[0]?.reason).toBe("not_new");
  });
});

/** R = (cosine − 0,4) / 0,4 using the test's baseline. */
const scoreForR = (R: number) => 0.4 + 0.4 * R;

describe("cổng vùng xám bằng model quyết định", () => {
  // Floor S = 0 so that only the gate decides which items are chosen.
  const config = { floorS: 0 };

  test("R ≥ 0,7 qua không hỏi; vùng xám theo xác suất; R < 0,5 bị loại không hỏi", async () => {
    const high = await addEvent(scoreForR(0.75));
    const lowYes = await addEvent(scoreForR(0.55));
    const midNo = await addEvent(scoreForR(0.65));
    const below = await addEvent(scoreForR(0.45));
    const states: DecisionState[] = [];
    const calls: UsageEvent[] = [];
    const decider = fakeDecision({
      answer: (q, _id, state) => {
        expect(q).toEqual({
          type: "boolean",
          instructions: "Is this news item mainly about the topic below?",
        });
        states.push(state);
        const title = (state as { item: { title: string } }).item.title;
        return title === lowYes.title ? 0.7 : 0.4;
      },
      sink: async (e) => {
        calls.push(e);
      },
    });
    const r = await rankPeriod(db, periodEndingAt(END), { profileId: 1, config, decider });

    expect(states).toHaveLength(2);
    expect(calls.map((c) => c.task)).toEqual(["decide_topic_gate", "decide_topic_gate"]);
    expect(r.picked.map((p) => p.event.eventId).sort()).toEqual(
      [high.eventId, lowYes.eventId].sort(),
    );
    const reasons = Object.fromEntries(r.rejected.map((x) => [x.event.eventId, x.reason]));
    expect(reasons).toEqual({ [midNo.eventId]: "decision_reject", [below.eventId]: "gate" });
    expect(r.passedGate).toBe(2);
    expect(r.gateCounts).toEqual({ inBand: 2, asked: 2, passed: 1, rejected: 1, fallback: 0 });
    const byEvent = new Map(r.gateDecisions.map((d) => [d.eventId, d]));
    expect(byEvent.get(lowYes.eventId)).toMatchObject({
      topicId: topic,
      topic: "Agent",
      probability: 0.7,
      pass: true,
      fallback: false,
    });
    expect(byEvent.get(lowYes.eventId)?.R).toBeCloseTo(0.55, 6);
    expect(byEvent.get(midNo.eventId)).toMatchObject({ probability: 0.4, pass: false });

    // State as at measurement time: title + first 400 characters; English topic names, scope no longer
    // the Vietnamese name of another topic.
    expect(states[0]).toEqual({
      item: expect.objectContaining({ title: expect.stringMatching(/^story \d+$/) }),
      topic: {
        name: "AI agents",
        description: "AI agents: LLM agents that plan and use tools",
        scope_note: "Agents. Not: coding agents (→ AI for software development).",
      },
    });
    expect((states[0] as { item: { excerpt: string } }).item.excerpt).toMatch(/^story \d+\. Body/);
  });

  test("lời gọi lỗi: dùng luật R ≥ 0,6 cho sự kiện đó và đánh dấu", async () => {
    const mid = await addEvent(scoreForR(0.65));
    const low = await addEvent(scoreForR(0.55));
    const decider = fakeDecision({
      answer: () => {
        throw new Error("model hỏng");
      },
    });
    const r = await rankPeriod(db, periodEndingAt(END), { profileId: 1, config, decider });
    expect(r.picked.map((p) => p.event.eventId)).toEqual([mid.eventId]);
    expect(r.rejected.map((x) => [x.event.eventId, x.reason])).toEqual([[low.eventId, "gate"]]);
    expect(r.gateCounts).toEqual({ inBand: 2, asked: 0, passed: 0, rejected: 0, fallback: 2 });
    expect(r.gateDecisions.every((d) => d.fallback && d.probability === null)).toBe(true);
  });

  test("không có model quyết định: luật R ≥ 0,6 như trước, vùng xám vẫn được ghi", async () => {
    const mid = await addEvent(scoreForR(0.65));
    await addEvent(scoreForR(0.55));
    const r = await rankPeriod(db, periodEndingAt(END), { profileId: 1, config });
    expect(r.picked.map((p) => p.event.eventId)).toEqual([mid.eventId]);
    expect(r.gateCounts.fallback).toBe(2);
    expect(r.gateDecisions.find((d) => d.eventId === mid.eventId)?.pass).toBe(true);
  });

  describe("nhiều hồ sơ", () => {
    // Profile 2 only enables the "Rust" topic; profile 1 only enables "Agent" (built in beforeEach).
    let rustTopic = 0;
    beforeEach(async () => {
      await db.insert(profile).values({ id: 2, promptContext: "y" });
      const [t] = await db
        .insert(topics)
        .values({
          name: "Rust",
          embedText: "Rust language",
          description: "Rust",
          origin: "custom",
          ownerProfileId: 2,
        })
        .returning({ id: topics.id });
      rustTopic = t?.id ?? 0;
      await db.insert(profileTopics).values({ profileId: 2, topicId: rustTopic, active: true });
    });

    test("chủ đề đang bật của hồ sơ khác không lọt vào xếp hạng", async () => {
      const a = await rankPeriod(db, periodEndingAt(END), { profileId: 1 });
      const b = await rankPeriod(db, periodEndingAt(END), { profileId: 2 });
      expect([...a.topicLabels.values()]).toEqual(["Agent"]);
      expect([...b.topicLabels.values()]).toEqual(["Rust"]);
    });

    // Send item `e` to profile `profileId` before the ranking period.
    async function sendTo(
      profileId: number,
      recipient: string,
      e: { eventId: number; docId: number },
    ) {
      const [dg] = await db
        .insert(digests)
        .values({
          profileId,
          channel: "telegram",
          recipient,
          periodStart: new Date("2026-10-04T02:00:00Z"),
          periodEnd: new Date("2026-10-05T02:00:00Z"),
          lang: "vi",
        })
        .returning({ id: digests.id });
      await db.insert(deliveries).values({
        profileId,
        digestId: dg?.id ?? 0,
        channel: "telegram",
        recipient,
        messageId: `m${profileId}`,
        kind: "event",
        position: 1,
        eventId: e.eventId,
        documentIds: [e.docId],
        body: "đã gửi",
        sentAt: new Date("2026-10-05T23:00:00Z"),
      });
    }

    test("tin đã gửi cho A không làm B coi là đã thấy, vẫn làm A coi là đã thấy", async () => {
      // Both profiles score this document highly.
      const e = await addEvent(0.79);
      await db
        .insert(docTopicScores)
        .values({ documentId: e.docId, topicId: rustTopic, score: 0.79 });
      await db.insert(baselines).values({
        metric: "relevance",
        sourceId: hn,
        topicId: rustTopic,
        median: 0.4,
        p999: 0.8,
        n: 10_000,
        windowDays: 30,
      });
      await sendTo(1, "A", e);
      const a = await rankPeriod(db, periodEndingAt(END), { profileId: 1 });
      const b = await rankPeriod(db, periodEndingAt(END), { profileId: 2 });
      expect(a.picked).toHaveLength(0);
      expect(a.rejected[0]?.reason).toBe("not_new");
      expect(b.picked.map((p) => p.event.eventId)).toEqual([e.eventId]);
    });
  });
});
