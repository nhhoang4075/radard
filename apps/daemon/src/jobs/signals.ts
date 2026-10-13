/**
 * Lấy lại tín hiệu cộng đồng (điểm, bình luận…) của tài liệu từ API của nguồn, ghi `doc_signals`.
 *
 * Chạy trước mỗi digest cho các tài liệu ứng viên, và một lần cho 30 ngày để có mặt bằng độ nổi.
 * Chỉ nguồn có `refreshSignals` mới được hỏi; nguồn khác bỏ qua.
 */
import { createLogger, type HttpClient } from "@radard/core";
import { type Database, docSignals, documents, sources } from "@radard/db";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { adapterFor } from "../sources/index.ts";

const log = createLogger("signals");

export interface SignalOutcome {
  asked: number;
  updated: number;
  missing: number;
}

/** Lấy lại tín hiệu cho đúng các `documents.id` này. */
export async function refreshSignals(
  db: Database,
  http: HttpClient,
  documentIds: number[],
): Promise<SignalOutcome> {
  const out: SignalOutcome = { asked: 0, updated: 0, missing: 0 };
  if (documentIds.length === 0) return out;
  const docs = await db
    .select({ id: documents.id, externalId: documents.externalId, kind: sources.kind })
    .from(documents)
    .innerJoin(sources, eq(sources.id, documents.sourceId))
    .where(inArray(documents.id, documentIds));

  const byKind = new Map<string, typeof docs>();
  for (const d of docs) byKind.set(d.kind, [...(byKind.get(d.kind) ?? []), d]);

  for (const [kind, list] of byKind) {
    const adapter = adapterFor(kind);
    if (!adapter.refreshSignals) continue;
    out.asked += list.length;
    const signals = await adapter.refreshSignals(
      list.map((d) => d.externalId),
      http,
    );
    const observedAt = new Date();
    const rows = list.flatMap((d) =>
      Object.entries(signals.get(d.externalId) ?? {}).map(([metric, value]) => ({
        documentId: d.id,
        metric,
        value,
        observedAt,
      })),
    );
    const missing = list.filter((d) => !signals.has(d.externalId)).length;
    out.missing += missing;
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
    out.updated += list.length - missing;
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
    .where(and(inArray(sources.kind, kinds), gte(documents.publishedAt, since)));
  return refreshSignals(
    db,
    http,
    ids.map((r) => r.id),
  );
}
