/**
 * Opening paragraph of the day's feed (owner decision 13/11/2026: the snapshot is the single source; the web banner
 * and the Telegram digest both read it). Written ONCE per snapshot when the snapshot is built, from the titles of the
 * top items in position order, and stored in `feed_snapshots.meta.intro` (+ `meta.eventCount`). A model failure only
 * leaves the intro out; it never fails the snapshot.
 */
import { createLogger, type LlmProvider } from "@radard/core";
import { LANG_NAMES, LLM_MAX_OUTPUT_TOKENS } from "./summaries.ts";

const log = createLogger("snapshot-intro");

/** Number of top items (by snapshot position) whose titles the model sees. */
export const INTRO_MAX_ITEMS = 10;

export function introSystem(context: string, lang: string): string {
  const language = LANG_NAMES[lang] ?? lang;
  return [
    "You write the opening line of one reader's morning news brief.",
    `About the reader: ${context}`,
    `Write in ${language}. Keep product, company, model and library names as they are.`,
    "Use only the facts in the input. Never invent numbers, names, dates or claims.",
    "Never comment on the input itself (how much text you were given, missing details); just leave out what you do not know.",
    "Return ONLY a JSON object, no markdown fences, with this shape:",
    '{"intro": string}',
    "- intro: 1-2 sentences on what stands out today as a whole.",
  ].join("\n");
}

export function introPrompt(titles: readonly string[]): string {
  return titles.map((t, i) => `Story ${i + 1}: ${t}`).join("\n");
}

/** Reads the JSON the model returns; a missing or empty intro is an error (retried once, then dropped). */
export function parseIntro(reply: string): string {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("không thấy JSON trong câu trả lời");
  const data = JSON.parse(reply.slice(start, end + 1)) as { intro?: unknown };
  if (typeof data.intro !== "string" || data.intro.trim().length === 0) {
    throw new Error("thiếu intro");
  }
  return data.intro.trim();
}

/**
 * One model call, retried exactly once. Returns `null` (never throws) when there is no model, no title, or both attempts fail.
 * `titles` are in snapshot position order; only the first INTRO_MAX_ITEMS are used.
 */
export async function generateIntro(
  llm: LlmProvider | null,
  q: { context: string; lang: string; titles: readonly string[] },
): Promise<string | null> {
  const titles = q.titles.slice(0, INTRO_MAX_ITEMS);
  if (!llm || titles.length === 0) return null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const reply = await llm.generateText({
        task: "digest_labels",
        system: introSystem(q.context, q.lang),
        prompt: introPrompt(titles),
        maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
      });
      return parseIntro(reply);
    } catch (err) {
      log.warn("viết lời mở đầu hỏng", {
        attempt,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
    }
  }
  return null;
}
