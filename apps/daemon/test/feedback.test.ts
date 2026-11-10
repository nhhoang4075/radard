/** Ghi lượt bấm vào `feedback` trên `radard_test`. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, deliveries, feedback, profile, runMigrations } from "@radard/db";
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
  await db.execute(sql`truncate profile, digests, deliveries, feedback restart identity cascade`);
  await db.insert(profile).values({ promptContext: "x" });
  await db.insert(deliveries).values({
    profileId: 1,
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
    expect(await recordFeedback(db, ev("like", "cb:1"), 1)).toEqual({
      recorded: true,
      deliveryId: 1,
      state: "like",
    });
    await recordFeedback(db, ev("dislike", "cb:2"), 1);
    const rows = await db.select().from(feedback).orderBy(asc(feedback.id));
    expect(rows.map((r) => [r.kind, r.deliveryId])).toEqual([
      ["like", 1],
      ["dislike", 1],
    ]);
  });

  test("cùng lượt bấm giao lại (bot khởi động lại) chỉ ghi một dòng", async () => {
    await recordFeedback(db, ev("like", "cb:1"), 1);
    expect((await recordFeedback(db, ev("like", "cb:1"), 1)).recorded).toBe(false);
    expect(await db.select().from(feedback)).toHaveLength(1);
  });

  // Lùi thời điểm mọi dòng phản hồi để lượt bấm kế tiếp không bị coi là bấm đúp.
  const ageRows = () =>
    db.execute(sql`update feedback set created_at = created_at - interval '1 minute'`);

  test("bấm đúp trong 2 giây không ghi thêm và không bỏ chọn", async () => {
    await recordFeedback(db, ev("like", "cb:1"), 1);
    expect(await recordFeedback(db, ev("like", "cb:2"), 1)).toEqual({
      recorded: false,
      deliveryId: 1,
      state: "like",
      reason: "unchanged",
    });
    expect(await db.select().from(feedback)).toHaveLength(1);
  });

  test("bấm lại đúng nút đang chọn (sau 2 giây) ghi 'clear'; bấm tiếp thì chọn lại", async () => {
    await recordFeedback(db, ev("like", "cb:1"), 1);
    await ageRows();
    expect(await recordFeedback(db, ev("like", "cb:2"), 1)).toEqual({
      recorded: true,
      deliveryId: 1,
      state: "none",
    });
    await ageRows();
    // Đã bỏ chọn thì bấm 👍 là chọn lại, không phải bỏ chọn lần nữa.
    expect((await recordFeedback(db, ev("like", "cb:3"), 1)).state).toBe("like");
    const rows = await db.select().from(feedback).orderBy(asc(feedback.id));
    expect(rows.map((r) => r.kind)).toEqual(["like", "clear", "like"]);
  });

  test("đổi ý ghi dòng mới; lượt bấm cũ bị giao lại vẫn chỉ là lượt cũ", async () => {
    await recordFeedback(db, ev("like", "cb:1"), 1);
    await recordFeedback(db, ev("dislike", "cb:3"), 1);
    await ageRows();
    await recordFeedback(db, ev("like", "cb:4"), 1);
    expect((await recordFeedback(db, ev("dislike", "cb:3"), 1)).reason).toBe("replayed");
    const rows = await db.select().from(feedback).orderBy(asc(feedback.id));
    expect(rows.map((r) => r.kind)).toEqual(["like", "dislike", "like"]);
  });

  test("tin không có trong deliveries: vẫn giữ phản hồi, delivery_id trống", async () => {
    expect(await recordFeedback(db, ev("like", "cb:9", "777"), 1)).toEqual({
      recorded: true,
      deliveryId: null,
      state: "like",
    });
  });

  test("phản hồi mang profile_id của tin; tin lạ thì dùng hồ sơ được truyền", async () => {
    await db.insert(profile).values({ id: 2, promptContext: "y" });
    await db.update(deliveries).set({ profileId: 2 });
    // Người nối dây truyền 1, nhưng tin thuộc hồ sơ 2: phản hồi theo tin.
    await recordFeedback(db, ev("like", "cb:1"), 1);
    await recordFeedback(db, ev("like", "cb:9", "777"), 1);
    const rows = await db.select().from(feedback).orderBy(asc(feedback.id));
    expect(rows.map((r) => [r.deliveryId, r.profileId])).toEqual([
      [1, 2],
      [null, 1],
    ]);
  });
});
