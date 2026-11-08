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
    kind: "test",
    body: "tin",
    documentIds: [1, 2],
  });
});

afterAll(async () => {
  await db.$bun.close();
});

describe("recordFeedback", () => {
  test("nối về đúng delivery theo message_id; 👍 rồi 👎 là hai dòng", async () => {
    expect(await recordFeedback(db, ev("like", "cb:1"))).toEqual({
      recorded: true,
      deliveryId: 1,
      state: "like",
    });
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

  // Lùi thời điểm mọi dòng phản hồi để lượt bấm kế tiếp không bị coi là bấm đúp.
  const ageRows = () =>
    db.execute(sql`update feedback set created_at = created_at - interval '1 minute'`);

  test("bấm đúp trong 2 giây không ghi thêm và không bỏ chọn", async () => {
    await recordFeedback(db, ev("like", "cb:1"));
    expect(await recordFeedback(db, ev("like", "cb:2"))).toEqual({
      recorded: false,
      deliveryId: 1,
      state: "like",
      reason: "unchanged",
    });
    expect(await db.select().from(feedback)).toHaveLength(1);
  });

  test("bấm lại đúng nút đang chọn (sau 2 giây) ghi 'clear'; bấm tiếp thì chọn lại", async () => {
    await recordFeedback(db, ev("like", "cb:1"));
    await ageRows();
    expect(await recordFeedback(db, ev("like", "cb:2"))).toEqual({
      recorded: true,
      deliveryId: 1,
      state: "none",
    });
    await ageRows();
    // Đã bỏ chọn thì bấm 👍 là chọn lại, không phải bỏ chọn lần nữa.
    expect((await recordFeedback(db, ev("like", "cb:3"))).state).toBe("like");
    const rows = await db.select().from(feedback).orderBy(asc(feedback.id));
    expect(rows.map((r) => r.kind)).toEqual(["like", "clear", "like"]);
  });

  test("đổi ý ghi dòng mới; lượt bấm cũ bị giao lại vẫn chỉ là lượt cũ", async () => {
    await recordFeedback(db, ev("like", "cb:1"));
    await recordFeedback(db, ev("dislike", "cb:3"));
    await ageRows();
    await recordFeedback(db, ev("like", "cb:4"));
    expect((await recordFeedback(db, ev("dislike", "cb:3"))).reason).toBe("replayed");
    const rows = await db.select().from(feedback).orderBy(asc(feedback.id));
    expect(rows.map((r) => r.kind)).toEqual(["like", "dislike", "like"]);
  });

  test("tin không có trong deliveries: vẫn giữ phản hồi, delivery_id trống", async () => {
    expect(await recordFeedback(db, ev("like", "cb:9", "777"))).toEqual({
      recorded: true,
      deliveryId: null,
      state: "like",
    });
  });
});
