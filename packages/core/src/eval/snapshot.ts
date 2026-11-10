/** Ảnh chụp dữ liệu của bộ chấm: xuất ra JSON và nhập lại để chạy đúng số cũ không cần DB. */
import type { EvalDay, EvalSample, Level } from "./types.ts";

export interface EvalSnapshot {
  version: 1;
  days: EvalDay[];
}

export function toSnapshot(days: readonly EvalDay[]): EvalSnapshot {
  return { version: 1, days: days.map((d) => ({ date: d.date, samples: [...d.samples] })) };
}

const LEVELS: readonly string[] = ["like", "none", "dislike"];
const SCORE_KEYS = ["S", "penalty", "R", "P", "C", "A", "F", "N"] as const;

function fail(what: string): never {
  throw new Error(`ảnh chụp dữ liệu không hợp lệ: ${what}`);
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

function parseSample(x: unknown, date: string): EvalSample {
  if (!isRecord(x)) fail("mẫu không phải object");
  const { position, urls, level, score } = x;
  if (typeof position !== "number") fail("mẫu thiếu position");
  if (!Array.isArray(urls) || !urls.every((u) => typeof u === "string")) fail("mẫu thiếu urls");
  if (typeof level !== "string" || !LEVELS.includes(level)) fail("mẫu có level lạ");
  if (!isRecord(score)) fail("mẫu thiếu score");
  const out = {} as EvalSample["score"];
  for (const k of SCORE_KEYS) {
    const v = score[k];
    if (typeof v !== "number") fail(`score thiếu ${k}`);
    out[k] = v;
  }
  return { date, position, urls: urls as string[], level: level as Level, score: out };
}

/** Đọc ảnh chụp từ JSON đã parse; sai hình dạng thì ném lỗi rõ ràng. */
export function parseSnapshot(json: unknown): EvalDay[] {
  if (!isRecord(json) || json.version !== 1 || !Array.isArray(json.days))
    fail("thiếu version 1 hoặc days");
  return json.days.map((d: unknown) => {
    if (!isRecord(d) || typeof d.date !== "string" || !Array.isArray(d.samples))
      fail("ngày sai dạng");
    const date = d.date;
    return { date, samples: d.samples.map((s: unknown) => parseSample(s, date)) };
  });
}
