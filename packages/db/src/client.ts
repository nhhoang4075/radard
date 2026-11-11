/**
 * Postgres connection through Bun's built-in SQL client (Drizzle's `bun-sql` driver).
 * One pool per process; the CLI and tests create and close it themselves.
 */
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema/index.ts";

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://localhost:5432/radard";
}

export function createDatabase(url?: string, opts?: { max?: number }) {
  const client = new SQL(url ?? databaseUrl(), opts ?? {});
  const database = drizzle({ client, schema });
  return Object.assign(database, { $bun: client });
}

export type Database = ReturnType<typeof createDatabase>;
