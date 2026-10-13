/**
 * Job `baselines`: tính lại mặt bằng mỗi ngày, trước digest (xep-hang.html tab 03).
 *
 *   relevance   trung vị, mốc 0,1% của điểm chủ đề, theo (nguồn × chủ đề) và theo chủ đề trên
 *               mọi nguồn (mặt bằng chung, `source_id` trống)
 *   engagement  ln(1 + độ nổi thô) theo nguồn, chỉ trên bài đã đăng hơn 24 giờ lúc lấy tín hiệu
 *               (điểm HN còn tăng nhiều trong ngày đầu)
 *   coverage    ln(1 + số bài viết khác nhau) + 0,5 × (số nguồn − 1) của các sự kiện
 *
 * Cửa sổ trượt 30 ngày tính từ `now`. Chỉ giữ bản mới nhất mỗi khoá; digest tự chép lại bản đã
 * dùng. Chạy lại bao nhiêu lần cũng được.
 */
import { baselineOf, createLogger } from "@radard/core";
import { type Database, docSignals, documents, sources } from "@radard/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { adapterFor } from "../sources/index.ts";

const log = createLogger("baselines");

export const WINDOW_DAYS = 30;
/** Tín hiệu lấy khi bài mới đăng chưa nói gì: chỉ dùng tín hiệu quan sát sau chừng này giờ. */
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
    // Khoá duy nhất là biểu thức (coalesce cột có thể trống), nên viết on conflict bằng SQL.
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
  // grouping sets: một lần quét ra cả (nguồn × chủ đề) lẫn (chủ đề) cho mặt bằng chung. Tính cho mọi
  // chủ đề có điểm, bật hay chưa bật, để z của các chủ đề so được với nhau.
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
          gte(documents.publishedAt, since),
          sql`${docSignals.observedAt} - ${documents.publishedAt} >= make_interval(hours => ${MATURE_HOURS})`,
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
