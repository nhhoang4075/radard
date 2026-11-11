/**
 * Feed snapshot (decision 10/11/2026, mo-hinh-de-xuat.html: "the web feed is the main source, Telegram is only
 * the notification channel"). Expected values come from the spec: K = feedMaxItems = 30 is a cap, not a target;
 * feedMaxPerSource = 10; per-source slots stay unchanged; Telegram ≤ 7 first items past the notification floor,
 * 5 items per source; one snapshot per (profile, day), rerunning does not rebuild; impressions are idempotent, isolated
 * per profile; "seen" (impressions) counts as N like "sent".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeNotifier } from "@radard/adapters/notify-fake";
import { DEFAULT_RANK_CONFIG } from "@radard/core";
import {
  baselines,
  candidatePool,
  createDatabase,
  deliveries,
  digests,
  docTopicScores,
  documents,
  eventDocuments,
  events,
  feedback,
  feedImpressions,
  feedItems,
  feedPage,
  feedSnapshots,
  latestFeedSnapshot,
  profile,
  profileChannels,
  profileTopics,
  recordFeedFeedback,
  recordImpressions,
  runMigrations,
  scrollDepths,
  sources,
} from "@radard/db";
import { asc, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { runDigest, runDigestAll } from "../src/jobs/digest.ts";
import { ensureFeedSnapshot } from "../src/jobs/feed.ts";
import { recordFeedback } from "../src/jobs/feedback.ts";
import { periodEndingAt, rankPeriod } from "../src/jobs/rank.ts";
import { addTopic } from "./topic-fixture.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const fails = (q: PromiseLike<unknown>) => Promise.resolve().then(() => q);
const A = "100000001";
const B = "100000002";
/** 07:00 Vietnam time on 06/10 and 07/10. */
const SLOT = new Date("2026-10-06T00:00:00Z");
const SLOT2 = new Date("2026-10-07T00:00:00Z");
const IN = new Date("2026-10-05T12:00:00Z");
const IN2 = new Date("2026-10-06T12:00:00Z");
let topic = 0;
let seq = 0;

async function addSource(name: string): Promise<number> {
  const [s] = await db
    .insert(sources)
    .values({ kind: "hn", name, cadence: "*/15 * * * *", trustScore: 0.6 })
    .returning({ id: sources.id });
  const id = s?.id ?? 0;
  await db.insert(baselines).values([
    {
      metric: "relevance",
      sourceId: id,
      topicId: topic,
      median: 0.4,
      p999: 0.8,
      n: 10_000,
      windowDays: 30,
    },
    { metric: "engagement", sourceId: id, median: 1, p999: 7, n: 10_000, windowDays: 30 },
  ]);
  return id;
}

async function addDoc(eventId: number, sourceId: number, score: number, at: Date) {
  const id = ++seq;
  const [d] = await db
    .insert(documents)
    .values({
      sourceId,
      externalId: String(1000 + id),
      url: `https://site${id}.com/post`,
      urlCanonical: `https://site${id}.com/post`,
      title: `Original title ${id}`,
      publishedAt: at,
      contentSha256: `s${id}`,
      rawKey: `r/${id}`,
      contentType: "application/json",
    })
    .returning({ id: documents.id });
  await db
    .insert(eventDocuments)
    .values({ eventId, documentId: d?.id ?? 0, similarity: 1, reason: "seed" });
  await db.insert(docTopicScores).values({ documentId: d?.id ?? 0, topicId: topic, score });
  return d?.id ?? 0;
}

/** One event with one document; centroids are orthogonal so there is no overlap penalty. */
async function addEvent(sourceId: number, score = 0.79, at = IN): Promise<number> {
  const v = new Array(1024).fill(0);
  v[(seq + 1) % 1024] = 1;
  const [e] = await db
    .insert(events)
    .values({
      title: `ev ${seq + 1}`,
      firstSeenAt: at,
      lastSeenAt: at,
      centroid: v,
      embeddingModel: "m",
    })
    .returning({ id: events.id });
  await addDoc(e?.id ?? 0, sourceId, score, at);
  return e?.id ?? 0;
}

const snapshotRows = () => db.select().from(feedSnapshots).orderBy(asc(feedSnapshots.id));
const itemsOf = (snapshotId: number) =>
  db
    .select()
    .from(feedItems)
    .where(eq(feedItems.snapshotId, snapshotId))
    .orderBy(asc(feedItems.position));

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  seq = 0;
  await db.execute(
    sql`truncate sources, events, profile, topics, documents, digests, profile_channels, candidate_pool restart identity cascade`,
  );
  await db.insert(profile).values({ promptContext: "I build AI agents.", displayLang: "vi" });
  topic = await addTopic(db, "Agent AI", { embedText: "agents" });
  await db
    .insert(baselines)
    .values({ metric: "coverage", median: 0.3, p999: 2, n: 10_000, windowDays: 30 });
});

afterAll(async () => {
  await db.$bun.close();
});

describe("cấu hình", () => {
  test("mặc định đúng spec: K = 30, 10 tin/nguồn cho feed; 7 tin, 5/nguồn, ~12/ngày cho thông báo; sàn feed ~30/ngày", () => {
    expect(DEFAULT_RANK_CONFIG.feedMaxItems).toBe(30);
    expect(DEFAULT_RANK_CONFIG.feedMaxPerSource).toBe(10);
    expect(DEFAULT_RANK_CONFIG.feedFloorTargetPerDay).toBe(30);
    expect(DEFAULT_RANK_CONFIG.notify).toEqual({
      maxItems: 7,
      maxPerSource: 5,
      floorTargetPerDay: 12,
    });
    expect(DEFAULT_RANK_CONFIG.temperature).toBe(0.03);
  });
});

describe("bản chụp feed", () => {
  test("trần K = 30: 40 tin đạt sàn trên 5 nguồn thì bản chụp có đúng 30 tin, vị trí 1..30, ≤ 10 tin/nguồn, mỗi nguồn một chỗ giữ", async () => {
    const srcs = [];
    for (let s = 0; s < 5; s++) srcs.push(await addSource(`S${s}`));
    for (let i = 0; i < 40; i++) await addEvent(srcs[i % 5] ?? 0);
    const { snapshot, items, built } = await ensureFeedSnapshot({ db, profileId: 1 }, SLOT);
    expect(built).toBe(true);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.itemCount).toBe(30);
    expect(items.map((i) => i.position)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    const per = new Map<number, number>();
    for (const it of items) per.set(it.sourceId, (per.get(it.sourceId) ?? 0) + 1);
    expect(Math.max(...per.values())).toBeLessThanOrEqual(10);
    expect(
      items
        .filter((i) => i.reserved)
        .map((i) => i.sourceId)
        .sort(),
    ).toEqual([...srcs].sort());
    expect(items.every((i) => i.profileId === 1 && i.documentIds.length === 1)).toBe(true);
    // Order by S − penalty, descending.
    const keys = items.map((i) => i.score - i.penalty);
    expect(keys).toEqual([...keys].sort((a, b) => b - a));
    expect(snapshot.config).toMatchObject({ maxItems: 30, maxPerSource: 10, temperature: 0.03 });
    expect(snapshot.feedFloor).toBe(0.59);
    expect(snapshot.notifyFloor).toBe(0.59);
  });

  test("K là trần, không phải mục tiêu: hết tin đạt sàn thì dừng", async () => {
    const hn = await addSource("HN");
    for (let i = 0; i < 3; i++) await addEvent(hn);
    await addEvent(hn, 0.66); // passes the gate, S below the floor 0,59
    const { items } = await ensureFeedSnapshot({ db, profileId: 1 }, SLOT);
    expect(items).toHaveLength(3);
  });

  test("feedMaxPerSource = 10: 14 tin một nguồn thì feed 10 tin, thông báo 5 tin (5/nguồn)", async () => {
    const hn = await addSource("HN");
    for (let i = 0; i < 14; i++) await addEvent(hn);
    const { items } = await ensureFeedSnapshot({ db, profileId: 1 }, SLOT);
    expect(items).toHaveLength(10);
    const notify = items.filter((i) => i.notifyPosition !== null);
    expect(notify.map((i) => i.notifyPosition)).toEqual([1, 2, 3, 4, 5]);
    // Notifications take the FIRST items of the snapshot.
    expect(notify.map((i) => i.position)).toEqual([1, 2, 3, 4, 5]);
  });

  test("giữ chỗ theo nguồn khi K chật: 3 nguồn × 11 tin điểm cao lấp đủ 30 chỗ, tin duy nhất của nguồn điểm thấp vẫn vào", async () => {
    const big = [await addSource("A"), await addSource("B"), await addSource("C")];
    for (let i = 0; i < 33; i++) await addEvent(big[i % 3] ?? 0, 0.8);
    const low = await addSource("D");
    const only = await addEvent(low, 0.79);
    const { items } = await ensureFeedSnapshot({ db, profileId: 1 }, SLOT);
    expect(items).toHaveLength(30);
    const it = items.find((i) => i.eventId === only);
    expect(it?.reserved).toBe(true);
    // The lowest score should be at the end of the snapshot.
    expect(it?.position).toBe(30);
  });

  test("thông báo ≤ 7 tin đầu: 12 tin trên hai nguồn thì feed 12 tin, Telegram 7 tin theo thứ tự bản chụp", async () => {
    const a = await addSource("A");
    const b = await addSource("B");
    for (let i = 0; i < 12; i++) await addEvent(i % 2 ? a : b);
    await db.insert(profileChannels).values({ profileId: 1, channel: "telegram", recipient: A });
    const notifier = fakeNotifier();
    await runDigestAll({ db, llm: null, notifier }, SLOT);
    const [snap] = await snapshotRows();
    const items = await itemsOf(snap?.id ?? 0);
    expect(items).toHaveLength(12);
    const notified = items.filter((i) => i.notifyPosition !== null);
    expect(notified).toHaveLength(7);
    // Sent items: header + 7; each event item links to the feed item at the reported position.
    expect(notifier.sent).toHaveLength(8);
    const dls = await db
      .select()
      .from(deliveries)
      .where(eq(deliveries.kind, "event"))
      .orderBy(asc(deliveries.position));
    expect(dls.map((d) => d.feedItemId)).toEqual(
      [...notified]
        .sort((x, y) => (x.notifyPosition ?? 0) - (y.notifyPosition ?? 0))
        .map((i) => i.id),
    );
    expect(dls.map((d) => d.eventId)).toEqual(
      [...notified]
        .sort((x, y) => (x.notifyPosition ?? 0) - (y.notifyPosition ?? 0))
        .map((i) => i.eventId),
    );
    const [dg] = await db.select().from(digests);
    expect(dg?.feedSnapshotId).toBe(snap?.id ?? -1);
  });
});

describe("một bản chụp mỗi ngày", () => {
  test("hai người nhận cùng hồ sơ, chạy lại nhiều lần: một bản chụp; tin mới sau 07:00 không làm dựng lại", async () => {
    const hn = await addSource("HN");
    for (let i = 0; i < 4; i++) await addEvent(hn);
    await db.insert(profileChannels).values([
      { profileId: 1, channel: "telegram", recipient: A },
      { profileId: 1, channel: "telegram", recipient: B },
    ]);
    const notifier = fakeNotifier();
    await runDigestAll({ db, llm: null, notifier }, SLOT);
    const [first] = await snapshotRows();
    const before = await itemsOf(first?.id ?? 0);
    await addEvent(hn, 0.8); // item arrives after it was built
    await runDigestAll({ db, llm: null, notifier }, SLOT);
    const again = await ensureFeedSnapshot({ db, profileId: 1 }, SLOT);
    expect(again.built).toBe(false);
    expect(await snapshotRows()).toHaveLength(1);
    expect(again.items.map((i) => [i.id, i.eventId])).toEqual(before.map((i) => [i.id, i.eventId]));
    // Both recipients receive exactly the snapshot's items.
    const per = await db
      .select({ recipient: deliveries.recipient, feedItemId: deliveries.feedItemId })
      .from(deliveries)
      .where(eq(deliveries.kind, "event"))
      .orderBy(asc(deliveries.id));
    const ofA = per.filter((d) => d.recipient === A).map((d) => d.feedItemId);
    const ofB = per.filter((d) => d.recipient === B).map((d) => d.feedItemId);
    expect(ofA).toHaveLength(4);
    expect(ofA).toEqual(ofB);
  });

  test("hạt giống lưu trước khi chọn: dòng `building` có sẵn hạt thì lượt dựng dùng đúng hạt đó", async () => {
    const hn = await addSource("HN");
    for (let i = 0; i < 4; i++) await addEvent(hn);
    await db.insert(feedSnapshots).values({
      profileId: 1,
      periodStart: new Date(SLOT.getTime() - 86_400_000),
      periodEnd: SLOT,
      selectSeed: 4242,
    });
    const { snapshot, built } = await ensureFeedSnapshot({ db, profileId: 1 }, SLOT);
    expect(built).toBe(true);
    expect(snapshot.selectSeed).toBe(4242);
    expect((snapshot.meta.learning as { selectSeed?: number } | undefined)?.selectSeed).toBe(4242);
  });

  test("ngày khác thì bản chụp khác; hồ sơ khác thì bản chụp riêng", async () => {
    const hn = await addSource("HN");
    await addEvent(hn);
    await db.insert(profile).values({ id: 2, promptContext: "y" });
    await db.insert(profileTopics).values({ profileId: 2, topicId: topic });
    await ensureFeedSnapshot({ db, profileId: 1 }, SLOT);
    await ensureFeedSnapshot({ db, profileId: 2 }, SLOT);
    await ensureFeedSnapshot({ db, profileId: 1 }, SLOT2);
    const rows = await snapshotRows();
    expect(rows.map((r) => [r.profileId, r.periodEnd.getTime()])).toEqual([
      [1, SLOT.getTime()],
      [2, SLOT.getTime()],
      [1, SLOT2.getTime()],
    ]);
  });

  test("digest chết sau khi bản chụp đã lưu: lượt sau đọc lại bản chụp, không chọn lại", async () => {
    const hn = await addSource("HN");
    for (let i = 0; i < 4; i++) await addEvent(hn);
    const notifier = fakeNotifier({ failAfter: 2 });
    const deps = { db, profileId: 1, llm: null, notifier, recipient: A };
    await expect(runDigest(deps, SLOT)).rejects.toThrow();
    await db.update(digests).set({ meta: {} }); // plan lost: must be rebuilt from the snapshot
    await db.delete(deliveries);
    await addEvent(hn, 0.8);
    notifier.failAfter = undefined;
    await runDigest(deps, SLOT);
    const [snap] = await snapshotRows();
    const notified = (await itemsOf(snap?.id ?? 0)).filter((i) => i.notifyPosition !== null);
    const sent = await db.select().from(deliveries).where(eq(deliveries.kind, "event"));
    expect(new Set(sent.map((d) => d.eventId))).toEqual(new Set(notified.map((i) => i.eventId)));
    expect(sent).toHaveLength(4);
  });
});

describe("sàn feed tách sàn thông báo", () => {
  test("đủ 14 ngày bể: sàn feed nhắm 30 tin/ngày, sàn thông báo 12 tin/ngày; n ≤ 30 thì feed không lọc", async () => {
    const hn = await addSource("HN");
    await addEvent(hn);
    const pool = async (perDay: number) => {
      await db.execute(sql`truncate candidate_pool`);
      let k = 0;
      for (let d = 1; d <= 14; d++) {
        const end = new Date(SLOT.getTime() - d * 86_400_000);
        await db.insert(candidatePool).values(
          Array.from({ length: perDay }, (_, i) => ({
            profileId: 1,
            periodStart: new Date(end.getTime() - 86_400_000),
            periodEnd: end,
            eventId: 1_000_000 + ++k,
            urlCanonicals: [`https://pool/${k}`],
            sourceId: hn,
            r: 1,
            p: 0,
            c: 0,
            a: 0,
            f: 0,
            n: 1,
            score: 0.3 + (0.4 * i) / perDay,
            selected: false,
            rejectReason: "floor",
          })),
        );
      }
    };
    await pool(40);
    const r = await rankPeriod(db, periodEndingAt(SLOT), { profileId: 1 });
    expect(r.feedFloor.source).toBe("percentile");
    expect(r.feedFloor.q).toBeCloseTo(1 - 30 / 40, 9);
    expect(r.floor.q).toBeCloseTo(1 - 12 / 40, 9);
    expect(r.feedFloor.value).toBeLessThan(r.floor.value);
    expect(r.selectConfig.floorS).toBe(r.feedFloor.value);
    await pool(20);
    const r2 = await rankPeriod(db, periodEndingAt(SLOT), { profileId: 1 });
    expect(r2.feedFloor).toMatchObject({ source: "percentile", q: 0, value: 0 });
    expect(r2.floor.q).toBeCloseTo(1 - 12 / 20, 9);
  });
});

describe("lượt hiện", () => {
  async function twoProfiles() {
    const hn = await addSource("HN");
    for (let i = 0; i < 3; i++) await addEvent(hn);
    await db.insert(profile).values({ id: 2, promptContext: "y" });
    await db.insert(profileTopics).values({ profileId: 2, topicId: topic });
    const one = await ensureFeedSnapshot({ db, profileId: 1 }, SLOT);
    const two = await ensureFeedSnapshot({ db, profileId: 2 }, SLOT);
    return { one: one.snapshot.id, two: two.snapshot.id };
  }

  test("ghi lô idempotent: lần hai không thêm dòng, giữ seen_at đầu", async () => {
    const { one } = await twoProfiles();
    const a = await recordImpressions(db, 1, [
      { snapshotId: one, position: 1 },
      { snapshotId: one, position: 2 },
      { snapshotId: one, position: 2 },
    ]);
    expect(a).toEqual({ ok: true, inserted: 2, duplicate: 0 });
    const first = await db.select().from(feedImpressions).orderBy(asc(feedImpressions.position));
    const b = await recordImpressions(db, 1, [
      { snapshotId: one, position: 2 },
      { snapshotId: one, position: 3 },
    ]);
    expect(b).toEqual({ ok: true, inserted: 1, duplicate: 1 });
    const rows = await db.select().from(feedImpressions).orderBy(asc(feedImpressions.position));
    expect(rows.map((r) => [r.profileId, r.snapshotId, r.position])).toEqual([
      [1, one, 1],
      [1, one, 2],
      [1, one, 3],
    ]);
    expect(rows[1]?.seenAt.getTime()).toBe(first[1]?.seenAt.getTime() ?? -1);
  });

  test("fail-closed: bản chụp của hồ sơ khác hoặc vị trí không tồn tại thì không ghi gì cả lô", async () => {
    const { one, two } = await twoProfiles();
    const other = await recordImpressions(db, 1, [
      { snapshotId: one, position: 1 },
      { snapshotId: two, position: 1 },
    ]);
    expect(other).toEqual({ ok: false, invalid: [{ snapshotId: two, position: 1 }] });
    const missing = await recordImpressions(db, 1, [{ snapshotId: one, position: 99 }]);
    expect(missing.ok).toBe(false);
    const bad = await recordImpressions(db, 1, [{ snapshotId: one, position: 0 }]);
    expect(bad.ok).toBe(false);
    expect(await db.select().from(feedImpressions)).toHaveLength(0);
    // The composite foreign key blocks writes even when the code skips the check.
    await expect(
      fails(db.insert(feedImpressions).values({ profileId: 1, snapshotId: two, position: 1 })),
    ).rejects.toThrow();
  });

  test("độ sâu cuộn mỗi ngày: vị trí lớn nhất đã hiện; cuộn hết K là bị chặn", async () => {
    const { one } = await twoProfiles();
    const range = { profileId: 1, from: new Date(0), to: new Date(SLOT.getTime() + 1) };
    expect(await scrollDepths(db, range)).toMatchObject([
      { snapshotId: one, itemCount: 3, deepestPosition: 0, censored: false },
    ]);
    await recordImpressions(db, 1, [{ snapshotId: one, position: 2 }]);
    expect((await scrollDepths(db, range))[0]).toMatchObject({
      deepestPosition: 2,
      censored: false,
    });
    await recordImpressions(db, 1, [{ snapshotId: one, position: 3 }]);
    expect((await scrollDepths(db, range))[0]).toMatchObject({
      deepestPosition: 3,
      censored: true,
    });
    expect(await scrollDepths(db, { ...range, profileId: 2 })).toMatchObject([
      { deepestPosition: 0 },
    ]);
  });

  test("đọc theo trang chỉ thấy bản chụp của chính hồ sơ", async () => {
    const { one, two } = await twoProfiles();
    expect((await latestFeedSnapshot(db, 1))?.id).toBe(one);
    expect((await latestFeedSnapshot(db, 2))?.id).toBe(two);
    const p1 = await feedPage(db, { profileId: 1, snapshotId: one, limit: 2 });
    expect(p1.items.map((i) => i.position)).toEqual([1, 2]);
    expect(p1).toMatchObject({ nextAfter: 2, done: false });
    const p2 = await feedPage(db, { profileId: 1, snapshotId: one, after: 2, limit: 2 });
    expect(p2.items.map((i) => i.position)).toEqual([3]);
    expect(p2).toMatchObject({ nextAfter: null, done: true });
    expect((await feedPage(db, { profileId: 1, snapshotId: two })).items).toEqual([]);
  });

  test("đã thấy (lượt hiện) tính như đã gửi cho N; tin feed chưa cuộn tới vẫn mới hôm sau", async () => {
    const hn = await addSource("HN");
    const seen = await addEvent(hn);
    const unseen = await addEvent(hn);
    const { snapshot, items } = await ensureFeedSnapshot({ db, profileId: 1 }, SLOT);
    const pos = items.find((i) => i.eventId === seen)?.position ?? 0;
    await recordImpressions(db, 1, [{ snapshotId: snapshot.id, position: pos }]);
    // The next day each event gets one more new article (new URL).
    await addDoc(seen, hn, 0.79, IN2);
    await addDoc(unseen, hn, 0.79, IN2);
    // Impressions are written at test run time (after SLOT2), so move them back to before the next day's slot.
    await db.update(feedImpressions).set({ seenAt: IN2 });
    const r = await rankPeriod(db, periodEndingAt(SLOT2), { profileId: 1 });
    const N = (id: number) => r.scored.find((s) => s.event.eventId === id)?.c.N;
    expect(N(seen)).toBe(0.75); // half of the URLs seen: 0,5 + 0,5 × 0,5
    expect(N(unseen)).toBe(1);
  });
});

describe("phản hồi từ web", () => {
  test("👍/👎 nối tới tin feed, bấm lại là bỏ chọn; tin của hồ sơ khác thì không ghi", async () => {
    const hn = await addSource("HN");
    for (let i = 0; i < 2; i++) await addEvent(hn);
    await db.insert(profile).values({ id: 2, promptContext: "y" });
    await db.insert(profileTopics).values({ profileId: 2, topicId: topic });
    const { items } = await ensureFeedSnapshot({ db, profileId: 1 }, SLOT);
    const { items: theirs } = await ensureFeedSnapshot({ db, profileId: 2 }, SLOT);
    const id = items[0]?.id ?? 0;
    expect(
      await recordFeedFeedback(db, { profileId: 1, feedItemId: id, kind: "like" }),
    ).toMatchObject({
      ok: true,
      state: "like",
    });
    expect(
      await recordFeedFeedback(db, { profileId: 1, feedItemId: id, kind: "like" }),
    ).toMatchObject({
      ok: true,
      state: "none",
    });
    expect(
      await recordFeedFeedback(db, { profileId: 1, feedItemId: theirs[0]?.id ?? 0, kind: "like" }),
    ).toEqual({ ok: false, reason: "not_found" });
    const rows = await db.select().from(feedback).orderBy(asc(feedback.id));
    expect(rows.map((r) => [r.profileId, r.feedItemId, r.kind, r.channel])).toEqual([
      [1, id, "like", "web"],
      [1, id, "clear", "web"],
    ]);
    // Composite foreign key: profile 1's feedback cannot point to profile 2's feed item.
    await expect(
      fails(
        db.insert(feedback).values({
          profileId: 1,
          feedItemId: theirs[0]?.id ?? 0,
          channel: "web",
          recipient: "x",
          kind: "like",
        }),
      ),
    ).rejects.toThrow();
  });

  test("tin đã gửi Telegram: phản hồi Telegram mang feed_item_id; phản hồi web mang delivery_id", async () => {
    const hn = await addSource("HN");
    await addEvent(hn);
    const notifier = fakeNotifier();
    await runDigest({ db, profileId: 1, llm: null, notifier, recipient: A }, SLOT);
    const [d] = await db.select().from(deliveries).where(eq(deliveries.kind, "event"));
    expect(d?.feedItemId).not.toBeNull();
    await recordFeedback(
      db,
      {
        channel: "telegram",
        recipient: A,
        messageId: d?.messageId ?? "",
        kind: "like",
        sourceId: "cb1",
      },
      1,
    );
    const web = await recordFeedFeedback(db, {
      profileId: 1,
      feedItemId: d?.feedItemId ?? 0,
      kind: "dislike",
    });
    expect(web).toMatchObject({ ok: true, state: "dislike" });
    const rows = await db.select().from(feedback).orderBy(asc(feedback.id));
    const did = d?.id ?? -1;
    const fid = d?.feedItemId ?? -1;
    expect(rows.map((r) => [r.channel, r.deliveryId, r.feedItemId, r.kind])).toEqual([
      ["telegram", did, fid, "like"],
      ["web", did, fid, "dislike"],
    ]);
  });
});

describe("migration 0026 trên dữ liệu có sẵn", () => {
  test("chạy trên DB đã có digest, tin gửi, phản hồi: dữ liệu giữ nguyên, cột mới NULL", async () => {
    const admin = createDatabase(TEST_URL.replace(/\/[^/]+$/, "/postgres"), { max: 1 });
    const name = `${TEST_URL.split("/").pop()}_mig26`;
    await admin.execute(sql.raw(`drop database if exists ${name}`));
    await admin.execute(sql.raw(`create database ${name}`));
    const url = TEST_URL.replace(/\/[^/]+$/, `/${name}`);
    const mdb = createDatabase(url, { max: 1 });
    try {
      await mdb.execute(sql`create extension if not exists vector`);
      await mdb.execute(sql`create extension if not exists pg_trgm`);
      const src = join(import.meta.dir, "../../../packages/db/drizzle");
      const old = await mkdtemp(join(tmpdir(), "mig-"));
      await cp(src, old, { recursive: true });
      const journalPath = join(old, "meta/_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
        entries: Array<{ tag: string }>;
      };
      journal.entries = journal.entries.filter((e) => Number(e.tag.slice(0, 4)) < 26);
      await writeFile(journalPath, JSON.stringify(journal));
      await migrate(mdb, { migrationsFolder: old });
      await mdb.execute(sql`insert into profile (id, prompt_context) values (1, 'x')`);
      await mdb.execute(sql`
        insert into digests (profile_id, channel, recipient, period_start, period_end, lang)
        values (1, 'telegram', '1', '2026-10-05', '2026-10-06', 'vi')`);
      await mdb.execute(sql`
        insert into deliveries (profile_id, digest_id, channel, recipient, message_id, kind, position, event_id, body)
        values (1, 1, 'telegram', '1', 'm1', 'event', 1, 7, 'b')`);
      await mdb.execute(sql`
        insert into feedback (profile_id, delivery_id, channel, recipient, kind)
        values (1, 1, 'telegram', '1', 'like')`);
      await runMigrations(url);
      const rows = await mdb.execute<{ d: number; dl: number; f: number }>(sql`
        select (select count(*) from digests where feed_snapshot_id is null)::int as d,
               (select count(*) from deliveries where feed_item_id is null)::int as dl,
               (select count(*) from feedback where feed_item_id is null)::int as f`);
      expect([...rows][0]).toEqual({ d: 1, dl: 1, f: 1 });
      const t = await mdb.execute<{ n: number }>(sql`
        select count(*)::int as n from information_schema.tables
        where table_name in ('feed_snapshots', 'feed_items', 'feed_impressions')`);
      expect([...t][0]?.n).toBe(3);
    } finally {
      await mdb.$bun.close();
      await admin.execute(sql.raw(`drop database if exists ${name}`));
      await admin.$bun.close();
    }
  });
});
