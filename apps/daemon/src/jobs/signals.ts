/**
 * Re-fetches the community signals (points, comments…) of documents from the source's API, writing `doc_signals`.
 *
 * Runs before each digest for the candidate documents, and once for 30 days to get a salience baseline.
 * Only sources with `refreshSignals` are asked; other sources are skipped.
 *
 * Besides the signals asked from the source there are signals COMPUTED LOCALLY from data radard has collected (`LOCAL_SIGNALS`),
 * e.g. 24-hour star gain from `repo_stats`. They live here rather than in the adapter because
 * `SourceAdapter.refreshSignals` deliberately has no DB (the adapter only talks to the source), and not
 * in rank.ts because rank only reads `doc_signals` and calls the adapter's `engagement`, which does not know which source
 * has what. Writing them into `doc_signals` lets the baselines, ranking and digest read them like any other signal;
 * the adapter decides which signals to use in `engagement`.
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
  /** Number of documents with locally computed signals (no source query). */
  local?: number;
}

/** Documents that need signals, enough for the adapter or the local calculator to recognize them. */
export interface DocRef {
  id: number;
  kind: string;
  externalId: string;
  urlCanonical: string;
}

/**
 * Local signal calculator from data in the DB, run for EVERY refreshed document, every source: each one claims
 * the documents that belong to its part (a GitHub repo also claims HN posts that link to the repo). Returns documentId → signals;
 * if there is not enough data, the entry is absent, so the adapter's `engagement` uses a fallback.
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

/** Asks the source, per source kind that has `refreshSignals`. */
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

/** Re-fetches signals for exactly these `documents.id`s. */
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
  // Writes in batches so the statement does not get too long when backfilling thousands of documents.
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

/** Re-fetches signals for all documents of the sources that have signals, posted since `since`. */
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
