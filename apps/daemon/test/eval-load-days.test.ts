/**
 * Lớp đọc dữ liệu của bộ chấm bất biến trên DB thử (`TEST_DATABASE_URL`): nhãn mới nhất thắng,
 * `clear` thành "chưa bấm", nhãn gắn theo URL chuẩn, ngày theo giờ Việt Nam, bộ lọc người nhận.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createDatabase,
  deliveries,
  digests,
  documents,
  feedback,
  profile,
  runMigrations,
  sources,
} from "@radard/db";
import { sql } from "drizzle-orm";
import { loadDays, vnDay } from "../src/eval/load-days.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const ME = "100000001";
const OTHER = "100000002";
const H = 3_600_000;

let msg = 0;
let docSeq = 0;

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  await db.execute(
    sql`truncate profile, digests, deliveries, feedback, documents, sources restart identity cascade`,
  );
  await db.insert(profile).values({ promptContext: "x" });
  await db.insert(sources).values({ kind: "hn", name: "hn", cadence: "* * * * *" });
});

afterAll(async () => {
  await db.$bun.close();
});

async function addDoc(url: string): Promise<number> {
  const id = ++docSeq;
  const [d] = await db
    .insert(documents)
    .values({
      sourceId: 1,
      externalId: `e${id}`,
      url,
      urlCanonical: url,
      contentSha256: `s${id}`,
      rawKey: `r/${id}`,
      contentType: "application/json",
    })
    .returning({ id: documents.id });
  return d?.id ?? 0;
}

const score = (R: number) => ({ S: R, penalty: 0, R, P: 0.3, C: 0.2, A: 0.5, F: 1, N: 1 });

interface Item {
  url: string;
  R: number;
  /** Bỏ qua item này trong plan (plan cũ không có điểm). */
  noScore?: boolean;
}

/** Digest có các tin sự kiện ở vị trí 1…n (kèm tin mở đầu vị trí 0). Trả `deliveries.id` theo thứ tự. */
async function addDigest(
  periodEnd: string,
  items: Item[],
  recipient = ME,
  profileId = 1,
): Promise<{ digestId: number; ids: number[] }> {
  const end = new Date(periodEnd);
  const plan = {
    version: 1,
    items: items.flatMap((it, i) =>
      it.noScore ? [] : [{ position: i + 1, eventId: 100 + i, score: score(it.R) }],
    ),
  };
  const [dg] = await db
    .insert(digests)
    .values({
      profileId,
      channel: "telegram",
      recipient,
      periodStart: new Date(end.getTime() - 24 * H),
      periodEnd: end,
      status: "sent",
      lang: "vi",
      meta: { plan },
    })
    .returning({ id: digests.id });
  const digestId = dg?.id ?? 0;
  await db.insert(deliveries).values({
    profileId,
    digestId,
    channel: "telegram",
    recipient,
    messageId: String(++msg),
    kind: "header",
    position: 0,
    body: "mở đầu",
  });
  const ids: number[] = [];
  for (const [i, it] of items.entries()) {
    const docId = await addDoc(it.url);
    const [d] = await db
      .insert(deliveries)
      .values({
        profileId,
        digestId,
        channel: "telegram",
        recipient,
        messageId: String(++msg),
        kind: "event",
        position: i + 1,
        eventId: 100 + i,
        documentIds: [docId],
        body: "tin",
      })
      .returning({ id: deliveries.id });
    ids.push(d?.id ?? 0);
  }
  return { digestId, ids };
}

let clock = Date.parse("2026-10-01T00:00:00Z");
async function press(
  deliveryId: number,
  ...kinds: ("like" | "dislike" | "clear" | "comment")[]
): Promise<void> {
  for (const kind of kinds) {
    // created_at tăng dần để thứ tự không phụ thuộc đồng hồ máy
    clock += 60_000;
    await db.insert(feedback).values({
      profileId: 1,
      deliveryId,
      channel: "telegram",
      recipient: ME,
      kind,
      text: kind === "comment" ? "hay" : null,
      createdAt: new Date(clock),
    });
  }
}

describe("loadDays", () => {
  test("nhãn mới nhất thắng: like→clear = chưa bấm, like→dislike = 👎, comment bị bỏ qua", async () => {
    const { ids } = await addDigest("2026-10-20T00:00:00Z", [
      { url: "https://a.com/1", R: 0.9 },
      { url: "https://a.com/2", R: 0.8 },
      { url: "https://a.com/3", R: 0.7 },
      { url: "https://a.com/4", R: 0.6 },
      { url: "https://a.com/5", R: 0.5 },
      { url: "https://a.com/6", R: 0.4 },
    ]);
    await press(ids[0] as number, "like");
    await press(ids[1] as number, "like", "clear");
    await press(ids[2] as number, "like", "dislike");
    await press(ids[3] as number, "dislike", "like", "dislike", "like");
    await press(ids[4] as number, "comment"); // chỉ có nhận xét: chưa bấm
    await press(ids[5] as number, "dislike", "comment"); // nhận xét sau không làm mất 👎

    const { days, skipped } = await loadDays(db);
    expect(skipped).toBe(0);
    expect(days).toHaveLength(1);
    const day = days[0];
    expect(day?.date).toBe("2026-10-20");
    expect(day?.samples.map((s) => [s.position, s.level])).toEqual([
      [1, "like"],
      [2, "none"],
      [3, "dislike"],
      [4, "like"],
      [5, "none"],
      [6, "dislike"],
    ]);
    expect(day?.samples[0]).toMatchObject({
      urls: ["https://a.com/1"],
      score: { S: 0.9, R: 0.9, N: 1 },
    });
  });

  test("chỉ lấy tin sự kiện: bỏ header và tin thử; item không có điểm trong plan thì bỏ qua", async () => {
    await db.insert(deliveries).values({
      profileId: 1,
      channel: "telegram",
      recipient: ME,
      messageId: String(++msg),
      kind: "test",
      body: "thử",
    });
    await addDigest("2026-10-20T00:00:00Z", [
      { url: "https://a.com/1", R: 0.9 },
      { url: "https://a.com/2", R: 0.8, noScore: true },
    ]);
    const { days, skipped } = await loadDays(db);
    expect(skipped).toBe(1);
    expect(days[0]?.samples).toHaveLength(1);
  });

  test("ngày theo giờ Việt Nam: 20:00 UTC ngày 20 đã là ngày 21 ở VN", async () => {
    expect(vnDay(new Date("2026-10-20T16:59:59Z"))).toBe("2026-10-20");
    expect(vnDay(new Date("2026-10-20T17:00:00Z"))).toBe("2026-10-21");
    await addDigest("2026-10-20T00:00:00Z", [{ url: "https://a.com/1", R: 0.9 }]);
    await addDigest("2026-10-20T20:00:00Z", [{ url: "https://a.com/2", R: 0.9 }]);
    const { days } = await loadDays(db);
    expect(days.map((d) => d.date)).toEqual(["2026-10-20", "2026-10-21"]);
  });

  test("nhãn gắn theo URL chuẩn của tài liệu, sự kiện nhiều tài liệu có nhiều URL", async () => {
    const { ids } = await addDigest("2026-10-20T00:00:00Z", [{ url: "https://a.com/1", R: 0.9 }]);
    const extra = await addDoc("https://b.com/dup");
    await db
      .update(deliveries)
      .set({ documentIds: sql`array_cat(document_ids, ARRAY[${extra}]::bigint[])` })
      .where(sql`id = ${ids[0] as number}`);
    const { days } = await loadDays(db);
    expect(days[0]?.samples[0]?.urls).toEqual(["https://a.com/1", "https://b.com/dup"]);
  });

  test("bộ lọc người nhận; không lọc thì lấy tất cả", async () => {
    await addDigest("2026-10-20T00:00:00Z", [{ url: "https://a.com/1", R: 0.9 }], ME);
    await addDigest("2026-10-21T00:00:00Z", [{ url: "https://a.com/2", R: 0.9 }], OTHER);
    expect((await loadDays(db)).days).toHaveLength(2);
    const mine = await loadDays(db, { recipient: ME });
    expect(mine.days.map((d) => d.date)).toEqual(["2026-10-20"]);
    expect((await loadDays(db, { channel: "discord" })).days).toHaveLength(0);
  });

  test("bộ lọc profileId: chỉ lấy tin của hồ sơ đó, kể cả khi cùng người nhận", async () => {
    await db.insert(profile).values({ id: 2, promptContext: "y" });
    await addDigest("2026-10-20T00:00:00Z", [{ url: "https://a.com/1", R: 0.9 }], ME, 1);
    await addDigest("2026-10-21T00:00:00Z", [{ url: "https://a.com/2", R: 0.9 }], ME, 2);
    expect((await loadDays(db)).days).toHaveLength(2);
    const one = await loadDays(db, { profileId: 1 });
    expect(one.days.map((d) => d.date)).toEqual(["2026-10-20"]);
    const two = await loadDays(db, { profileId: 2 });
    expect(two.days.map((d) => d.date)).toEqual(["2026-10-21"]);
    expect((await loadDays(db, { profileId: 3 })).days).toHaveLength(0);
  });

  test("DB trống: không có ngày nào", async () => {
    expect(await loadDays(db)).toEqual({ days: [], skipped: 0 });
  });
});
