import { describe, expect, test } from "bun:test";
import { hostOf, safeUrl } from "../src/lib/url.ts";

describe("url", () => {
  test("safeUrl allows only http(s)", () => {
    expect(safeUrl("https://github.com/a/b")).toBe("https://github.com/a/b");
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeUrl(null)).toBeUndefined();
  });

  test("hostOf returns the host without www.", () => {
    expect(hostOf("https://www.example.com/post")).toBe("example.com");
    expect(hostOf("https://github.com/a/b")).toBe("github.com");
    expect(hostOf("https://news.ycombinator.com/item?id=1")).toBe("news.ycombinator.com");
  });

  test("hostOf is undefined for unsafe or invalid links", () => {
    expect(hostOf("javascript:alert(1)")).toBeUndefined();
    expect(hostOf("not a url")).toBeUndefined();
    expect(hostOf(undefined)).toBeUndefined();
  });
});
