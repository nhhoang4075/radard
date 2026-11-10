/**
 * Ánh xạ người nhận → hồ sơ (`profile_channels`): tra fail-closed, seed idempotent, khoá duy nhất của
 * digest theo hồ sơ, digest và phản hồi của hai người dùng không lẫn nhau, migration trên dữ liệu có sẵn.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeNotifier } from "@radard/adapters/notify-fake";
import {
  baselines,
  candidatePool,
  createDatabase,
  deliveries,
  digests,
  docTopicScores,
  documents,
  enabledRecipients,
  eventDocuments,
  events,
  feedback,
  profile,
  profileChannels,
  profileOf,
  profileTopics,
  runMigrations,
  seedProfileChannel,
  sources,
} from "@radard/db";
import { asc, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { runDigestAll } from "../src/jobs/digest.ts";
import { chatResolver } from "../src/roles/bot.ts";
import { addTopic } from "./topic-fixture.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
/** Bọc câu truy vấn drizzle (thenable) thành Promise thật để `rejects` dùng được. */
const fails = (q: PromiseLike<unknown>) => Promise.resolve().then(() => q);
const A = "100000001";
const B = "100000002";
const SLOT = new Date("2026-10-06T00:00:00Z");
const IN = new Date("2026-10-05T12:00:00Z");

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  await db.execute(
    sql`truncate sources, events, profile, topics, documents, digests, profile_channels restart identity cascade`,
  );
  await db.insert(profile).values([
    { id: 1, promptContext: "I build AI agents.", displayLang: "vi" },
    { id: 2, promptContext: "I study robotics.", displayLang: "en" },
  ]);
});

afterAll(async () => {
  await db.$bun.close();
});

describe("profileOf / enabledRecipients", () => {
  test("người nhận có dòng thì ra hồ sơ; lạ, sai kênh hay đã tắt thì null", async () => {
    await db.insert(profileChannels).values([
      { profileId: 1, channel: "telegram", recipient: A },
      { profileId: 2, channel: "telegram", recipient: B, enabled: false },
      { profileId: 2, channel: "discord", recipient: "d-1" },
    ]);
    expect(await profileOf(db, "telegram", A)).toBe(1);
    expect(await profileOf(db, "telegram", B)).toBeNull();
    expect(await profileOf(db, "telegram", "999")).toBeNull();
    expect(await profileOf(db, "discord", A)).toBeNull();
    expect(await profileOf(db, "discord", "d-1")).toBe(2);
    expect(await enabledRecipients(db, "telegram")).toEqual([{ profileId: 1, recipient: A }]);
  });

  test("một người nhận chỉ thuộc một hồ sơ (khoá duy nhất)", async () => {
    await db.insert(profileChannels).values({ profileId: 1, channel: "telegram", recipient: A });
    await expect(
      fails(db.insert(profileChannels).values({ profileId: 2, channel: "telegram", recipient: A })),
    ).rejects.toThrow();
  });
});

describe("seedProfileChannel", () => {
  test("idempotent: chạy lại không thêm dòng, không đổi hồ sơ của dòng đã có", async () => {
    const o = { profileId: 1, channel: "telegram", recipient: A };
    expect(await seedProfileChannel(db, o)).toBe(true);
    expect(await seedProfileChannel(db, o)).toBe(false);
    expect(await seedProfileChannel(db, { ...o, profileId: 2 })).toBe(false);
    const rows = await db.select().from(profileChannels);
    expect(rows.map((r) => [r.profileId, r.channel, r.recipient, r.enabled])).toEqual([
      [1, "telegram", A, true],
    ]);
  });

  test("hồ sơ không tồn tại thì không seed", async () => {
    expect(await seedProfileChannel(db, { profileId: 99, channel: "telegram", recipient: A })).toBe(
      false,
    );
    expect(await db.select().from(profileChannels)).toHaveLength(0);
  });
});

describe("digests_once_uq theo hồ sơ", () => {
  const row = (profileId: number) => ({
    profileId,
    channel: "telegram",
    recipient: A,
    periodStart: new Date(SLOT.getTime() - 86_400_000),
    periodEnd: SLOT,
    lang: "vi",
  });

  test("hai hồ sơ cùng (channel, recipient, period_end) được; trùng trong cùng hồ sơ thì chặn", async () => {
    await db.insert(digests).values(row(1));
    await db.insert(digests).values(row(2));
    await expect(fails(db.insert(digests).values(row(1)))).rejects.toThrow();
    expect(await db.select().from(digests)).toHaveLength(2);
  });
});

describe("đa người dùng: digest và phản hồi", () => {
  let topic = 0;
  let seq = 0;
  let hn = 0;

  async function addEvent(): Promise<void> {
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
    await db.insert(docTopicScores).values({ documentId: d?.id ?? 0, topicId: topic, score: 0.79 });
  }

  beforeEach(async () => {
    seq = 0;
    const [s] = await db
      .insert(sources)
      .values({ kind: "hn", name: "HN", cadence: "*/15 * * * *", trustScore: 0.6 })
      .returning({ id: sources.id });
    hn = s?.id ?? 0;
    topic = await addTopic(db, "Agent AI", { embedText: "agents" });
    await db.insert(profileTopics).values({ profileId: 2, topicId: topic });
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
    for (let i = 0; i < 3; i++) await addEvent();
    await db.insert(profileChannels).values([
      { profileId: 1, channel: "telegram", recipient: A },
      { profileId: 2, channel: "telegram", recipient: B },
    ]);
  });

  test("runDigestAll gửi cho từng người nhận với hồ sơ riêng; digest, tin, bể ứng viên tách theo hồ sơ", async () => {
    const notifier = fakeNotifier();
    const out = await runDigestAll({ db, llm: null, notifier }, SLOT);
    expect(out).toHaveLength(2);
    const ds = await db.select().from(digests).orderBy(asc(digests.id));
    expect(ds.map((d) => [d.profileId, d.recipient, d.status])).toEqual([
      [1, A, "sent"],
      [2, B, "sent"],
    ]);
    // Mỗi tin gửi cho recipient nào thì ghi đúng hồ sơ của recipient đó.
    for (const d of await db.select().from(deliveries)) {
      expect(d.profileId).toBe(d.recipient === A ? 1 : 2);
    }
    expect(new Set(notifier.sent.map((s) => s.recipient))).toEqual(new Set([A, B]));
    for (const p of [1, 2]) {
      const pool = await db.select().from(candidatePool).where(eq(candidatePool.profileId, p));
      expect(pool.length).toBeGreaterThan(0);
    }
    // Chạy lại: không gửi trùng cho ai.
    const sentBefore = notifier.sent.length;
    await runDigestAll({ db, llm: null, notifier }, SLOT);
    expect(notifier.sent).toHaveLength(sentBefore);
  });

  test("chỉ người nhận đang bật nhận digest; kênh chưa có ai thì không gửi gì", async () => {
    await db
      .update(profileChannels)
      .set({ enabled: false })
      .where(eq(profileChannels.recipient, B));
    const notifier = fakeNotifier();
    await runDigestAll({ db, llm: null, notifier }, SLOT);
    expect(new Set(notifier.sent.map((s) => s.recipient))).toEqual(new Set([A]));
    await db.execute(sql`truncate profile_channels`);
    const quiet = fakeNotifier();
    expect(
      await runDigestAll({ db, llm: null, notifier: quiet }, new Date(SLOT.getTime() + 3_600_000)),
    ).toEqual([]);
    expect(quiet.sent).toHaveLength(0);
  });

  test("một người nhận lỗi không chặn người kia; lỗi ném sau khi xong hết", async () => {
    const notifier = fakeNotifier();
    const send = notifier.send.bind(notifier);
    notifier.send = async (recipient, msg) => {
      if (recipient === A) throw new Error("fake: A hỏng");
      return send(recipient, msg);
    };
    await expect(runDigestAll({ db, llm: null, notifier }, SLOT)).rejects.toThrow("A hỏng");
    expect(new Set(notifier.sent.map((s) => s.recipient))).toEqual(new Set([B]));
  });

  test("chatResolver: chat lạ bị từ chối; phản hồi của B ghi đúng hồ sơ B, không dính hồ sơ A", async () => {
    const base = { db, embedder: null, llm: null, decider: null };
    const resolve = chatResolver(base, "telegram", () => {});
    expect(await resolve("999")).toBeNull();
    const a = await resolve(A);
    const b = await resolve(B);
    expect(a?.scope).toBe("1");
    expect(b?.scope).toBe("2");
    // Hồ sơ trong bộ xử lý: chủ đề bật qua B chỉ hiện ở hồ sơ 2.
    await db.delete(profileTopics);
    const [item] = (await b?.handlers.topics?.list()) ?? [];
    expect(item).toBeUndefined(); // chưa seed thư viện: danh sách rỗng, không lẫn dữ liệu nơi khác
    const res = await b?.handlers.onFeedback({
      channel: "telegram",
      recipient: B,
      messageId: "404",
      kind: "dislike",
      sourceId: "cb:1",
    });
    expect(res?.recorded).toBe(true);
    const rows = await db.select().from(feedback);
    expect(rows.map((r) => [r.profileId, r.recipient])).toEqual([[2, B]]);
    // Người nhận bị tắt thì mất quyền ngay.
    await db
      .update(profileChannels)
      .set({ enabled: false })
      .where(eq(profileChannels.recipient, A));
    expect(await resolve(A)).toBeNull();
  });
});

describe("migration 0025 trên dữ liệu có sẵn", () => {
  test("chạy trên DB có digest từ trước: dữ liệu giữ nguyên, khoá mới áp dụng", async () => {
    const admin = createDatabase(TEST_URL.replace(/\/[^/]+$/, "/postgres"), { max: 1 });
    const name = `${TEST_URL.split("/").pop()}_mig`;
    await admin.execute(sql.raw(`drop database if exists ${name}`));
    await admin.execute(sql.raw(`create database ${name}`));
    const url = TEST_URL.replace(/\/[^/]+$/, `/${name}`);
    const mdb = createDatabase(url, { max: 1 });
    try {
      await mdb.execute(sql`create extension if not exists vector`);
      await mdb.execute(sql`create extension if not exists pg_trgm`);
      // Bản sao thư mục migration không có 0025 = DB ở trạng thái trước khi có bảng.
      const src = join(import.meta.dir, "../../../packages/db/drizzle");
      const old = await mkdtemp(join(tmpdir(), "mig-"));
      await cp(src, old, { recursive: true });
      const journalPath = join(old, "meta/_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
        entries: Array<{ tag: string }>;
      };
      journal.entries = journal.entries.filter((e) => !e.tag.startsWith("0025_"));
      await writeFile(journalPath, JSON.stringify(journal));
      await migrate(mdb, { migrationsFolder: old });
      await mdb.execute(sql`insert into profile (id, prompt_context) values (1, 'x')`);
      await mdb.execute(sql`
        insert into digests (profile_id, channel, recipient, period_start, period_end, lang)
        values (1, 'telegram', '100000001', '2026-10-05', '2026-10-06', 'vi')`);
      await runMigrations(url);
      const kept = await mdb.execute(sql`select count(*)::int as n from digests`);
      expect((kept as unknown as Array<{ n: number }>)[0]?.n).toBe(1);
      await mdb.execute(sql`insert into profile (id, prompt_context) values (2, 'y')`);
      const ins = (p: number) =>
        mdb.execute(sql`
          insert into digests (profile_id, channel, recipient, period_start, period_end, lang)
          values (${p}, 'telegram', '100000001', '2026-10-05', '2026-10-06', 'vi')`);
      await ins(2);
      await expect(fails(ins(1))).rejects.toThrow();
    } finally {
      await mdb.$bun.close();
      await admin.execute(sql.raw(`drop database if exists ${name}`));
      await admin.$bun.close();
    }
  });
});
