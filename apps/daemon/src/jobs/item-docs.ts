/**
 * Tài liệu của các tin (digest, tóm tắt chung, "Với tôi?"): đọc từ DB theo `document_ids` đã chụp
 * trong bản chụp feed, đủ để dựng link và đưa cho LLM.
 */
import { type Database, docSignals, docText, docTopicScores, documents, sources } from "@radard/db";
import { and, eq, inArray } from "drizzle-orm";
import { adapterFor } from "../sources/index.ts";

/** Độ dài trích đoạn mỗi tài liệu đưa cho LLM. */
const LLM_EXCERPT_CHARS = 500;

/** Phần của một tin feed mà việc đọc tài liệu cần. */
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
  /** Giờ đăng của bài (null khi nguồn không cho). */
  publishedAt: Date | null;
  url: string;
  urlCanonical: string;
  excerpt: string;
  signals: Record<string, number>;
  /** Điểm chủ đề của tài liệu với chủ đề cho R cao nhất của tin. */
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

/** Điểm chủ đề theo khoá `documentId|topicId`, chỉ cho chủ đề cho R của các tin. */
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

/** Độ nổi thô do adapter của nguồn tính từ tín hiệu, như bước xếp hạng; không có thì null. */
export function engagementOf(kind: string, sig: Record<string, number> | undefined): number | null {
  if (!sig || !kind) return null;
  try {
    return adapterFor(kind).engagement?.(sig) ?? null;
  } catch {
    return null;
  }
}

/**
 * Tài liệu của các tin sẽ báo, theo `document_ids` đã chụp trong bản chụp (đúng các tài liệu bước
 * xếp hạng đã xét), đủ để dựng link và đưa cho LLM. Điểm chủ đề lấy theo chủ đề cho R của tin; độ
 * nổi tính lại từ tín hiệu đã lưu bằng adapter của nguồn, như bước xếp hạng.
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

/** Văn bản đã embed bắt đầu bằng tiêu đề: bỏ phần đó, lấy đoạn đầu phần còn lại. */
function excerptOf(text: string | null, title: string | null): string {
  if (!text) return "";
  let body = text;
  if (title && body.startsWith(title)) body = body.slice(title.length);
  body = body.replace(/\s+/g, " ").trim();
  return body.length > LLM_EXCERPT_CHARS ? `${body.slice(0, LLM_EXCERPT_CHARS)}…` : body;
}
