import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsObjectStore } from "../src/object-store-fs.ts";
import { objectStoreContract } from "./object-store-contract.ts";

const root = await mkdtemp(join(tmpdir(), "radard-store-"));
afterAll(() => rm(root, { recursive: true, force: true }));

objectStoreContract("đĩa", () => fsObjectStore(root));

test("file trên đĩa được nén", async () => {
  const body = new TextEncoder().encode("xin chào ".repeat(200));
  await fsObjectStore(root).put("raw/ab/abc.gz", body, "text/plain");
  expect(Bun.file(join(root, "raw/ab/abc.gz")).size).toBeLessThan(body.length);
});
