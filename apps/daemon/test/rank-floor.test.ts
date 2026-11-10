/**
 * Sàn theo phân vị trong `rankPeriod`: đọc bể `candidate_pool` của hồ sơ, 14 ngày đầu dùng sàn cố
 * định, cửa sổ [end − 30 ngày, end), tin đã gửi không tính. Giá trị kỳ vọng tính tay trong từng test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  baselines,
  candidatePool,
  createDatabase,
  docText,
  docTopicScores,
  documents,
  eventDocuments,
  events,
  profile,
  runMigrations,
  sources,
} from "@radard/db";
import { sql } from "drizzle-orm";
import { periodEndingAt, rankPeriod } from "../src/jobs/rank.ts";
import { addTopic } from "./topic-fixture.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const END = new Date("2026-10-06T02:00:00Z");
const IN = new Date("2026-10-05T12:00:00Z");
const DAY = 86_400_000;
let hn = 0;
let topic = 0;
let seq = 0;

/** Một sự kiện HN có điểm chủ đề 0,79 (R = 0,975), nằm trong khoảng 24 giờ trước END. */
async function addEvent(score = 0.79): Promise<number> {
  const id = ++seq;
  const [d] = await db
    .insert(documents)
    .values({
      sourceId: hn,
      externalId: String(id),
      url: `https://x.com/${id}`,
      urlCanonical: `https://x.com/${id}`,
      title: `story ${id}`,
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
      title: `story ${id}`,
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
  await db.insert(docText).values({
    documentId: d?.id ?? 0,
    text: `story ${id}`,
    lang: "eng",
    embedding: v,
    embeddingModel: "m",
  });
  return e?.id ?? 0;
}

let poolSeq = 0;
/** Ghi dòng bể: `daysAgo` ngày trước END, mỗi điểm một dòng. */
async function seedPool(
  daysAgo: number,
  scores: number[],
  o: { profileId?: number; notNew?: boolean } = {},
) {
  const end = new Date(END.getTime() - daysAgo * DAY);
  await db.insert(candidatePool).values(
    scores.map((score) => ({
      profileId: o.profileId ?? 1,
      periodStart: new Date(end.getTime() - DAY),
      periodEnd: end,
      eventId: 1_000_000 + ++poolSeq,
      urlCanonicals: [`https://pool/${poolSeq}`],
      sourceId: hn,
      r: 1,
      p: 0,
      c: 0,
      a: 0,
      f: 0,
      n: o.notNew ? 0 : 1,
      score,
      selected: false,
      rejectReason: o.notNew ? "not_new" : "floor",
    })),
  );
}

/** 40 điểm 0,30; 0,31; …; 0,69. */
const spread40 = Array.from({ length: 40 }, (_, i) => 0.3 + 0.01 * i);
const same = (n: number, v: number) => new Array<number>(n).fill(v);

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  await db.execute(
    sql`truncate sources, events, profile, topics, documents, candidate_pool restart identity cascade`,
  );
  poolSeq = 0;
  const [s] = await db
    .insert(sources)
    .values({ kind: "hn", name: "HN", cadence: "*/15 * * * *", trustScore: 0.6 })
    .returning({ id: sources.id });
  hn = s?.id ?? 0;
  await db.insert(profile).values({ promptContext: "x" });
  topic = await addTopic(db, "Agent", { embedText: "AI agents" });
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

const rank = (config?: Parameters<typeof rankPeriod>[2]["config"]) =>
  rankPeriod(db, periodEndingAt(END), { profileId: 1, config });

describe("sàn theo phân vị", () => {
  test("(a) dưới 14 ngày dữ liệu: sàn cố định, kết quả y hệt floorMode fixed", async () => {
    const id = await addEvent();
    // 13 ngày × 40 dòng điểm 0,99: nếu dùng phân vị thì sàn là 0,99 và tin bị loại.
    for (let d = 1; d <= 13; d++) await seedPool(d, same(40, 0.99));
    const pct = await rank();
    const fixed = await rank({ floorMode: "fixed" });
    expect(pct.floor).toEqual({ value: 0.59, source: "fixed", days: 13 });
    expect(pct.picked.map((p) => p.event.eventId)).toEqual([id]);
    expect(pct.picked.map((p) => [p.event.eventId, p.S])).toEqual(
      fixed.picked.map((p) => [p.event.eventId, p.S]),
    );
    expect(pct.rejected.map((r) => r.reason)).toEqual(fixed.rejected.map((r) => r.reason));
    expect(fixed.floor.source).toBe("fixed");
    expect(fixed.floor.value).toBe(0.59);
  });

  test("(b)(g) đủ 14 ngày × 40 dòng: n = 40, q = 0,7, sàn = phân vị 70 tính tay", async () => {
    await addEvent();
    for (let d = 1; d <= 14; d++) await seedPool(d, spread40);
    const r = await rank();
    // 560 điểm, mỗi giá trị 0,30 + 0,01 i lặp 14 lần. Vị trí 559 × 0,7 = 391,3.
    // Chỉ số 391 ↔ i = 27 (378..391) → 0,57; chỉ số 392 ↔ i = 28 → 0,58. Nội suy: 0,57 + 0,3 × 0,01.
    expect(r.floor.source).toBe("percentile");
    expect(r.floor.days).toBe(14);
    expect(r.floor.n).toBeCloseTo(40, 9);
    expect(r.floor.q).toBeCloseTo(0.7, 9);
    expect(r.floor.value).toBeCloseTo(0.573, 9);
  });

  test("(b) sàn phân vị thật sự dùng để chọn: sàn cao hơn S thì tin bị loại với lý do floor", async () => {
    const id = await addEvent();
    for (let d = 1; d <= 14; d++) await seedPool(d, same(40, 0.99));
    const r = await rank();
    expect(r.floor.value).toBeCloseTo(0.99, 9);
    expect(r.picked).toEqual([]);
    expect(r.rejected.map((x) => [x.event.eventId, x.reason])).toEqual([[id, "floor"]]);
    const fixed = await rank({ floorMode: "fixed" });
    expect(fixed.picked.map((p) => p.event.eventId)).toEqual([id]);
  });

  test("(c) dòng not_new bị loại khỏi cả phân vị lẫn n", async () => {
    await addEvent();
    for (let d = 1; d <= 14; d++) {
      await seedPool(d, same(40, 0.5));
      await seedPool(d, same(40, 0.99), { notNew: true });
    }
    const r = await rank();
    // Nếu tính cả not_new: n = 80, q = 0,85, sàn = 0,99. Đúng: n = 40, q = 0,7, mọi điểm 0,5.
    expect(r.floor.n).toBeCloseTo(40, 9);
    expect(r.floor.q).toBeCloseTo(0.7, 9);
    expect(r.floor.value).toBeCloseTo(0.5, 9);
    expect(r.floor.days).toBe(14);
  });

  test("(d) cửa sổ không gồm ngày đang xếp hạng và dữ liệu cũ hơn 30 ngày; chạy lại ra cùng sàn", async () => {
    await addEvent();
    for (let d = 1; d <= 14; d++) await seedPool(d, same(40, 0.5));
    await seedPool(0, same(40, 0.99)); // chính ngày đang xếp hạng (period_end = END)
    await seedPool(31, same(40, 0.99)); // ngoài cửa sổ 30 ngày
    await seedPool(45, same(40, 0.99));
    const a = await rank();
    const b = await rank();
    expect(a.floor).toEqual(b.floor);
    expect(a.floor.days).toBe(14);
    expect(a.floor.n).toBeCloseTo(40, 9);
    expect(a.floor.value).toBeCloseTo(0.5, 9);
  });

  test("(d) ngày dữ liệu ngoài cửa sổ không giúp đủ 14 ngày", async () => {
    await addEvent();
    for (let d = 1; d <= 10; d++) await seedPool(d, same(40, 0.5));
    for (let d = 31; d <= 35; d++) await seedPool(d, same(40, 0.5));
    const r = await rank();
    expect(r.floor).toEqual({ value: 0.59, source: "fixed", days: 10 });
  });

  test("(e) dữ liệu của hồ sơ khác không lẫn vào", async () => {
    await addEvent();
    await db.insert(profile).values({ id: 2, promptContext: "y" });
    for (let d = 1; d <= 14; d++) await seedPool(d, same(40, 0.99), { profileId: 2 });
    const r = await rank();
    expect(r.floor).toEqual({ value: 0.59, source: "fixed", days: 0 });
    for (let d = 1; d <= 14; d++) await seedPool(d, same(40, 0.5));
    const r2 = await rank();
    expect(r2.floor.value).toBeCloseTo(0.5, 9);
    expect(r2.floor.n).toBeCloseTo(40, 9);
  });

  test("(f) n ≤ 12 thì q kẹp về 0: sàn = điểm thấp nhất; bể rỗng thì sàn cố định", async () => {
    await addEvent();
    const empty = await rank();
    expect(empty.floor).toEqual({ value: 0.59, source: "fixed", days: 0 });
    // 14 ngày × 10 dòng 0,1 … 1,0: n = 10, 1 − 12/10 = −0,2 → q = 0.
    for (let d = 1; d <= 14; d++) {
      await seedPool(
        d,
        Array.from({ length: 10 }, (_, i) => 0.1 * (i + 1)),
      );
    }
    const r = await rank();
    expect(r.floor.source).toBe("percentile");
    expect(r.floor.n).toBeCloseTo(10, 9);
    expect(r.floor.q).toBe(0);
    expect(r.floor.value).toBeCloseTo(0.1, 9);
  });

  test("floorMode fixed không đọc bể", async () => {
    await addEvent();
    for (let d = 1; d <= 14; d++) await seedPool(d, same(40, 0.99));
    const r = await rank({ floorMode: "fixed" });
    expect(r.floor).toEqual({ value: 0.59, source: "fixed", days: 0 });
    expect(r.picked).toHaveLength(1);
  });
});
