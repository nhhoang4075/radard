/**
 * Mọi cột jsonb phải chứa đúng kiểu nó khai, không phải một CHUỖI chứa JSON (lỗi mã hoá hai lần
 * của driver bun-sql, xem packages/db/src/schema/json.ts). Quét TOÀN BỘ cột jsonb chứ không
 * liệt kê tên, để cột thêm sau này ghi sai kiểu cũng tự bị bắt.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDatabase, documents, runMigrations, sourceState, sources } from "@radard/db";
import { sql } from "drizzle-orm";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });

beforeAll(async () => {
  await runMigrations(TEST_URL);
  // Ghi đủ mọi cột jsonb qua Drizzle, như code thật làm.
  const [s] = await db
    .insert(sources)
    .values({ kind: "hn", name: `jsonb-${Date.now()}`, cadence: "0 * * * *", config: { a: 1 } })
    .returning({ id: sources.id });
  const sourceId = s?.id ?? 0;
  await db.insert(sourceState).values({ sourceId, state: { cursor: 1 } });
  await db.insert(documents).values({
    sourceId,
    externalId: "x",
    url: "https://x.com",
    urlCanonical: "https://x.com",
    contentSha256: "0",
    rawKey: "raw/00/0.gz",
    contentType: "application/json",
    meta: { points: 3, note: "a\u0000b" },
  });
});

afterAll(async () => {
  await db.$bun.close();
});

test("không cột jsonb nào có dòng kiểu string", async () => {
  const cols = await db.execute<{ table_name: string; column_name: string }>(sql`
    select table_name, column_name from information_schema.columns
     where table_schema = 'public' and data_type = 'jsonb' order by 1, 2`);
  expect(cols.length).toBeGreaterThan(0);
  const bad: string[] = [];
  for (const c of cols) {
    const [row] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from ${sql.raw(`"${c.table_name}"`)}
       where jsonb_typeof(${sql.raw(`"${c.table_name}"."${c.column_name}"`)}) = 'string'`);
    if ((row?.n ?? 0) > 0) bad.push(`${c.table_name}.${c.column_name}: ${row?.n} dòng`);
  }
  expect(bad).toEqual([]);
});

test("SQL đọc được trường bên trong, byte NUL đã bị dọn", async () => {
  const [row] = await db.execute<{ points: string; note: string }>(sql`
    select meta->>'points' as points, meta->>'note' as note from documents where external_id = 'x'`);
  expect(row?.points).toBe("3");
  expect(row?.note).toBe("ab");
});
