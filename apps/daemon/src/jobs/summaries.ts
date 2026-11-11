/**
 * SHARED summary of an event (decision 11/11/2026, mo-hinh-de-xuat.html: "shared summary,
 * 'for you' split into a button"): only "what happened and the context", with NO sentence "why it is
 * notable for you". Written ONCE per (event, language, document set) and cached in `event_summaries`
 * (no `profile_id`): two profiles with the same event share one row. If an event gets more articles, the document set
 * changes, `docs_hash` changes, and a new row is created.
 *
 * Calls the model only for events NOT yet cached, in batches; each batch is retried exactly once. An error in one batch only makes
 * the items of that batch lack a summary (the original title shows), without breaking the whole snapshot.
 */
import { createLogger, type LlmProvider, sha256 } from "@radard/core";
import { type Database, eventSummaries } from "@radard/db";
import { and, eq, inArray } from "drizzle-orm";
import { type DocsOf, host, type ItemDoc, loadItemDocs } from "./item-docs.ts";

const log = createLogger("summaries");

/** Number of documents per item given to the LLM. */
export const LLM_DOCS_PER_ITEM = 4;
/** Number of items in one summary call. */
export const SUMMARY_BATCH_SIZE = 10;
/**
 * Output token cap. The model's hidden thinking tokens count toward this cap and vary a lot (13/10/2026: for the same
 * prompt, three calls produced 2,127, 2,376 and hit the 4,000 cap). The cap is only a limit: money is charged on actual tokens.
 */
export const LLM_MAX_OUTPUT_TOKENS = 8000;

export const LANG_NAMES: Record<string, string> = { vi: "Vietnamese", en: "English" };

export interface SharedSummary {
  id: number;
  title: string;
  summary: string;
}

/**
 * Documents put into the summary prompt: the LLM_DOCS_PER_ITEM NEWEST documents (highest id) of the item. Not
 * dependent on any profile (no topic score is used), and if the event gets more articles this set changes.
 */
export function docsForSummary(docs: readonly ItemDoc[]): ItemDoc[] {
  return [...docs].sort((a, b) => b.id - a.id).slice(0, LLM_DOCS_PER_ITEM);
}

/** Hashes the list of document ids (sorted ascending) into `docs_hash`. */
export function docsHashOf(docIds: readonly number[]): string {
  return sha256([...docIds].sort((a, b) => a - b).join(","));
}

export function summarySystem(lang: string): string {
  const language = LANG_NAMES[lang] ?? lang;
  return [
    "You write short news summaries for a news feed that many different readers share.",
    `Write in ${language}. Keep product, company, model and library names as they are.`,
    "Use only the facts in the input. Never invent numbers, names, dates or claims.",
    // 13/10/2026: without this line, the model wrote "most items only have a title…" into the opening sentence.
    "Never comment on the input itself (how much text you were given, missing details); just leave out what you do not know.",
    "Return ONLY a JSON object, no markdown fences, with this shape:",
    '{"items": [{"n": number, "title": string, "summary": string}]}',
    "- items: exactly one entry per input story, with the same n.",
    "- title: at most 12 words.",
    "- summary: 2-3 sentences: what happened, and the context needed to understand it.",
  ].join("\n");
}

export function summaryPrompt(stories: readonly { n: number; docs: readonly ItemDoc[] }[]): string {
  return stories
    .map((s) => {
      const docs = s.docs.map((d) => {
        const signals = Object.entries(d.signals)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ");
        const head = `- [${d.sourceName}${signals ? `, ${signals}` : ""}] ${d.title ?? "(no title)"} (${host(d.url)})`;
        return d.excerpt ? `${head}\n  Excerpt: ${d.excerpt}` : head;
      });
      return [`Story ${s.n}`, "Documents:", ...docs].join("\n");
    })
    .join("\n\n");
}

/** Reads the JSON the model returns; if any item is missing, throws an error (so it is retried once, then the batch is dropped). */
export function parseSummaryBatch(
  reply: string,
  count: number,
): Map<number, { title: string; summary: string }> {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("không thấy JSON trong câu trả lời");
  const data = JSON.parse(reply.slice(start, end + 1)) as { items?: unknown };
  if (!Array.isArray(data.items)) throw new Error("thiếu items");
  const items = new Map<number, { title: string; summary: string }>();
  for (const it of data.items as { n?: unknown; title?: unknown; summary?: unknown }[]) {
    if (
      typeof it.n !== "number" ||
      typeof it.title !== "string" ||
      typeof it.summary !== "string"
    ) {
      continue;
    }
    const title = it.title.trim();
    const summary = it.summary.trim();
    if (title.length === 0 || title.length > 200 || summary.length < 20) continue;
    items.set(it.n, { title, summary });
  }
  for (let n = 1; n <= count; n++) {
    if (!items.has(n)) throw new Error(`thiếu tóm tắt cho tin ${n}`);
  }
  return items;
}

/** One batch: calls the model, retried exactly once. If both attempts fail, throws the error of the last attempt. */
async function summarizeBatch(
  llm: LlmProvider,
  lang: string,
  stories: readonly { n: number; docs: readonly ItemDoc[] }[],
): Promise<Map<number, { title: string; summary: string }>> {
  let error: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const reply = await llm.generateText({
        task: "digest",
        system: summarySystem(lang),
        prompt: summaryPrompt(stories),
        maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
      });
      return parseSummaryBatch(reply, stories.length);
    } catch (err) {
      error = err;
      log.warn("tóm tắt hỏng", {
        attempt,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
    }
  }
  throw error;
}

export interface SharedSummaryResult {
  /** By `eventId`: the summary of the item (from cache, or just written). Items without one are absent. */
  byEvent: Map<number, SharedSummary>;
  /** Number of items that needed the model (not cached) and number still missing afterwards. */
  requested: number;
  failed: number;
}

/**
 * Ensures a shared summary exists for every item in `items` (language `lang`). A cache hit does not call the model.
 * If `llm` is null, only the part already cached is returned.
 */
export async function ensureSharedSummaries(
  deps: { db: Database; llm: LlmProvider | null },
  items: readonly DocsOf[],
  lang: string,
): Promise<SharedSummaryResult> {
  const { db, llm } = deps;
  const out: SharedSummaryResult = { byEvent: new Map(), requested: 0, failed: 0 };
  if (items.length === 0) return out;
  const docsByEvent = await loadItemDocs(db, items);

  type Todo = { eventId: number; docsHash: string; docs: ItemDoc[] };
  const wanted: Todo[] = [];
  for (const it of items) {
    const docs = docsForSummary(docsByEvent.get(it.eventId) ?? []);
    if (docs.length === 0) continue;
    wanted.push({ eventId: it.eventId, docsHash: docsHashOf(docs.map((d) => d.id)), docs });
  }
  const key = (eventId: number, docsHash: string) => `${eventId}|${docsHash}`;
  const cached = new Map<string, SharedSummary>();
  const load = async (rows: readonly Todo[]) => {
    if (rows.length === 0) return;
    for (const r of await db
      .select()
      .from(eventSummaries)
      .where(
        and(
          eq(eventSummaries.lang, lang),
          inArray(eventSummaries.eventId, [...new Set(rows.map((x) => x.eventId))]),
        ),
      )) {
      cached.set(key(r.eventId, r.docsHash), { id: r.id, title: r.title, summary: r.summary });
    }
  };
  await load(wanted);
  const missing = wanted.filter((w) => !cached.has(key(w.eventId, w.docsHash)));
  out.requested = missing.length;

  if (llm && missing.length > 0) {
    const batches: Todo[][] = [];
    for (let i = 0; i < missing.length; i += SUMMARY_BATCH_SIZE) {
      batches.push(missing.slice(i, i + SUMMARY_BATCH_SIZE));
    }
    await Promise.all(
      batches.map(async (batch) => {
        try {
          const written = await summarizeBatch(
            llm,
            lang,
            batch.map((b, i) => ({ n: i + 1, docs: b.docs })),
          );
          await db
            .insert(eventSummaries)
            .values(
              batch.map((b, i) => {
                const w = written.get(i + 1);
                return {
                  eventId: b.eventId,
                  lang,
                  docsHash: b.docsHash,
                  title: w?.title ?? "",
                  summary: w?.summary ?? "",
                  model: llm.model,
                };
              }),
            )
            .onConflictDoNothing();
          await load(batch);
        } catch (err) {
          // A batch error: the items of that batch fall back to the original title, the other batches still work.
          log.error("lô tóm tắt lỗi, bỏ qua các tin của lô", {
            events: batch.length,
            error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
          });
        }
      }),
    );
  }

  for (const w of wanted) {
    const hit = cached.get(key(w.eventId, w.docsHash));
    if (hit) out.byEvent.set(w.eventId, hit);
    else out.failed++;
  }
  return out;
}

/** Summaries by id (the snapshot's items point to them via `feed_items.summary_id`). */
export async function loadSummariesById(
  db: Database,
  ids: readonly number[],
): Promise<Map<number, SharedSummary>> {
  const out = new Map<number, SharedSummary>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  for (const r of await db
    .select()
    .from(eventSummaries)
    .where(inArray(eventSummaries.id, unique))) {
    out.set(r.id, { id: r.id, title: r.title, summary: r.summary });
  }
  return out;
}
