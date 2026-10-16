/** Phía lõi của lệnh chọn chủ đề (`topicHandlers`) trên `radard_test`. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, profile, runMigrations } from "@radard/db";
import { sql } from "drizzle-orm";
import { addCustomTopic, seedLibrary } from "../src/jobs/topics.ts";
import { topicHandlers } from "../src/roles/bot.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const h = topicHandlers({ db, embedder: null, llm: null });

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  await db.execute(sql`truncate profile, topics restart identity cascade`);
  await db.insert(profile).values({ description: "x" });
  await seedLibrary(db);
});

afterAll(async () => {
  await db.$bun.close();
});

describe("topicHandlers", () => {
  test("danh sách = thư viện (theo thứ tự) + chủ đề tự thêm; bật tắt cả hai loại", async () => {
    await addCustomTopic(db, {
      label: "Postgres cho AI",
      descriptionUser: "pgvector",
      descriptionEn: "pgvector",
    });
    const before = await h.list();
    expect(before[0]).toMatchObject({
      key: "l:1",
      label: "Model AI: phát hành và hành vi",
      chosen: false,
    });
    const custom = before.at(-1);
    expect(custom).toMatchObject({ label: "Postgres cho AI", chosen: true });
    expect(custom?.key).toMatch(/^c:\d+$/);

    expect(await h.toggle("l:1")).toBe(true);
    expect(await h.toggle(custom?.key ?? "")).toBe(false);
    const after = await h.list();
    expect(after[0]?.chosen).toBe(true);
    expect(after.at(-1)?.chosen).toBe(false);
  });

  test("không có LLM thì báo lỗi rõ ràng khi tự thêm", async () => {
    await expect(h.describe("x", "y")).rejects.toThrow("AI_GATEWAY_API_KEY");
  });
});
