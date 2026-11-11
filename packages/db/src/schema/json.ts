/**
 * JSONB columns. Do NOT use Drizzle's `jsonb()` directly with the `bun-sql` driver.
 *
 * `jsonb()` calls `JSON.stringify` when building the parameter, then the `bun-sql` driver stringifies AGAIN, so
 * the column gets a STRING containing JSON (`"{\"a\":1}"`) instead of an object (`{"a": 1}`). Postgres does not
 * complain, because a string is also valid JSON; Drizzle parses it again when reading, so TypeScript code still runs
 * correctly. What breaks is anything touching the column with SQL, and it breaks SILENTLY:
 *
 *   config->>'minRelevance'        NULL, should be 0.55
 *   config || '{"a":1}'::jsonb     produces a junk ARRAY, with no error
 *
 * Hit radard on 28/09/2026: per-source thresholds read via SQL had no effect.
 * Same bug and same fix as `seongon-content` (`packages/db/src/schema/_common.ts`).
 *
 * `toDriver` passes the value straight through so the driver serializes exactly ONCE. `fromDriver` accepts both forms
 * for safety. The test `apps/daemon/test/jsonb.test.ts` checks that no column still contains a string.
 */
import { customType } from "drizzle-orm/pg-core";

/**
 * Postgres rejects two things in jsonb even though JavaScript and JSON accept them: NUL bytes and lone
 * surrogate halves (produced when a UTF-16 string is cut in the middle of an emoji). Both come from web content.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching exactly the NUL byte is the purpose of this regex
const UNSAFE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function jsonSafe<T>(value: T): T {
  if (typeof value === "string") return value.replace(UNSAFE, "") as T;
  if (Array.isArray(value)) return value.map(jsonSafe) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [jsonSafe(k), jsonSafe(v)]),
    ) as T;
  }
  return value;
}

export const jsonb = <T = unknown>(name: string) =>
  customType<{ data: T; driverData: unknown }>({
    dataType: () => "jsonb",
    toDriver: (v) => jsonSafe(v),
    fromDriver: (v) => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T)),
  })(name);
