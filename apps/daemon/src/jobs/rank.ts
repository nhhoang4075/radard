/**
 * Xếp hạng một khoảng digest trên DB: đọc ứng viên, mặt bằng, tín hiệu, rồi gọi các hàm thuần
 * trong `@radard/core` (ranking.ts). Dùng chung cho job digest và CLI `rank`.
 *
 * Thứ tự để tốn ít request nhất: cổng R tính trên điểm chủ đề đã có (không gọi mạng), rồi chỉ
 * lấy lại tín hiệu (điểm HN) cho tài liệu của các sự kiện qua cổng.
 */
import {
  type Baseline,
  type Baselines,
  components,
  DEFAULT_RANK_CONFIG,
  type HttpClient,
  type RankConfig,
  type RankDoc,
  type RankEvent,
  type Scored,
  type Selection,
  scoreOf,
  select,
} from "@radard/core";
import {
  baselines,
  type Database,
  deliveries,
  docSignals,
  docTopicScores,
  documents,
  eventDocuments,
  events,
  profileTopics,
  sources,
} from "@radard/db";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { adapterFor } from "../sources/index.ts";
import { refreshSignals } from "./signals.ts";

export interface RankPeriod {
  start: Date;
  end: Date;
}

export interface RankResult extends Selection {
  period: RankPeriod;
  candidates: number;
  passedGate: number;
  config: RankConfig;
  /** Mặt bằng đã dùng, để digest lưu lại và giải thích được vì sao chọn. */
  baselines: {
    metric: string;
    sourceId: number | null;
    profileTopicId: number | null;
    median: number;
    p999: number;
    n: number;
  }[];
  topicLabels: Map<number, string>;
  sourceNames: Map<number, string>;
  sourceKinds: Map<number, string>;
}

/** Khoảng 24 giờ kết thúc ở `end`. */
export function periodEndingAt(end: Date, hours = 24): RankPeriod {
  return { start: new Date(end.getTime() - hours * 3_600_000), end };
}

export async function rankPeriod(
  db: Database,
  period: RankPeriod,
  opts: { http?: HttpClient; config?: Partial<RankConfig> } = {},
): Promise<RankResult> {
  const srcRows = await db.select().from(sources);
  const config: RankConfig = {
    ...DEFAULT_RANK_CONFIG,
    priors: new Map(srcRows.map((s) => [s.id, s.trustScore])),
    ...opts.config,
  };
  const kindOf = new Map(srcRows.map((s) => [s.id, s.kind]));

  const baseRows = await db.select().from(baselines);
  const key = (m: string, s: number | null, t: number | null) => `${m}|${s ?? ""}|${t ?? ""}`;
  const baseMap = new Map<string, Baseline>(
    baseRows.map((b) => [key(b.metric, b.sourceId, b.profileTopicId), b]),
  );
  const base: Baselines = {
    relevance: (s, t) => baseMap.get(key("relevance", s, t)),
    engagement: (s) => baseMap.get(key("engagement", s, null)),
    coverage: () => baseMap.get(key("coverage", null, null)),
  };

  const topics = await db
    .select({ id: profileTopics.id, label: profileTopics.label })
    .from(profileTopics)
    .where(and(eq(profileTopics.active, true), eq(profileTopics.kind, "include")))
    .orderBy(profileTopics.id);
  const topicIds = topics.map((t) => t.id);

  // Ứng viên: sự kiện có ít nhất một tài liệu mới trong khoảng.
  const at = sql`coalesce(${documents.publishedAt}, ${documents.fetchedAt})`;
  const evIds = (
    await db
      .selectDistinct({ id: eventDocuments.eventId })
      .from(eventDocuments)
      .innerJoin(documents, eq(documents.id, eventDocuments.documentId))
      .where(and(gte(at, period.start), lt(at, period.end)))
  ).map((r) => r.id);

  const evRows = evIds.length
    ? await db
        .select({
          id: events.id,
          title: events.title,
          firstSeenAt: events.firstSeenAt,
          centroid: events.centroid,
        })
        .from(events)
        .where(inArray(events.id, evIds))
    : [];
  // Tài liệu của sự kiện tính tới hết khoảng (không lấy bài đến sau `end`, để chạy lại một
  // ngày cũ ra đúng kết quả của ngày đó).
  const docRows = evIds.length
    ? await db
        .select({
          eventId: eventDocuments.eventId,
          id: documents.id,
          sourceId: documents.sourceId,
          url: documents.urlCanonical,
        })
        .from(eventDocuments)
        .innerJoin(documents, eq(documents.id, eventDocuments.documentId))
        .where(and(inArray(eventDocuments.eventId, evIds), lt(at, period.end)))
    : [];
  const docIds = docRows.map((d) => d.id);

  const scores = new Map<number, Map<number, number>>();
  if (docIds.length && topicIds.length) {
    for (const r of await db
      .select()
      .from(docTopicScores)
      .where(
        and(
          inArray(docTopicScores.documentId, docIds),
          inArray(docTopicScores.profileTopicId, topicIds),
        ),
      )) {
      const m = scores.get(r.documentId) ?? new Map<number, number>();
      m.set(r.profileTopicId, r.score);
      scores.set(r.documentId, m);
    }
  }

  const sent = new Set<number>();
  for (const r of await db
    .select({ ids: deliveries.documentIds })
    .from(deliveries)
    .where(
      and(
        gte(deliveries.sentAt, new Date(period.end.getTime() - 7 * 86_400_000)),
        lt(deliveries.sentAt, period.end),
      ),
    ))
    for (const id of r.ids) sent.add(id);

  const build = async (signals: Map<number, Record<string, number>>): Promise<RankEvent[]> => {
    const byEvent = new Map<number, RankDoc[]>();
    for (const d of docRows) {
      let engagement: number | null = null;
      const s = signals.get(d.id);
      const kind = kindOf.get(d.sourceId);
      if (s && kind) {
        try {
          engagement = adapterFor(kind).engagement?.(s) ?? null;
        } catch {
          engagement = null;
        }
      }
      const list = byEvent.get(d.eventId) ?? [];
      list.push({
        documentId: d.id,
        sourceId: d.sourceId,
        urlCanonical: d.url,
        topicScores: scores.get(d.id) ?? new Map(),
        engagement,
      });
      byEvent.set(d.eventId, list);
    }
    return evRows.map((e) => ({
      eventId: e.id,
      title: e.title,
      firstSeenAt: e.firstSeenAt,
      centroid: e.centroid,
      docs: byEvent.get(e.id) ?? [],
    }));
  };

  const loadSignals = async (ids: number[]) => {
    const out = new Map<number, Record<string, number>>();
    if (ids.length === 0) return out;
    for (const r of await db.select().from(docSignals).where(inArray(docSignals.documentId, ids))) {
      out.set(r.documentId, { ...out.get(r.documentId), [r.metric]: r.value });
    }
    return out;
  };

  // Lượt 1: cổng R (không cần tín hiệu). Lượt 2: lấy lại tín hiệu cho sự kiện qua cổng, chấm đủ.
  const first = await build(new Map());
  const passing = first.filter(
    (e) => components(e, base, config, period.start, sent).R >= config.gateR,
  );
  const passingDocIds = passing.flatMap((e) => e.docs.map((d) => d.documentId));
  if (opts.http) await refreshSignals(db, opts.http, passingDocIds);
  const signals = await loadSignals(passingDocIds);
  const full = await build(signals);
  // Sự kiện không qua cổng vẫn được chấm (để CLI giải thích vì sao bị loại), không có tín hiệu.
  const scored: Scored[] = full.map((e) => {
    const c = components(e, base, config, period.start, sent);
    return { event: e, c, S: scoreOf(c, config) };
  });

  const selection = select(scored, config);
  return {
    ...selection,
    period,
    candidates: evRows.length,
    passedGate: passing.length,
    config,
    baselines: baseRows.map((b) => ({
      metric: b.metric,
      sourceId: b.sourceId,
      profileTopicId: b.profileTopicId,
      median: b.median,
      p999: b.p999,
      n: b.n,
    })),
    topicLabels: new Map(topics.map((t) => [t.id, t.label])),
    sourceNames: new Map(srcRows.map((s) => [s.id, s.name])),
    sourceKinds: kindOf,
  };
}
