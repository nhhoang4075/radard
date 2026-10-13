/**
 * Test đồng bộ lịch với pg-boss THẬT trên `radard_test`: pg-boss tự kiểm tra biểu thức cron,
 * nên dùng bản giả sẽ không bắt được đúng hành vi cần kiểm.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createDatabase, runMigrations, sources } from "@radard/db";
import { eq, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { ensureQueues, QUEUE } from "../src/boss.ts";
import { syncSchedules } from "../src/roles/scheduler.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const boss = new PgBoss({ connectionString: TEST_URL, schedule: false, max: 2 });

beforeAll(async () => {
  await runMigrations(TEST_URL);
  await boss.start();
  await ensureQueues(boss);
});

beforeEach(async () => {
  await db.execute(sql`truncate sources restart identity cascade`);
  for (const s of await boss.getSchedules(QUEUE.fetch)) await boss.unschedule(QUEUE.fetch, s.key);
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await db.$bun.close();
});

async function addSource(name: string, cadence: string, enabled = true): Promise<number> {
  const [row] = await db
    .insert(sources)
    .values({ kind: "fake", name, cadence, enabled })
    .returning({ id: sources.id });
  return row?.id ?? 0;
}

const scheduledKeys = async () =>
  (await boss.getSchedules(QUEUE.fetch)).map((s) => `${s.key}:${s.cron}`).sort();

test("một cadence sai không chặn các nguồn đứng sau nó", async () => {
  const a = await addSource("A", "*/15 * * * *");
  const b = await addSource("B", "every 15 min");
  const c = await addSource("C", "0 * * * *");

  const result = await syncSchedules(boss, db);

  expect(result.scheduled).toBe(2);
  expect(result.failed.map((f) => f.sourceId)).toEqual([b]);
  expect(await scheduledKeys()).toEqual([`${a}:*/15 * * * *`, `${c}:0 * * * *`]);
});

test("sửa cadence thành sai thì lịch cũ vẫn chạy", async () => {
  const a = await addSource("A", "*/15 * * * *");
  await syncSchedules(boss, db);

  await db.update(sources).set({ cadence: "61 * * * *" }).where(eq(sources.id, a));
  const result = await syncSchedules(boss, db);

  expect(result.failed).toHaveLength(1);
  expect(await scheduledKeys()).toEqual([`${a}:*/15 * * * *`]);
});

test("nguồn bị tắt thì lịch bị gỡ", async () => {
  const a = await addSource("A", "*/15 * * * *");
  await syncSchedules(boss, db);
  await db.update(sources).set({ enabled: false }).where(eq(sources.id, a));

  await syncSchedules(boss, db);

  expect(await scheduledKeys()).toEqual([]);
});
