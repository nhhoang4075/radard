/**
 * Bảng gửi tin và phản hồi: dữ liệu của người dùng phải sống sót khi dữ liệu dẫn xuất bị dựng lại, và
 * các ràng buộc chặn dữ liệu sai ngay ở DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createDatabase,
  deliveries,
  digests,
  documents,
  eventDocuments,
  events,
  feedback,
  runMigrations,
  sources,
} from "@radard/db";
import { eq, sql } from "drizzle-orm";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const recipient = "100000001";
let deliveryId = 0;
/** Lệnh của Drizzle chỉ "giống promise"; bọc lại để `expect(...).rejects` dùng được. */
const attempt = (q: PromiseLike<unknown>) => Promise.resolve(q);
let docId = 0;

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  await db.execute(sql`truncate sources, events, digests, feedback restart identity cascade`);
  const [s] = await db
    .insert(sources)
    .values({ kind: "hn", name: "HN giả", cadence: "*/15 * * * *" })
    .returning({ id: sources.id });
  const [d] = await db
    .insert(documents)
    .values({
      sourceId: s?.id ?? 0,
      externalId: "1",
      url: "https://a.com/x",
      urlCanonical: "https://a.com/x",
      title: "Bài 1",
      contentSha256: "0".repeat(64),
      rawKey: "raw/00/x.gz",
      contentType: "application/json",
    })
    .returning({ id: documents.id });
  docId = d?.id ?? 0;
  const [ev] = await db
    .insert(events)
    .values({
      title: "Sự kiện",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      centroid: Array.from({ length: 1024 }, () => 0.01),
      embeddingModel: "m",
    })
    .returning({ id: events.id });
  await db
    .insert(eventDocuments)
    .values({ eventId: ev?.id ?? 0, documentId: docId, similarity: 1, reason: "seed" });
  const [dg] = await db
    .insert(digests)
    .values({
      channel: "telegram",
      recipient,
      periodStart: new Date("2026-10-11T00:00:00Z"),
      periodEnd: new Date("2026-10-12T00:00:00Z"),
      lang: "vi",
    })
    .returning({ id: digests.id });
  const [dl] = await db
    .insert(deliveries)
    .values({
      digestId: dg?.id,
      channel: "telegram",
      recipient,
      messageId: "42",
      kind: "event",
      position: 1,
      eventId: ev?.id,
      documentIds: [docId],
      title: "Sự kiện",
      body: "Tóm tắt…",
    })
    .returning({ id: deliveries.id });
  deliveryId = dl?.id ?? 0;
});

afterAll(async () => {
  await db.$bun.close();
});

describe("deliveries + feedback", () => {
  test("phản hồi và ảnh chụp document_ids sống sót khi dữ liệu dẫn xuất bị xoá (reprocess --all)", async () => {
    await db.insert(feedback).values([
      { deliveryId, channel: "telegram", recipient, kind: "like" },
      {
        deliveryId,
        channel: "telegram",
        recipient,
        kind: "comment",
        text: "Hay, muốn thêm bài kiểu này",
        sourceMessageId: "43",
      },
    ]);
    await db.execute(sql`truncate ${eventDocuments}, ${events}`);

    const rows = await db.select().from(feedback).where(eq(feedback.deliveryId, deliveryId));
    expect(rows.map((r) => r.kind).sort()).toEqual(["comment", "like"]);
    const [dl] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
    expect(dl?.documentIds).toEqual([docId]);
  });

  test("góp ý chung không gắn tin nào", async () => {
    await db.insert(feedback).values({
      channel: "telegram",
      recipient,
      kind: "comment",
      text: "ít tin crypto thôi",
      sourceMessageId: "50",
    });
    const [r] = await db.select().from(feedback);
    expect(r?.deliveryId).toBeNull();
  });

  test("ràng buộc: nhận xét phải có chữ, like không kèm chữ, không ghi trùng tin của người dùng", async () => {
    await expect(
      attempt(
        db.insert(feedback).values({ deliveryId, channel: "telegram", recipient, kind: "comment" }),
      ),
    ).rejects.toThrow();
    await expect(
      attempt(
        db
          .insert(feedback)
          .values({ deliveryId, channel: "telegram", recipient, kind: "comment", text: "" }),
      ),
    ).rejects.toThrow();
    await expect(
      attempt(
        db
          .insert(feedback)
          .values({ deliveryId, channel: "telegram", recipient, kind: "like", text: "x" }),
      ),
    ).rejects.toThrow();
    await expect(
      attempt(
        db.insert(feedback).values({ deliveryId, channel: "telegram", recipient, kind: "love" }),
      ),
    ).rejects.toThrow();
    const c = {
      deliveryId,
      channel: "telegram",
      recipient,
      kind: "comment",
      text: "a",
      sourceMessageId: "60",
    };
    await db.insert(feedback).values(c);
    await expect(attempt(db.insert(feedback).values(c))).rejects.toThrow();
  });

  test("ràng buộc: tin sự kiện phải thuộc digest và sự kiện; tin thử đứng ngoài digest", async () => {
    const base = { channel: "telegram", recipient, body: "x" };
    const [dg] = await db.select({ id: digests.id }).from(digests);
    // Tin sự kiện không có digest (kiểu notify test cũ) hoặc không có event_id: bị chặn.
    await expect(
      attempt(db.insert(deliveries).values({ ...base, messageId: "70", kind: "event" })),
    ).rejects.toThrow();
    await expect(
      attempt(
        db
          .insert(deliveries)
          .values({ ...base, messageId: "71", kind: "event", digestId: dg?.id, position: 2 }),
      ),
    ).rejects.toThrow();
    // Tin thử nằm trong digest: bị chặn. Tin thử đứng riêng: ghi được.
    await expect(
      attempt(
        db
          .insert(deliveries)
          .values({ ...base, messageId: "72", kind: "test", digestId: dg?.id, position: 3 }),
      ),
    ).rejects.toThrow();
    await db.insert(deliveries).values({ ...base, messageId: "73", kind: "test" });
  });

  test("một khoảng thời gian chỉ một digest cho một người nhận", async () => {
    await expect(
      attempt(
        db.insert(digests).values({
          channel: "telegram",
          recipient,
          periodStart: new Date("2026-10-11T00:00:00Z"),
          periodEnd: new Date("2026-10-12T00:00:00Z"),
          lang: "vi",
        }),
      ),
    ).rejects.toThrow();
  });

  test("bấm nhiều lần là nhiều dòng; dòng mới nhất là ý kiến hiện tại", async () => {
    await db.insert(feedback).values({ deliveryId, channel: "telegram", recipient, kind: "like" });
    await db
      .insert(feedback)
      .values({ deliveryId, channel: "telegram", recipient, kind: "dislike" });
    const [latest] = await db.execute(
      sql`select kind from feedback where delivery_id = ${deliveryId} and kind in ('like','dislike') order by id desc limit 1`,
    );
    expect((latest as { kind: string }).kind).toBe("dislike");
  });
});
