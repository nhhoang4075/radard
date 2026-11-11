/**
 * Candidate pool: each digest ranking run, every event that passes the gate (chosen or not) gets one row
 * in `candidate_pool`; rerunning does not double it; profiles do not mix; a write error does not block sending.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { fakeNotifier } from "@radard/adapters/notify-fake";
import {
  baselines,
  candidatePool,
  createDatabase,
  digests,
  docTopicScores,
  documents,
  eventDocuments,
  events,
  profile,
  runMigrations,
  sources,
} from "@radard/db";
import { eq, sql } from "drizzle-orm";
import { readCandidateScores, recordCandidatePool } from "../src/jobs/candidate-pool.ts";
import { type DigestPlan, runDigest } from "../src/jobs/digest.ts";
import { rankPeriod } from "../src/jobs/rank.ts";
import { addTopic } from "./topic-fixture.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const RECIPIENT = "100000001";
/** 07:00 Vietnam time on 06/10. */
const SLOT = new Date("2026-10-06T00:00:00Z");
const PERIOD = { start: new Date(SLOT.getTime() - 86_400_000), end: SLOT };
const IN = new Date("2026-10-05T12:00:00Z");
let hn = 0;
let topic = 0;
let seq = 0;

async function addEvent(score: number): Promise<number> {
  const id = ++seq;
  const [d] = await db
    .insert(documents)
    .values({
      sourceId: hn,
      externalId: String(1000 + id),
      url: `https://www.site${id}.com/post`,
      urlCanonical: `https://site${id}.com/post`,
      title: `Original title ${id}`,
      publishedAt: IN,
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
      title: `seed ${id}`,
      firstSeenAt: IN,
      lastSeenAt: IN,
      centroid: v,
      embeddingModel: "m",
    })
    .returning({ id: events.id });
  await db
    .insert(eventDocuments)
    .values({ eventId: e?.id ?? 0, documentId: d?.id ?? 0, similarity: 1, reason: "seed" });
  await db.insert(docTopicScores).values({ documentId: d?.id ?? 0, topicId: topic, score });
  return e?.id ?? 0;
}

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  seq = 0;
  await db.execute(
    sql`truncate sources, events, profile, topics, documents, digests, candidate_pool restart identity cascade`,
  );
  const [s] = await db
    .insert(sources)
    .values({ kind: "hn", name: "HN", cadence: "*/15 * * * *", trustScore: 0.6 })
    .returning({ id: sources.id });
  hn = s?.id ?? 0;
  await db.insert(profile).values({ promptContext: "I build AI agents.", displayLang: "vi" });
  topic = await addTopic(db, "Agent AI", { embedText: "agents" });
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

const deps = (profileId = 1) => ({
  db,
  profileId,
  llm: null,
  notifier: fakeNotifier(),
  recipient: RECIPIENT,
});

/**
 * 12 good items from one source and 1 item with low R dropped by the gate. Feed snapshot: 10 items in (feedMaxPerSource = 10),
 * 2 over the per-source cap. Notification layer: 5 items (5 per source for the first 7 items).
 */
async function seedDay() {
  for (let i = 0; i < 12; i++) await addEvent(0.79);
  await addEvent(0.1);
}

describe("candidate_pool", () => {
  test("ghi đủ mọi tin qua cổng; selected đúng với tin được chọn; tin bị cổng loại vắng", async () => {
    await seedDay();
    await runDigest(deps(), SLOT);
    const rows = await db.select().from(candidatePool);
    expect(rows).toHaveLength(12);
    expect(rows.filter((r) => r.selected)).toHaveLength(10);
    const dropped = rows.filter((r) => !r.selected);
    expect(dropped.map((r) => r.rejectReason)).toEqual(["source_cap", "source_cap"]);
    expect(dropped.every((r) => r.penalty === null)).toBe(true);
    expect(rows.every((r) => r.profileId === 1 && r.u === 0)).toBe(true);
    expect(rows[0]?.periodEnd.getTime()).toBe(SLOT.getTime());
    expect(rows[0]?.urlCanonicals).toHaveLength(1);
  });

  test("thành phần ghi ra khớp thành phần trong digests.meta.plan của tin được chọn", async () => {
    await seedDay();
    await runDigest(deps(), SLOT);
    const [dg] = await db.select().from(digests);
    const meta = (dg?.meta ?? {}) as { plan?: DigestPlan };
    const plan = meta.plan;
    if (!plan) throw new Error("chưa có plan");
    expect(plan.items).toHaveLength(5);
    const rows = await db.select().from(candidatePool).where(eq(candidatePool.selected, true));
    const r3 = (x: number | null | undefined) => Math.round((x ?? 0) * 1000) / 1000;
    for (const it of plan.items) {
      const row = rows.find((r) => r.eventId === it.eventId);
      expect(row).toBeDefined();
      expect([r3(row?.score), r3(row?.penalty)]).toEqual([it.score.S, it.score.penalty]);
      expect([row?.r, row?.p, row?.c, row?.a, row?.f, row?.u, row?.n].map(r3)).toEqual([
        it.score.R,
        it.score.P,
        it.score.C,
        it.score.A,
        it.score.F,
        it.score.U ?? Number.NaN,
        it.score.N,
      ]);
    }
  });

  test("chạy lại cùng khoảng không nhân đôi, và xoá dòng không còn trong kết quả mới", async () => {
    await seedDay();
    const rank = await rankPeriod(db, PERIOD, { profileId: 1 });
    await recordCandidatePool(db, 1, rank);
    await recordCandidatePool(db, 1, rank);
    expect(await db.select().from(candidatePool)).toHaveLength(12);
    // New result is smaller: extra rows are deleted, remaining rows are updated.
    await recordCandidatePool(db, 1, { ...rank, picked: rank.picked.slice(0, 2), rejected: [] });
    const rows = await db.select().from(candidatePool);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.selected)).toBe(true);
  });

  test("hai hồ sơ có dòng riêng, đọc theo profileId không lẫn", async () => {
    await db.insert(profile).values({ id: 2, promptContext: "y" });
    await seedDay();
    const rank = await rankPeriod(db, PERIOD, { profileId: 1 });
    await recordCandidatePool(db, 1, rank);
    await recordCandidatePool(db, 2, { ...rank, picked: rank.picked.slice(0, 1), rejected: [] });
    const range = { from: new Date(SLOT.getTime() - 1000), to: new Date(SLOT.getTime() + 1000) };
    expect(await readCandidateScores(db, { profileId: 1, ...range })).toHaveLength(12);
    const two = await readCandidateScores(db, { profileId: 2, ...range });
    expect(two).toHaveLength(1);
    expect(two[0]?.profileId).toBe(2);
    expect(await readCandidateScores(db, { profileId: 1, from: SLOT, to: SLOT })).toHaveLength(0);
  });

  test("lỗi ghi bể không làm hỏng việc gửi tin", async () => {
    await seedDay();
    await db.execute(sql`alter table candidate_pool rename to candidate_pool_off`);
    try {
      const d = deps();
      const out = await runDigest(d, SLOT);
      expect(out).toMatchObject({ status: "sent", items: 5 });
      expect(d.notifier.sent).toHaveLength(6);
    } finally {
      await db.execute(sql`alter table candidate_pool_off rename to candidate_pool`);
    }
    expect(await db.select().from(candidatePool)).toHaveLength(0);
  });
});
