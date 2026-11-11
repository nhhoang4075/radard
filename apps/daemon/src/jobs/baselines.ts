/**
 * Job `baselines`: recomputes the baselines daily, before the digest (xep-hang.html tab 03).
 *
 *   relevance   median, the 0,1% quantile of the topic score, by (source × topic) and by topic across
 *               all sources (the overall baseline, `source_id` empty)
 *   engagement  ln(1 + raw salience) by source, only for posts older than 24 hours when signals are taken
 *               (HN scores still rise a lot on the first day)
 *   coverage    ln(1 + number of distinct articles) + 0,5 × (number of sources − 1) of the events
 *
 * A 30-day sliding window measured from `now`. Only the newest row per key is kept; the digest copies over the one it
 * uses. Re-running any number of times is fine.
 */
import { baselineOf, createLogger } from "@radard/core";
import { type Database, docSignals, documents, sources } from "@radard/db";
import { and, eq, sql } from "drizzle-orm";
import { adapterFor } from "../sources/index.ts";

const log = createLogger("baselines");

export const WINDOW_DAYS = 30;
/** Signals taken when a new post has nothing yet: only use signals observed after this many hours. */
const MATURE_HOURS = 24;

export interface BaselineRow {
  metric: "relevance" | "engagement" | "coverage";
  sourceId: number | null;
  topicId: number | null;
  median: number;
  p999: number;
  n: number;
}

export async function runBaselines(db: Database, now = new Date()): Promise<BaselineRow[]> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const rows: BaselineRow[] = [
    ...(await relevanceBaselines(db, since)),
    ...(await engagementBaselines(db, since)),
    ...(await coverageBaselines(db, since)),
  ];
  for (const r of rows) {
    // The unique key is an expression (a column may be null), so write the on-conflict in SQL.
    await db.execute(sql`
      insert into baselines (metric, source_id, topic_id, median, p999, n, window_days, computed_at)
      values (${r.metric}, ${r.sourceId}, ${r.topicId}, ${r.median}, ${r.p999}, ${r.n},
              ${WINDOW_DAYS}, ${now})
      on conflict (metric, coalesce(source_id, 0), coalesce(topic_id, 0)) do update
      set median = excluded.median, p999 = excluded.p999, n = excluded.n,
          window_days = excluded.window_days, computed_at = excluded.computed_at`);
  }
  log.info("xong", { rows: rows.length });
  return rows;
}

async function relevanceBaselines(db: Database, since: Date): Promise<BaselineRow[]> {
  // grouping sets: one scan produces both (source × topic) and (topic) rows for the overall baseline. Computed for every
  // scored topic, enabled or not, so the z-scores of the topics can be compared with each other.
  const res = await db.execute<{
    source_id: number | null;
    topic_id: number;
    median: number;
    p999: number;
    n: number;
  }>(sql`
    select d.source_id, s.topic_id,
      percentile_cont(0.5) within group (order by s.score) as median,
      percentile_cont(0.999) within group (order by s.score) as p999,
      count(*)::int as n
    from doc_topic_scores s
    join documents d on d.id = s.document_id
    where coalesce(d.published_at, d.fetched_at) >= ${since}
    group by grouping sets ((d.source_id, s.topic_id), (s.topic_id))`);
  return [...res].map((r) => ({
    metric: "relevance" as const,
    sourceId: r.source_id === null ? null : Number(r.source_id),
    topicId: Number(r.topic_id),
    median: Number(r.median),
    p999: Number(r.p999),
    n: Number(r.n),
  }));
}

async function engagementBaselines(db: Database, since: Date): Promise<BaselineRow[]> {
  const out: BaselineRow[] = [];
  for (const src of await db.select().from(sources)) {
    let engagement: ((s: Record<string, number>) => number | null) | undefined;
    try {
      engagement = adapterFor(src.kind).engagement;
    } catch {
      continue;
    }
    if (!engagement) continue;
    const rows = await db
      .select({ id: docSignals.documentId, metric: docSignals.metric, value: docSignals.value })
      .from(docSignals)
      .innerJoin(documents, eq(documents.id, docSignals.documentId))
      .where(
        and(
          eq(documents.sourceId, src.id),
          // Sources with no publish date (GitHub repos: "new" is when radard first saw it) are measured from fetch time,
          // the same way ranking picks the time window.
          sql`coalesce(${documents.publishedAt}, ${documents.fetchedAt}) >= ${since}`,
          sql`${docSignals.observedAt} - coalesce(${documents.publishedAt}, ${documents.fetchedAt}) >= make_interval(hours => ${MATURE_HOURS})`,
        ),
      );
    const byDoc = new Map<number, Record<string, number>>();
    for (const r of rows) byDoc.set(r.id, { ...byDoc.get(r.id), [r.metric]: r.value });
    const values: number[] = [];
    for (const s of byDoc.values()) {
      const e = engagement(s);
      if (e !== null) values.push(Math.log1p(e));
    }
    if (values.length === 0) continue;
    out.push({
      metric: "engagement",
      sourceId: src.id,
      topicId: null,
      ...baselineOf(values),
    });
  }
  return out;
}

async function coverageBaselines(db: Database, since: Date): Promise<BaselineRow[]> {
  const res = await db.execute<{ median: number; p999: number; n: number }>(sql`
    with c as (
      select ln(1 + count(distinct d.url_canonical)) + 0.5 * (count(distinct d.source_id) - 1) as v
      from events e
      join event_documents ed on ed.event_id = e.id
      join documents d on d.id = ed.document_id
      where e.last_seen_at >= ${since}
      group by e.id
    )
    select percentile_cont(0.5) within group (order by v) as median,
      percentile_cont(0.999) within group (order by v) as p999, count(*)::int as n
    from c`);
  const [r] = [...res];
  if (!r || Number(r.n) === 0) return [];
  return [
    {
      metric: "coverage",
      sourceId: null,
      topicId: null,
      median: Number(r.median),
      p999: Number(r.p999),
      n: Number(r.n),
    },
  ];
}
