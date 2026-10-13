/**
 * Chạy migration, bọc trong khoá tư vấn: trên Railway nhiều service cùng image khởi động
 * cùng lúc, và hai tiến trình cùng `create table` thì một cái chết ngay lúc deploy.
 */
import { dirname, join } from "node:path";
import { createLogger } from "@radard/core";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createDatabase } from "./client.ts";

const log = createLogger("db:migrate");
const LOCK_KEY = 7_302_418;
const MIGRATIONS_FOLDER = join(dirname(dirname(new URL(import.meta.url).pathname)), "drizzle");

export async function runMigrations(url?: string): Promise<void> {
  const database = createDatabase(url, { max: 1 });
  const client = database.$bun;
  await client`select pg_advisory_lock(${LOCK_KEY})`;
  try {
    // Extension không do drizzle sinh. Bật sẵn ngay từ đầu để migration dữ liệu dẫn xuất (vector,
    // tìm gần đúng) không hỏng giữa chừng trên máy chưa bật.
    await database.execute(sql`create extension if not exists vector`);
    await database.execute(sql`create extension if not exists pg_trgm`);
    await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
    log.info("migration xong");
  } finally {
    await client`select pg_advisory_unlock(${LOCK_KEY})`;
    await client.close();
  }
}
