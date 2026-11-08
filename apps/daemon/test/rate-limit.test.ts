/** Hẹn lại fetch khi bị 429: bậc chờ, `Retry-After`, và pg-boss THẬT nhận job hẹn trong lúc job cũ còn chạy. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { HttpError, parseRetryAfter } from "@radard/core";
import { createDatabase, runMigrations } from "@radard/db";
import { sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { ensureQueues, type FetchJob, QUEUE } from "../src/boss.ts";
import { RATE_LIMIT_STEPS_MIN, rateLimitDelaySeconds } from "../src/jobs/fetch.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const boss = new PgBoss({ connectionString: TEST_URL, schedule: false, max: 2 });

beforeAll(async () => {
  await runMigrations(TEST_URL);
  await boss.start();
  await ensureQueues(boss);
  await db.execute(sql`delete from pgboss.job where name = ${QUEUE.fetch}`);
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await db.$bun.close();
});

const err429 = (retryAfterMs?: number) => new HttpError(429, "https://x/api", "", retryAfterMs);

test("429: chờ 15, 30, 60, 120 phút rồi hết bậc (ném lại lỗi)", () => {
  const waits = RATE_LIMIT_STEPS_MIN.map((_, i) => rateLimitDelaySeconds(err429(), i));
  expect(waits).toEqual([900, 1800, 3600, 7200]);
  expect(rateLimitDelaySeconds(err429(), 4)).toBeNull();
});

test("Retry-After dài hơn bậc thì theo Retry-After; ngắn hơn thì giữ bậc", () => {
  expect(rateLimitDelaySeconds(err429(3 * 3600_000), 0)).toBe(10_800);
  expect(rateLimitDelaySeconds(err429(60_000), 0)).toBe(900);
});

test("lỗi khác 429 không được hẹn lại", () => {
  expect(rateLimitDelaySeconds(new HttpError(500, "u", ""), 0)).toBeNull();
  expect(rateLimitDelaySeconds(new Error("mạng"), 0)).toBeNull();
});

test("parseRetryAfter: số giây, ngày giờ HTTP, sai dạng", () => {
  expect(parseRetryAfter("120")).toBe(120_000);
  expect(parseRetryAfter(null)).toBeUndefined();
  expect(parseRetryAfter("không phải số")).toBeUndefined();
  const now = Date.parse("2026-11-09T00:00:00Z");
  expect(parseRetryAfter("Mon, 09 Nov 2026 00:01:00 GMT", now)).toBe(60_000);
});

test("pg-boss: gửi job hẹn giờ cùng singletonKey khi job cũ đang chạy", async () => {
  const key = "42";
  await boss.send(QUEUE.fetch, { sourceId: 42 } satisfies FetchJob, { singletonKey: key });
  const [active] = await boss.fetch<FetchJob>(QUEUE.fetch); // job cũ chuyển sang đang chạy
  expect(active?.data.sourceId).toBe(42);
  const id = await boss.send(QUEUE.fetch, { sourceId: 42, rateLimited: 1 } satisfies FetchJob, {
    startAfter: 900,
    singletonKey: key,
  });
  expect(id).not.toBeNull();
  if (active) await boss.complete(QUEUE.fetch, active.id);
});
