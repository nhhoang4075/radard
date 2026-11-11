/** Luật giữ bằng máy cho apps/web (docs/cau-truc-web.html mục 6). */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "../src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(SRC);
const rel = (f: string) => relative(SRC, f);

describe("apps/web", () => {
  test("không import @radard/db hoặc @radard/core (chỉ kiểu qua @radard/daemon/app)", () => {
    for (const f of files.filter((f) => /\.tsx?$/.test(f))) {
      expect([rel(f), /@radard\/(db|core|adapters)/.test(readFileSync(f, "utf8"))]).toEqual([
        rel(f),
        false,
      ]);
    }
  });

  test("mã màu thô (#hex, rgb(, hsl() chỉ nằm trong design/tokens.css", () => {
    for (const f of files.filter((f) => /\.(css|tsx?)$/.test(f) && !f.endsWith("tokens.css"))) {
      if (f.endsWith("routeTree.gen.ts")) continue;
      const src = readFileSync(f, "utf8");
      expect([rel(f), /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(src)]).toEqual([rel(f), false]);
    }
  });

  test("chỉ giao diện sáng: không prefers-color-scheme: dark", () => {
    for (const f of files.filter((f) => f.endsWith(".css"))) {
      expect(readFileSync(f, "utf8")).not.toMatch(/prefers-color-scheme:\s*dark/);
    }
  });
});
