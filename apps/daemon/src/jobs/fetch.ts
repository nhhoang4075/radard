/**
 * Job `fetch`: chạy một adapter nguồn, lưu bản thô, ghi `documents`.
 *
 * Idempotent theo (source_id, external_id): chạy lại, chạy trùng hay bị kill giữa chừng
 * đều không sinh bản ghi thừa. Trạng thái nguồn chỉ được cập nhật khi cả lượt thành công,
 * nên lượt lỗi sẽ được lượt sau đọc lại từ đúng chỗ cũ.
 */
import {
  canonicalizeUrl,
  type HttpClient,
  type ObjectStore,
  type RawItem,
  rawKey,
  sha256,
} from "@radard/core";
import { type Database, documents, fetchRuns, repoStats, sourceState, sources } from "@radard/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { adapterFor } from "../sources/index.ts";

export interface FetchDeps {
  db: Database;
  store: ObjectStore;
  http: HttpClient;
  now?: () => Date;
  /** Cho test thay adapter thật bằng adapter giả. */
  resolveAdapter?: typeof adapterFor;
}

export interface FetchOutcome {
  runId: number;
  status: "ok" | "not_modified" | "behind" | "error";
  nFetched: number;
  nNew: number;
  error?: string;
  /** Lượt dừng trước khi bắt kịp hiện tại; lượt sau đọc tiếp. */
  behind?: string;
}

export async function runFetch(sourceId: number, deps: FetchDeps): Promise<FetchOutcome> {
  const { db, http } = deps;
  const now = deps.now?.() ?? new Date();
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
  if (!source) throw new Error(`không có nguồn id=${sourceId}`);

  const [run] = await db
    .insert(fetchRuns)
    .values({ sourceId, startedAt: now })
    .returning({ id: fetchRuns.id });
  if (!run) throw new Error("không tạo được fetch_run");

  const [stateRow] = await db.select().from(sourceState).where(eq(sourceState.sourceId, sourceId));
  try {
    const adapter = (deps.resolveAdapter ?? adapterFor)(source.kind);
    const result = await adapter.fetch({
      config: source.config,
      state: stateRow?.state ?? undefined,
      http,
      now,
    });

    const nNew = result.notModified ? 0 : await storeItems(sourceId, result.items, deps);
    if (result.repoStats?.length) {
      await db
        .insert(repoStats)
        .values(
          result.repoStats.map((r) => ({ ...r, repo: r.repo.toLowerCase(), observedAt: now })),
        );
    }
    const status = result.notModified ? "not_modified" : result.behind ? "behind" : "ok";

    await db
      .insert(sourceState)
      .values({ sourceId, state: result.state, lastOkAt: now, failCount: 0 })
      .onConflictDoUpdate({
        target: sourceState.sourceId,
        set: { state: result.state, lastOkAt: now, failCount: 0 },
      });
    await db
      .update(fetchRuns)
      .set({
        status,
        finishedAt: new Date(),
        httpStatus: result.httpStatus ?? null,
        nFetched: result.items.length,
        nNew,
        note: result.behind ?? null,
      })
      .where(eq(fetchRuns.id, run.id));
    return { runId: run.id, status, nFetched: result.items.length, nNew, behind: result.behind };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(fetchRuns)
      .set({ status: "error", finishedAt: new Date(), error: message.slice(0, 2000) })
      .where(eq(fetchRuns.id, run.id));
    await db
      .insert(sourceState)
      .values({ sourceId, lastErrorAt: now, failCount: 1 })
      .onConflictDoUpdate({
        target: sourceState.sourceId,
        set: { lastErrorAt: now, failCount: sql`${sourceState.failCount} + 1` },
      });
    // Ném lại để pg-boss tính là lỗi và retry theo cấu hình của queue.
    throw err;
  }
}

/**
 * Chỉ ghi bản thô cho mục chưa có: một lượt HN trả về cả mục đã thấy (vì có khoảng lùi),
 * không cần nén và ghi lại chúng.
 */
async function storeItems(
  sourceId: number,
  items: RawItem[],
  { db, store }: FetchDeps,
): Promise<number> {
  if (items.length === 0) return 0;
  const ids = [...new Set(items.map((i) => i.externalId))];
  const existing = await db
    .select({ externalId: documents.externalId })
    .from(documents)
    .where(and(eq(documents.sourceId, sourceId), inArray(documents.externalId, ids)));
  const seen = new Set(existing.map((r) => r.externalId));

  let nNew = 0;
  for (const item of items) {
    if (seen.has(item.externalId)) continue;
    seen.add(item.externalId);
    const bytes = new TextEncoder().encode(item.body.normalize("NFC"));
    const sha = sha256(bytes);
    const key = rawKey(sha);
    await store.put(key, bytes, item.contentType);
    const inserted = await db
      .insert(documents)
      .values({
        sourceId,
        externalId: item.externalId,
        url: item.url,
        urlCanonical: canonicalizeUrl(item.url),
        title: item.title ?? null,
        publishedAt: item.publishedAt ?? null,
        contentSha256: sha,
        rawKey: key,
        contentType: item.contentType,
        meta: item.meta ?? {},
      })
      .onConflictDoNothing({ target: [documents.sourceId, documents.externalId] })
      .returning({ id: documents.id });
    nNew += inserted.length;
  }
  return nNew;
}
