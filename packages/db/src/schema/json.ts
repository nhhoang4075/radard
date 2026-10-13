/**
 * Cột JSONB. KHÔNG dùng `jsonb()` của Drizzle trực tiếp với driver `bun-sql`.
 *
 * `jsonb()` gọi `JSON.stringify` khi dựng tham số, rồi driver `bun-sql` stringify LẦN NỮA, nên
 * cột nhận về một CHUỖI chứa JSON (`"{\"a\":1}"`) thay vì object (`{"a": 1}`). Postgres không
 * kêu vì chuỗi cũng là JSON hợp lệ; Drizzle đọc ra thì parse lại, nên code TypeScript vẫn chạy
 * đúng. Cái hỏng là mọi thứ chạm cột bằng SQL, và hỏng IM LẶNG:
 *
 *   config->>'minRelevance'        NULL, đáng lẽ 0.55
 *   config || '{"a":1}'::jsonb     ra một MẢNG rác, không báo lỗi
 *
 * Đã dính ở radard ngày 28/09/2026: ngưỡng riêng theo nguồn đọc bằng SQL không có tác dụng.
 * Cùng lỗi và cùng cách sửa với `seongon-content` (`packages/db/src/schema/_common.ts`).
 *
 * `toDriver` để giá trị đi thẳng, driver serialize đúng MỘT lần. `fromDriver` nhận cả hai dạng
 * cho an toàn. Test `apps/daemon/test/jsonb.test.ts` canh không cột nào còn chứa chuỗi.
 */
import { customType } from "drizzle-orm/pg-core";

/**
 * Postgres từ chối hai thứ trong jsonb dù JavaScript và JSON đều chấp nhận: byte NUL và nửa lẻ
 * của cặp surrogate (sinh ra khi cắt chuỗi UTF-16 giữa một emoji). Cả hai đến từ nội dung web.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: bắt đúng byte NUL là mục đích của regex này
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
