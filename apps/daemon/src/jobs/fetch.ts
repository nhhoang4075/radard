/**
 * `fetch` job: runs one source adapter, stores the raw copy, writes `documents`.
 *
 * Idempotent by (source_id, external_id): running again, running twice, or being killed midway
 * never produces extra records. Source state is updated only when the whole run succeeds,
 * so a failed run is read again from the same place by the next run.
 */
import {
  canonicalizeUrl,
  type HttpClient,
  HttpError,
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
  /** For tests: replace the real adapter with a fake one. */
  resolveAdapter?: typeof adapterFor;
}

export interface FetchOutcome {
  runId: number;
  status: "ok" | "not_modified" | "behind" | "error";
  nFetched: number;
  nNew: number;
  error?: string;
  /** A run stops before catching up to the present; the next run continues reading. */
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
    // Rethrow so pg-boss counts it as a failure and retries per the queue config.
    throw err;
  }
}

/**
 * Only writes the raw copy for items not yet stored: an HN run returns items already seen (because of the look-back window),
 * so there is no need to compress and rewrite them.
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

/**
 * Reschedules a fetch run that was rate-limited (HTTP 429). The queue's retry config (30 seconds, 1
 * minute, 2 minutes) retries too early: on 30/10/2026 arXiv returned 429 on all four runs within 5 minutes. So a 429
 * does not throw an error to pg-boss; instead it schedules a new job after 15, 30, 60, 120 minutes (or `Retry-After` if the
 * server asks for longer); when the steps run out it throws an error like any other. Returns the seconds to wait, or `null`
 * if it is not a 429 or the steps are exhausted (the caller rethrows the error).
 */
export const RATE_LIMIT_STEPS_MIN = [15, 30, 60, 120] as const;
export function rateLimitDelaySeconds(err: unknown, attempt: number): number | null {
  if (!(err instanceof HttpError) || err.status !== 429) return null;
  const step = RATE_LIMIT_STEPS_MIN[attempt];
  if (step === undefined) return null;
  return Math.ceil(Math.max(step * 60, (err.retryAfterMs ?? 0) / 1000));
}
