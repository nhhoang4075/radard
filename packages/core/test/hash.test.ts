import { expect, test } from "bun:test";
import { sha256 } from "../src/hash.ts";

test("hai cách mã hoá dấu tiếng Việt cho cùng một hash", () => {
  const composed = "Mô hình ngôn ngữ";
  const decomposed = composed.normalize("NFD");
  expect(decomposed).not.toBe(composed);
  expect(sha256(decomposed)).toBe(sha256(composed));
});

test("hash là hex 64 ký tự", () => {
  expect(sha256("radard")).toMatch(/^[0-9a-f]{64}$/);
});
