/**
 * Documents of the items (digest, shared summary, "Với tôi?"): read from the DB by the `document_ids` captured
 * in the feed snapshot, enough to build the links and give them to the LLM.
 */
import { type Database, docSignals, docText, docTopicScores, documents, sources } from "@radard/db";
import { and, eq, inArray } from "drizzle-orm";
import { adapterFor } from "../sources/index.ts";

/** Length of the excerpt per document given to the LLM. */
const LLM_EXCERPT_CHARS = 500;

/** The part of a feed item that document reading needs. */
export interface DocsOf {
  eventId: number;
  documentIds: number[];
  topicId: number | null;
}

export interface ItemDoc {
  id: number;
  sourceId: number;
  sourceName: string;
  kind: string;
  externalId: string;
  title: string | null;
  /** Publication time of the article (null when the source does not provide it). */
  publishedAt: Date | null;
  url: string;
  urlCanonical: string;
  excerpt: string;
  signals: Record<string, number>;
  /** The document's topic score for the item's highest-R topic. */
  topicScore: number;
  engagement: number | null;
}

export function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

async function loadSignals(
  db: Database,
  ids: readonly number[],
): Promise<Map<number, Record<string, number>>> {
  const out = new Map<number, Record<string, number>>();
  for (const s of await db
    .select()
    .from(docSignals)
    .where(inArray(docSignals.documentId, [...ids]))) {
    out.set(s.documentId, { ...out.get(s.documentId), [s.metric]: s.value });
  }
  return out;
}

/** Topic score keyed by `documentId|topicId`, only for the R-assigned topics of the items. */
async function loadTopicScores(
  db: Database,
  ids: readonly number[],
  items: readonly DocsOf[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const topicIds = [...new Set(items.flatMap((it) => (it.topicId === null ? [] : [it.topicId])))];
  if (topicIds.length === 0) return out;
  for (const t of await db
    .select()
    .from(docTopicScores)
    .where(
      and(inArray(docTopicScores.documentId, [...ids]), inArray(docTopicScores.topicId, topicIds)),
    )) {
    out.set(`${t.documentId}|${t.topicId}`, t.score);
  }
  return out;
}

/** Raw salience computed by the source adapter from signals, as in the ranking step; null if none. */
export function engagementOf(kind: string, sig: Record<string, number> | undefined): number | null {
  if (!sig || !kind) return null;
  try {
    return adapterFor(kind).engagement?.(sig) ?? null;
  } catch {
    return null;
  }
}

/**
 * Documents of the items to report, by the `document_ids` captured in the snapshot (exactly the documents the ranking step
 * considered), enough to build the links and feed the LLM. The topic score is taken for the item's R-assigned topic; salience
 * is recomputed from the saved signals with the source's adapter, as in the ranking step.
 */
export async function loadItemDocs(
  db: Database,
  items: readonly DocsOf[],
): Promise<Map<number, ItemDoc[]>> {
  const out = new Map<number, ItemDoc[]>();
  const ids = [...new Set(items.flatMap((it) => it.documentIds))];
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: documents.id,
      sourceId: documents.sourceId,
      externalId: documents.externalId,
      title: documents.title,
      publishedAt: documents.publishedAt,
      url: documents.url,
      urlCanonical: documents.urlCanonical,
      text: docText.text,
    })
    .from(documents)
    .leftJoin(docText, eq(docText.documentId, documents.id))
    .where(inArray(documents.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const signals = await loadSignals(db, ids);
  const topicScore = await loadTopicScores(db, ids, items);
  const srcRows = await db
    .select({ id: sources.id, name: sources.name, kind: sources.kind })
    .from(sources);
  const src = new Map(srcRows.map((x) => [x.id, x]));
  for (const it of items) {
    const list: ItemDoc[] = [];
    for (const id of it.documentIds) {
      const r = byId.get(id);
      if (!r) continue;
      const kind = src.get(r.sourceId)?.kind ?? "";
      const sig = signals.get(r.id);
      list.push({
        id: r.id,
        sourceId: r.sourceId,
        sourceName: src.get(r.sourceId)?.name ?? String(r.sourceId),
        kind,
        externalId: r.externalId,
        title: r.title,
        publishedAt: r.publishedAt,
        url: r.url,
        urlCanonical: r.urlCanonical,
        excerpt: excerptOf(r.text, r.title),
        signals: sig ?? {},
        topicScore: it.topicId === null ? 0 : (topicScore.get(`${r.id}|${it.topicId}`) ?? 0),
        engagement: engagementOf(kind, sig),
      });
    }
    out.set(it.eventId, list);
  }
  return out;
}

/** Embedded text starts with the title: drop that part and take the first paragraph of the rest. */
function excerptOf(text: string | null, title: string | null): string {
  if (!text) return "";
  let body = text;
  if (title && body.startsWith(title)) body = body.slice(title.length);
  body = body.replace(/\s+/g, " ").trim();
  return body.length > LLM_EXCERPT_CHARS ? `${body.slice(0, LLM_EXCERPT_CHARS)}…` : body;
}
