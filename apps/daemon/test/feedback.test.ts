/** Ghi lượt bấm vào `feedback` trên `radard_test`. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, deliveries, feedback, runMigrations } from "@radard/db";
import { asc, sql } from "drizzle-orm";
import { recordFeedback } from "../src/jobs/feedback.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const ME = "100000001";
const ev = (kind: "like" | "dislike", sourceId: string, messageId = "58") => ({
  channel: "telegram",
  recipient: ME,
  messageId,
  kind,
  sourceId,
});

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  await db.execute(sql`truncate digests, deliveries, feedback restart identity cascade`);
  await db.insert(deliveries).values({
    channel: "telegram",
    recipient: ME,
    messageId: "58",
    kind: "event",
    body: "tin",
    documentIds: [1, 2],
  });
});

afterAll(async () => {
  await db.$bun.close();
});

describe("recordFeedback", () => {
  test("nối về đúng delivery theo message_id; 👍 rồi 👎 là hai dòng", async () => {
    expect(await recordFeedback(db, ev("like", "cb:1"))).toEqual({ recorded: true, deliveryId: 1 });
    await recordFeedback(db, ev("dislike", "cb:2"));
    const rows = await db.select().from(feedback).orderBy(asc(feedback.id));
    expect(rows.map((r) => [r.kind, r.deliveryId])).toEqual([
      ["like", 1],
      ["dislike", 1],
    ]);
  });

  test("cùng lượt bấm giao lại (bot khởi động lại) chỉ ghi một dòng", async () => {
    await recordFeedback(db, ev("like", "cb:1"));
    expect((await recordFeedback(db, ev("like", "cb:1"))).recorded).toBe(false);
    expect(await db.select().from(feedback)).toHaveLength(1);
  });

  test("bấm lại đúng nút vừa bấm không ghi thêm; đổi ý thì ghi, dòng mới nhất là ý kiến hiện tại", async () => {
    await recordFeedback(db, ev("like", "cb:1"));
    expect(await recordFeedback(db, ev("like", "cb:2"))).toEqual({
      recorded: false,
      deliveryId: 1,
      reason: "unchanged",
    });
    await recordFeedback(db, ev("dislike", "cb:3"));
    await recordFeedback(db, ev("like", "cb:4"));
    // Lượt bấm cũ bị giao lại sau khi đã đổi ý: vẫn chỉ là lượt cũ.
    expect((await recordFeedback(db, ev("dislike", "cb:3"))).reason).toBe("replayed");
    const rows = await db.select().from(feedback).orderBy(asc(feedback.id));
    expect(rows.map((r) => r.kind)).toEqual(["like", "dislike", "like"]);
  });

  test("tin không có trong deliveries: vẫn giữ phản hồi, delivery_id trống", async () => {
    expect(await recordFeedback(db, ev("like", "cb:9", "777"))).toEqual({
      recorded: true,
      deliveryId: null,
    });
  });
});
