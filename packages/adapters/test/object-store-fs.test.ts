import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsObjectStore } from "../src/object-store-fs.ts";

const root = await mkdtemp(join(tmpdir(), "radard-store-"));
afterAll(() => rm(root, { recursive: true, force: true }));

test("ghi rồi đọc lại đúng nội dung, file trên đĩa được nén", async () => {
  const store = fsObjectStore(root);
  const body = new TextEncoder().encode("xin chào ".repeat(200));
  await store.put("raw/ab/abc.gz", body, "text/plain");

  expect(await store.exists("raw/ab/abc.gz")).toBe(true);
  expect(new TextDecoder().decode((await store.get("raw/ab/abc.gz")) ?? new Uint8Array())).toBe(
    "xin chào ".repeat(200),
  );
  expect(Bun.file(join(root, "raw/ab/abc.gz")).size).toBeLessThan(body.length);
});

test("key chưa có thì get trả null", async () => {
  expect(await fsObjectStore(root).get("raw/zz/none.gz")).toBeNull();
});
