/** No hard-coded Vietnamese text in .tsx: all displayed text lives in lib/strings.vi.ts. */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "../src");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const VIET = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

test("không có ký tự tiếng Việt có dấu trong .tsx (trừ comment)", () => {
  for (const f of walk(SRC).filter((f) => f.endsWith(".tsx"))) {
    const code = readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect([relative(SRC, f), VIET.test(code)]).toEqual([relative(SRC, f), false]);
  }
});
