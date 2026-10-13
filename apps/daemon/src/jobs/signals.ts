/**
 * Lấy lại tín hiệu cộng đồng (điểm, bình luận…) của tài liệu từ API của nguồn, ghi `doc_signals`.
 *
 * Chạy trước mỗi digest cho các tài liệu ứng viên, và một lần cho 30 ngày để có mặt bằng độ nổi.
 * Chỉ nguồn có `refreshSignals` mới được hỏi; nguồn khác bỏ qua.
 *
 * Ngoài tín hiệu hỏi từ nguồn còn có tín hiệu TÍNH TẠI CHỖ từ dữ liệu radard đã thu (`LOCAL_SIGNALS`),
 * ví dụ sao tăng 24 giờ từ `repo_stats`. Chúng nằm ở đây chứ không trong adapter vì
 * `SourceAdapter.refreshSignals` cố ý không có DB (adapter chỉ nói chuyện với nguồn), và không nằm
 * trong rank.ts vì rank chỉ đọc `doc_signals` và gọi `engagement` của adapter, không biết nguồn nào
 * có gì. Ghi chung vào `doc_signals` thì mặt bằng, xếp hạng và digest đọc được như mọi tín hiệu
 * khác; adapter quyết định dùng tín hiệu nào trong `engagement`.
 */
import { createLogger, type HttpClient, type Signals } from "@radard/core";
import { type Database, docSignals, documents, sources } from "@radard/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { adapterFor } from "../sources/index.ts";
import { repoStatsSignals } from "./repo-stats.ts";

const log = createLogger("signals");

export interface SignalOutcome {
  asked: number;
  updated: number;
  missing: number;
  /** Số tài liệu có tín hiệu tính tại chỗ (không hỏi nguồn). */
  local?: number;
}

/** Tài liệu cần tín hiệu, đủ để adapter hay bộ tính tại chỗ nhận ra nó. */
export interface DocRef {
  id: number;
  kind: string;
  externalId: string;
  urlCanonical: string;
}

/**
 * Bộ tính tín hiệu từ dữ liệu trong DB, chạy cho MỌI tài liệu được làm mới, mọi nguồn: tự nhận
 * tài liệu nào thuộc phần mình (repo GitHub nhận cả bài HN link tới repo). Trả documentId → tín hiệu;
 * chưa đủ dữ liệu thì vắng mặt, để `engagement` của adapter dùng cách tạm.
 */
export type LocalSignals = (
  db: Database,
  docs: DocRef[],
  now: Date,
) => Promise<Map<number, Signals>>;

const LOCAL_SIGNALS: LocalSignals[] = [repoStatsSignals];

type SignalRow = typeof docSignals.$inferInsert;

const rowsOf = (docId: number, s: Signals | undefined, observedAt: Date): SignalRow[] =>
  Object.entries(s ?? {}).map(([metric, value]) => ({
    documentId: docId,
    metric,
    value,
    observedAt,
  }));

/** Hỏi nguồn, theo từng kiểu nguồn có `refreshSignals`. */
async function fromSources(
  http: HttpClient,
  docs: DocRef[],
  out: SignalOutcome,
): Promise<SignalRow[]> {
  const byKind = new Map<string, DocRef[]>();
  for (const d of docs) byKind.set(d.kind, [...(byKind.get(d.kind) ?? []), d]);
  const rows: SignalRow[] = [];
  for (const [kind, list] of byKind) {
    const adapter = adapterFor(kind);
    if (!adapter.refreshSignals) continue;
    out.asked += list.length;
    const signals = await adapter.refreshSignals(
      list.map((d) => d.externalId),
      http,
    );
    const observedAt = new Date();
    for (const d of list) rows.push(...rowsOf(d.id, signals.get(d.externalId), observedAt));
    const missing = list.filter((d) => !signals.has(d.externalId)).length;
    out.missing += missing;
    out.updated += list.length - missing;
  }
  return rows;
}

async function fromLocal(db: Database, docs: DocRef[], out: SignalOutcome): Promise<SignalRow[]> {
  const now = new Date();
  const rows: SignalRow[] = [];
  const touched = new Set<number>();
  for (const compute of LOCAL_SIGNALS) {
    for (const [docId, s] of await compute(db, docs, now)) {
      touched.add(docId);
      rows.push(...rowsOf(docId, s, now));
    }
  }
  out.local = touched.size;
  return rows;
}

/** Lấy lại tín hiệu cho đúng các `documents.id` này. */
export async function refreshSignals(
  db: Database,
  http: HttpClient,
  documentIds: number[],
): Promise<SignalOutcome> {
  const out: SignalOutcome = { asked: 0, updated: 0, missing: 0, local: 0 };
  if (documentIds.length === 0) return out;
  const docs = await db
    .select({
      id: documents.id,
      externalId: documents.externalId,
      urlCanonical: documents.urlCanonical,
      kind: sources.kind,
    })
    .from(documents)
    .innerJoin(sources, eq(sources.id, documents.sourceId))
    .where(inArray(documents.id, documentIds));

  const rows = [...(await fromSources(http, docs, out)), ...(await fromLocal(db, docs, out))];
  // Ghi theo lô để câu lệnh không quá dài khi backfill hàng nghìn tài liệu.
  for (let i = 0; i < rows.length; i += 1000) {
    await db
      .insert(docSignals)
      .values(rows.slice(i, i + 1000))
      .onConflictDoUpdate({
        target: [docSignals.documentId, docSignals.metric],
        set: { value: sql`excluded.value`, observedAt: sql`excluded.observed_at` },
      });
  }
  log.info("lấy lại tín hiệu", { ...out });
  return out;
}

/** Lấy lại tín hiệu cho mọi tài liệu của các nguồn có tín hiệu, đăng từ `since`. */
export async function refreshSince(
  db: Database,
  http: HttpClient,
  since: Date,
): Promise<SignalOutcome> {
  const kinds = [
    ...new Set((await db.select({ kind: sources.kind }).from(sources)).map((s) => s.kind)),
  ].filter((k) => {
    try {
      return Boolean(adapterFor(k).refreshSignals);
    } catch {
      return false;
    }
  });
  if (kinds.length === 0) return { asked: 0, updated: 0, missing: 0 };
  const ids = await db
    .select({ id: documents.id })
    .from(documents)
    .innerJoin(sources, eq(sources.id, documents.sourceId))
    .where(
      and(
        inArray(sources.kind, kinds),
        sql`coalesce(${documents.publishedAt}, ${documents.fetchedAt}) >= ${since}`,
      ),
    );
  return refreshSignals(
    db,
    http,
    ids.map((r) => r.id),
  );
}
