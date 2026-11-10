/**
 * Điểm gu U nối vào xếp hạng: gom cụm từ tin 👍 (nhãn mới nhất), lưu cụm và mượn tên hôm sau, ghi U
 * vào bể ứng viên. Giá trị kỳ vọng tính tay từ spec: τ = 1,4; ≥ 3 tin mới `active`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_RANK_CONFIG } from "@radard/core";
import {
  baselines,
  candidatePool,
  createDatabase,
  deliveries,
  digests,
  docText,
  docTopicScores,
  documents,
  eventDocuments,
  events,
  feedback,
  interestClusters,
  profile,
  runMigrations,
  sources,
} from "@radard/db";
import { sql } from "drizzle-orm";
import { recordCandidatePool } from "../src/jobs/candidate-pool.ts";
import { computeInterestClusters, loadLikedItems } from "../src/jobs/interest.ts";
import { periodEndingAt, rankPeriod } from "../src/jobs/rank.ts";
import { addTopic } from "./topic-fixture.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const END = new Date("2026-10-06T02:00:00Z");
const IN = new Date("2026-10-05T12:00:00Z");
const LIKE_AT = new Date("2026-10-04T00:00:00Z");
const CFG = DEFAULT_RANK_CONFIG.interest;
let hn = 0;
let topic = 0;
let seq = 0;
let msg = 0;
let digestId = 0;

/** Vector đơn vị trên trục `axis`. */
const axis = (i: number) => {
  const v = new Array<number>(1024).fill(0);
  v[i] = 1;
  return v;
};

async function addDoc(vec: number[], inWindow: boolean): Promise<number> {
  const id = ++seq;
  const [d] = await db
    .insert(documents)
    .values({
      sourceId: hn,
      externalId: String(id),
      url: `https://x.com/${id}`,
      urlCanonical: `https://x.com/${id}`,
      title: `doc ${id}`,
      publishedAt: inWindow ? IN : new Date("2026-09-01T00:00:00Z"),
      contentSha256: `s${id}`,
      rawKey: `r/${id}`,
      contentType: "application/json",
    })
    .returning({ id: documents.id });
  const docId = d?.id ?? 0;
  await db.insert(docText).values({
    documentId: docId,
    text: `doc ${id}`,
    lang: "eng",
    embedding: vec,
    embeddingModel: "m",
  });
  return docId;
}

/** Sự kiện một tài liệu trong khoảng xếp hạng, vector tài liệu trên trục `ax`, R rất cao. */
async function addEvent(ax: number): Promise<number> {
  const docId = await addDoc(axis(ax), true);
  const [e] = await db
    .insert(events)
    .values({
      title: `event ${docId}`,
      firstSeenAt: IN,
      lastSeenAt: IN,
      centroid: axis(ax),
      embeddingModel: "m",
    })
    .returning({ id: events.id });
  await db
    .insert(eventDocuments)
    .values({ eventId: e?.id ?? 0, documentId: docId, similarity: 1, reason: "seed" });
  await db.insert(docTopicScores).values({ documentId: docId, topicId: topic, score: 0.79 });
  return e?.id ?? 0;
}

/** Tin đã gửi cho tài liệu có vector trên trục `ax`; trả về delivery id. */
async function addDelivery(ax: number): Promise<number> {
  const docId = await addDoc(axis(ax), false);
  const n = ++msg;
  const [d] = await db
    .insert(deliveries)
    .values({
      profileId: 1,
      digestId,
      channel: "telegram",
      recipient: "r",
      messageId: String(n),
      kind: "event",
      position: n,
      eventId: 900_000 + n,
      documentIds: [docId],
      body: "tin",
    })
    .returning({ id: deliveries.id });
  return d?.id ?? 0;
}

let fbAt = 0;
async function react(deliveryId: number, kind: "like" | "dislike" | "clear", at = LIKE_AT) {
  await db.insert(feedback).values({
    profileId: 1,
    deliveryId,
    channel: "telegram",
    recipient: "r",
    kind,
    createdAt: new Date(at.getTime() + ++fbAt * 1000),
  });
}

/** `n` tin 👍 cùng trục `ax`. */
async function like(ax: number, n: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = await addDelivery(ax);
    await react(id, "like");
    ids.push(id);
  }
  return ids;
}

const rank = () =>
  rankPeriod(db, periodEndingAt(END), { profileId: 1, config: { floorMode: "fixed", floorS: 0 } });

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  seq = 0;
  msg = 0;
  fbAt = 0;
  await db.execute(
    sql`truncate sources, events, profile, topics, documents, digests, candidate_pool, interest_clusters restart identity cascade`,
  );
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
  const [dg] = await db
    .insert(digests)
    .values({
      profileId: 1,
      channel: "telegram",
      recipient: "r",
      periodStart: new Date("2026-10-03T00:00:00Z"),
      periodEnd: new Date("2026-10-04T00:00:00Z"),
      status: "sent",
      lang: "vi",
    })
    .returning({ id: digests.id });
  digestId = dg?.id ?? 0;
});

afterAll(async () => {
  await db.$bun.close();
});

describe("điểm gu U", () => {
  test("chưa có 👍: U = 0 ở mọi tin, S vẫn theo công thức mới, bể ghi u = 0", async () => {
    await addEvent(0);
    const r = await rank();
    expect(r.picked).toHaveLength(1);
    const p = r.picked[0];
    expect(p?.c.U).toBe(0);
    const w = DEFAULT_RANK_CONFIG.weights;
    const c = p?.c;
    if (!c) throw new Error("không có tin");
    expect(p?.S).toBeCloseTo(c.N * (w.R * c.R + w.P * c.P + w.C * c.C + w.A * c.A + w.F * c.F), 12);
    await recordCandidatePool(db, 1, r);
    const [row] = await db.select().from(candidatePool);
    expect(row?.u).toBe(0);
  });

  test("2 👍 không tạo cụm active (chờ), U = 0; cụm chờ vẫn được lưu", async () => {
    await like(0, 2);
    await addEvent(0);
    const r = await rank();
    expect(r.picked[0]?.c.U).toBe(0);
    expect(r.interestClusters.map((c) => c.status)).toEqual(["pending"]);
    const stored = await db.select().from(interestClusters);
    expect(stored.map((x) => x.status)).toEqual(["pending"]);
  });

  test("3 👍 cùng một hướng: cụm active, tin cùng hướng U = 1, tin trực giao U = 0; U vào S, bể", async () => {
    await like(0, 3);
    const same = await addEvent(0);
    const other = await addEvent(1);
    const r = await rank();
    const byId = new Map(r.picked.map((p) => [p.event.eventId, p]));
    const a = byId.get(same);
    const b = byId.get(other);
    expect(a?.c.U).toBeCloseTo(1, 6);
    expect(b?.c.U).toBeCloseTo(0, 6);
    // Hai tin giống hệt thành phần khác; S chênh đúng w_U · ΔU.
    expect((a?.S ?? 0) - (b?.S ?? 0)).toBeCloseTo(DEFAULT_RANK_CONFIG.weights.U * 1, 6);
    await recordCandidatePool(db, 1, r);
    const rows = await db.select().from(candidatePool);
    expect(rows.find((x) => x.eventId === same)?.u).toBeCloseTo(1, 6);
    expect(rows.find((x) => x.eventId === other)?.u).toBeCloseTo(0, 6);
  });

  test("nhãn mới nhất: 'clear' sau 'like' thì tin không vào cụm; 'like' sau 'clear' thì vào; 👎 không tính", async () => {
    const ids = await like(0, 3);
    await react(ids[0] as number, "clear"); // còn 2 👍
    const items = await loadLikedItems(db, 1, END);
    expect(items.map((i) => i.id).sort()).toEqual([`d${ids[1]}`, `d${ids[2]}`].sort());
    const dis = await addDelivery(0);
    await react(dis, "dislike");
    expect(await loadLikedItems(db, 1, END)).toHaveLength(2);
    // Chưa đủ 3 tin 👍 nên chưa active.
    const none = await computeInterestClusters(db, 1, END, CFG, { persist: false });
    expect(none.filter((c) => c.status === "active")).toHaveLength(0);
    // Bấm lại 👍 sau 'clear': tin trở lại, thành 3 → active.
    await react(ids[0] as number, "like");
    const back = await computeInterestClusters(db, 1, END, CFG, { persist: false });
    expect(back.filter((c) => c.status === "active")).toHaveLength(1);
  });

  test("phản hồi sau mốc xếp hạng không tính; tuổi tính từ mốc", async () => {
    const id = await addDelivery(0);
    await react(id, "like", new Date(END.getTime() + 3_600_000));
    expect(await loadLikedItems(db, 1, END)).toHaveLength(0);
    const id2 = await addDelivery(0);
    await react(id2, "like", new Date(END.getTime() - 10 * 86_400_000));
    const [it] = await loadLikedItems(db, 1, END);
    expect(it?.ageDays).toBeCloseTo(10, 3);
  });

  test("τ = 1,4 được truyền xuống: hai nhóm trực giao (khoảng cách √2 > 1,4) ra 2 cụm; τ lớn thì gộp", async () => {
    expect(CFG.distanceThreshold).toBe(1.4);
    await like(0, 3);
    await like(1, 3);
    const two = await computeInterestClusters(db, 1, END, CFG, { persist: false });
    expect(two.filter((c) => c.status === "active")).toHaveLength(2);
    const one = await computeInterestClusters(
      db,
      1,
      END,
      { ...CFG, distanceThreshold: 10 },
      { persist: false },
    );
    expect(one).toHaveLength(1);
  });

  test("cụm được lưu; hôm sau cụm mới mượn tên cụm hôm qua có tâm gần nhất; bộ cụm được thay, không dồn", async () => {
    await like(0, 3);
    await computeInterestClusters(db, 1, END, CFG, { persist: true });
    const first = await db.select().from(interestClusters);
    expect(first).toHaveLength(1);
    expect(first[0]?.profileId).toBe(1);
    expect(first[0]?.name).toBeNull();
    await db.update(interestClusters).set({ name: "Agent AI" });
    // Hôm sau có thêm 3 👍 trên trục khác và 1 trên trục cũ.
    await like(5, 3);
    await like(0, 1);
    const next = await computeInterestClusters(db, 1, new Date(END.getTime() + 86_400_000), CFG, {
      persist: true,
    });
    const named = next.filter((c) => c.name !== null);
    expect(named.map((c) => c.name)).toEqual(["Agent AI"]);
    expect(named[0]?.memberIds).toHaveLength(4);
    const stored = await db.select().from(interestClusters);
    expect(stored).toHaveLength(2);
    expect(stored.filter((x) => x.name === "Agent AI")).toHaveLength(1);
  });

  test("persistInterests = false không ghi đè cụm đã lưu", async () => {
    await like(0, 3);
    await addEvent(0);
    await rankPeriod(db, periodEndingAt(END), {
      profileId: 1,
      persistInterests: false,
      config: { floorMode: "fixed", floorS: 0 },
    });
    expect(await db.select().from(interestClusters)).toHaveLength(0);
    await rank();
    expect(await db.select().from(interestClusters)).toHaveLength(1);
  });
});
