/**
 * Xếp hạng một khoảng digest trên DB: đọc ứng viên, mặt bằng, tín hiệu, rồi gọi các hàm thuần
 * trong `@radard/core` (ranking.ts). Dùng chung cho job digest và CLI `rank`.
 *
 * Thứ tự để tốn ít request nhất: cổng R tính trên điểm chủ đề đã có (không gọi mạng); sự kiện có
 * R trong vùng xám thì hỏi model quyết định (gate-decision.ts); rồi chỉ lấy lại tín hiệu (điểm HN)
 * cho tài liệu của các sự kiện qua cổng.
 */
import {
  type Baseline,
  type Baselines,
  type Components,
  components,
  createLogger,
  DEFAULT_RANK_CONFIG,
  type DecisionProvider,
  FLOOR_WINDOW_DAYS,
  type FloorResult,
  type HttpClient,
  type InterestCluster,
  mulberry32,
  needsDecision,
  passesGate,
  percentileFloor,
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
  docSignals,
  docTopicScores,
  documents,
  eventDocuments,
  events,
  profileTopics,
  sources,
  topics as topicsTable,
} from "@radard/db";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { adapterFor } from "../sources/index.ts";
import { readCandidateScores } from "./candidate-pool.ts";
import {
  countGate,
  decideGate,
  type GateCandidate,
  type GateCounts,
  type GateDecision,
} from "./gate-decision.ts";
import { computeInterestClusters } from "./interest.ts";
import { refreshSignals } from "./signals.ts";

const log = createLogger("rank");

export interface RankPeriod {
  start: Date;
  end: Date;
}

export interface RankResult extends Selection {
  period: RankPeriod;
  candidates: number;
  passedGate: number;
  /** Danh sách ứng viên đã chấm đưa vào `select` (cả tin bị cổng/sàn loại), để mô phỏng đúng đầu vào. */
  scored: Scored[];
  /** Cấu hình đưa vào `select` (đã gồm sàn S và T), để mô phỏng đúng đầu vào. */
  selectConfig: RankConfig;
  /** Hạt giống của lần chọn; `null` khi chọn xác định (T = 0, xem thử). */
  selectSeed: number | null;
  /** Mọi sự kiện có R trong vùng xám: đã hỏi model quyết định, hoặc dùng luật cũ (`fallback`). */
  gateDecisions: GateDecision[];
  gateCounts: GateCounts;
  /** Thời gian hỏi model quyết định cho cổng, mili giây. */
  gateMs: number;
  config: RankConfig;
  /** Cụm gu (từ tin 👍) đã dùng để chấm U, gồm cả cụm `pending` chưa tham gia. */
  interestClusters: InterestCluster[];
  /**
   * Sàn THÔNG BÁO (nhắm `notify.floorTargetPerDay` tin/ngày): lớp Telegram lọc bản chụp theo sàn này.
   * Không dùng trong `select`.
   */
  floor: FloorResult;
  /** Sàn FEED (nhắm `feedFloorTargetPerDay` tin/ngày) đã đưa vào `select` (`selectConfig.floorS`). */
  feedFloor: FloorResult;
  /** Mặt bằng đã dùng, để digest lưu lại và giải thích được vì sao chọn. */
  baselines: {
    metric: string;
    sourceId: number | null;
    topicId: number | null;
    median: number;
    p999: number;
    n: number;
  }[];
  topicLabels: Map<number, string>;
  /** Phạm vi của từng chủ đề đang bật (để LLM gắn nhãn); chủ đề tự thêm không có thì vắng. */
  topicNotes: Map<number, string>;
  sourceNames: Map<number, string>;
  sourceKinds: Map<number, string>;
}

/** Khoảng 24 giờ kết thúc ở `end`. */
export function periodEndingAt(end: Date, hours = 24): RankPeriod {
  return { start: new Date(end.getTime() - hours * 3_600_000), end };
}

/**
 * Chủ đề đang bật của hồ sơ: chỉ loại "quan tâm" mới tính vào R; thứ tự theo lúc chọn, để hoà điểm ra
 * kết quả như nhau mỗi lần chạy.
 */
export async function loadProfileTopics(
  db: Database,
  profileId: number,
): Promise<{ id: number; label: string; note: string | null }[]> {
  return db
    .select({ id: topicsTable.id, label: topicsTable.name, note: topicsTable.labelGuide })
    .from(profileTopics)
    .innerJoin(topicsTable, eq(topicsTable.id, profileTopics.topicId))
    .where(
      and(
        eq(profileTopics.profileId, profileId),
        eq(profileTopics.active, true),
        eq(profileTopics.kind, "include"),
      ),
    )
    .orderBy(profileTopics.id);
}

export async function rankPeriod(
  db: Database,
  period: RankPeriod,
  opts: {
    /** Hồ sơ đang xếp hạng: chỉ chủ đề đang bật và tin đã gửi của hồ sơ này được tính. */
    profileId: number;
    http?: HttpClient;
    config?: Partial<RankConfig>;
    /** Model quyết định cho vùng xám của cổng; không có thì dùng luật R ≥ `gateR` (test, CLI). */
    decider?: DecisionProvider | null;
    /**
     * Lưu bộ cụm gu của lần chạy làm "cụm hôm qua" (mặc định có). CLI xem thử (`rank --at …`) đặt
     * `false` để không ghi đè cụm đang dùng.
     */
    persistInterests?: boolean;
    /**
     * Hạt giống chọn Gumbel top-k. CÓ hạt: T lấy từ `config` hoặc mặc định (0,03), rng là
     * mulberry32(hạt). KHÔNG có hạt: T = 0, chọn xác định (xem thử không đổi ngẫu nhiên).
     */
    selectSeed?: number;
  },
): Promise<RankResult> {
  const srcRows = await db.select().from(sources);
  const config: RankConfig = {
    ...DEFAULT_RANK_CONFIG,
    priors: new Map(srcRows.map((s) => [s.id, s.trustScore])),
    ...opts.config,
  };
  if (opts.selectSeed === undefined && opts.config?.temperature === undefined)
    config.temperature = 0;
  const kindOf = new Map(srcRows.map((s) => [s.id, s.kind]));

  const baseRows = await db.select().from(baselines);
  const key = (m: string, s: number | null, t: number | null) => `${m}|${s ?? ""}|${t ?? ""}`;
  const baseMap = new Map<string, Baseline>(
    baseRows.map((b) => [key(b.metric, b.sourceId, b.topicId), b]),
  );
  const base: Baselines = {
    relevance: (s, t) => baseMap.get(key("relevance", s, t)),
    engagement: (s) => baseMap.get(key("engagement", s, null)),
    coverage: () => baseMap.get(key("coverage", null, null)),
  };

  const topics = await loadProfileTopics(db, opts.profileId);
  const topicIds = topics.map((t) => t.id);

  // Ứng viên: sự kiện có ít nhất một tài liệu mới trong khoảng.
  const at = sql`coalesce(${documents.publishedAt}, ${documents.fetchedAt})`;
  // Tài liệu nguồn đánh dấu đáng ngờ (repo sao giả…) không vào điểm tin, dù vẫn được lưu và chấm.
  const trusted = sql`(${documents.meta}->>'suspicious') is distinct from 'true'`;
  const evIds = (
    await db
      .selectDistinct({ id: eventDocuments.eventId })
      .from(eventDocuments)
      .innerJoin(documents, eq(documents.id, eventDocuments.documentId))
      .where(and(gte(at, period.start), lt(at, period.end), trusted))
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
        .where(and(inArray(eventDocuments.eventId, evIds), lt(at, period.end), trusted))
    : [];
  const docIds = docRows.map((d) => d.id);

  const scores = new Map<number, Map<number, number>>();
  if (docIds.length && topicIds.length) {
    for (const r of await db
      .select()
      .from(docTopicScores)
      .where(
        and(inArray(docTopicScores.documentId, docIds), inArray(docTopicScores.topicId, topicIds)),
      )) {
      const m = scores.get(r.documentId) ?? new Map<number, number>();
      m.set(r.topicId, r.score);
      scores.set(r.documentId, m);
    }
  }

  // URL của mọi tài liệu ĐÃ THẤY, từ trước tới nay (không cắt 7 ngày: tin đã đọc 16/10 vẫn là đã
  // đọc ngày 09/11). "Đã thấy" = đã gửi trong tin sự kiện, hoặc tin feed đã có lượt hiện (quyết định
  // 10/11/2026, điểm 5); tin feed chưa cuộn tới vẫn đủ điều kiện hôm sau. Mốc `end` giữ cho chạy lại
  // một ngày cũ ra đúng kết quả của ngày đó. Chỉ của CHÍNH hồ sơ này.
  const sent = new Set<string>();
  for (const r of await db.execute<{ url: string }>(sql`
    select distinct d.url_canonical as url
    from deliveries dl
    cross join lateral unnest(dl.document_ids) as x(id)
    join documents d on d.id = x.id
    where dl.profile_id = ${opts.profileId} and dl.kind = 'event' and dl.sent_at < ${period.end}
    union
    select distinct d.url_canonical as url
    from feed_impressions fi
    join feed_items it
      on it.profile_id = fi.profile_id and it.snapshot_id = fi.snapshot_id and it.position = fi.position
    cross join lateral unnest(it.document_ids) as x(id)
    join documents d on d.id = x.id
    where fi.profile_id = ${opts.profileId} and fi.seen_at < ${period.end}`))
    sent.add(r.url);

  // Gu: gom lại từ đầu các tin 👍 tại mốc `end` mỗi lần xếp hạng (cụm mới mượn tên cụm lần trước).
  const interests = await computeInterestClusters(db, opts.profileId, period.end, config.interest, {
    persist: opts.persistInterests ?? true,
  });
  const hasTaste = interests.some((c) => c.status === "active");

  const build = async (
    signals: Map<number, Record<string, number>>,
    vectors?: ReadonlyMap<number, number[]>,
  ): Promise<RankEvent[]> => {
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
      const vector = vectors?.get(d.id);
      list.push({
        documentId: d.id,
        sourceId: d.sourceId,
        urlCanonical: d.url,
        topicScores: scores.get(d.id) ?? new Map(),
        engagement,
        ...(vector ? { vector } : {}),
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

  // Lượt 1: cổng R (không cần tín hiệu), vùng xám hỏi model quyết định. Lượt 2: lấy lại tín hiệu
  // cho sự kiện qua cổng, chấm đủ.
  const first = (await build(new Map())).map((e) => ({
    event: e,
    c: components(e, base, config, period.start, sent),
  }));
  const gateStarted = Date.now();
  const gateDecisions = await decideGate(db, grayZone(first, config), opts.decider, config);
  const gateMs = Date.now() - gateStarted;
  // Chỉ câu trả lời thật của model thay luật; `fallback` thì để `select` dùng R ≥ gateR.
  const verdicts = new Map(
    gateDecisions.filter((d) => !d.fallback).map((d) => [d.eventId, d.pass] as const),
  );
  const gateOf = (id: number) => verdicts.get(id);
  const passing = first
    .filter((x) => passesGate({ c: x.c, gate: gateOf(x.event.eventId) }, config))
    .map((x) => x.event);
  const passingDocIds = passing.flatMap((e) => e.docs.map((d) => d.documentId));
  if (opts.http) await refreshSignals(db, opts.http, passingDocIds);
  const signals = await loadSignals(passingDocIds);
  // Vector tài liệu chỉ nạp khi có cụm active và chỉ cho sự kiện qua cổng (U của tin bị cổng loại
  // không ai dùng: chúng không vào bể hay kế hoạch).
  const vectors = hasTaste ? await loadDocVectors(db, passingDocIds) : undefined;
  const full = await build(signals, vectors);
  // Sự kiện không qua cổng vẫn được chấm (để CLI giải thích vì sao bị loại), không có tín hiệu.
  const scored: Scored[] = full.map((e) => {
    const c = components(e, base, config, period.start, sent, interests);
    const gate = gateOf(e.eventId);
    return gate === undefined
      ? { event: e, c, S: scoreOf(c, config) }
      : { event: e, c, S: scoreOf(c, config), gate };
  });

  const { feed: feedFloor, notify: floor } = await resolveFloors(
    db,
    opts.profileId,
    period,
    config,
  );
  for (const [kind, f] of [
    ["feed", feedFloor],
    ["notify", floor],
  ] as const) {
    log.info("sàn điểm", {
      profileId: opts.profileId,
      kind,
      source: f.source,
      value: f.value,
      q: f.q ?? null,
      n: f.n ?? null,
      days: f.days,
    });
  }
  // `select` chạy MỘT lần cho bản chụp feed: trần K = feedMaxItems, mỗi nguồn feedMaxPerSource, sàn
  // feed. Cổng, vùng xám, MMR, giữ chỗ, T giữ nguyên.
  const selectConfig: RankConfig = {
    ...config,
    maxItems: config.feedMaxItems,
    maxPerSource: config.feedMaxPerSource,
    floorS: feedFloor.value,
  };
  const selection = select(
    scored,
    selectConfig,
    undefined,
    opts.selectSeed === undefined ? undefined : mulberry32(opts.selectSeed),
  );
  return {
    ...selection,
    scored,
    selectConfig,
    selectSeed: config.temperature > 0 && opts.selectSeed !== undefined ? opts.selectSeed : null,
    floor,
    feedFloor,
    period,
    candidates: evRows.length,
    passedGate: passing.length,
    gateDecisions,
    gateCounts: countGate(gateDecisions),
    gateMs,
    config,
    interestClusters: interests,
    // Chỉ lưu mặt bằng đã dùng: chủ đề đang bật, cùng mặt bằng tín hiệu và độ phủ.
    baselines: baseRows
      .filter((b) => b.topicId === null || topicIds.includes(b.topicId))
      .map((b) => ({
        metric: b.metric,
        sourceId: b.sourceId,
        topicId: b.topicId,
        median: b.median,
        p999: b.p999,
        n: b.n,
      })),
    topicLabels: new Map(topics.map((t) => [t.id, t.label])),
    topicNotes: new Map(topics.flatMap((t) => (t.note ? [[t.id, t.note] as const] : []))),
    sourceNames: new Map(srcRows.map((s) => [s.id, s.name])),
    sourceKinds: kindOf,
  };
}

const DAY_MS = 86_400_000;

/** Vector cả tài liệu (`coalesce(content_embedding, embedding)`), chuẩn hoá L2, để chấm U. */
async function loadDocVectors(
  db: Database,
  ids: readonly number[],
): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    for (const r of await db.execute<{ id: number; vec: string }>(sql`
      select document_id as id, coalesce(content_embedding, embedding)::text as vec
      from doc_text where document_id = any(${`{${chunk.join(",")}}`}::bigint[])`)) {
      const v = JSON.parse(r.vec) as number[];
      const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
      out.set(
        Number(r.id),
        v.map((x) => x / n),
      );
    }
  }
  return out;
}

/**
 * Hai sàn của lần xếp hạng (feed và thông báo), cùng một bể: phân vị điểm S trong bể của hồ sơ ở [end − 30 ngày, end) (không gồm ngày
 * đang xếp hạng), bỏ tin đã gửi (`not_new`, N = 0) khỏi cả phân vị lẫn n. Chế độ "fixed" không đọc bể.
 *
 * LƯU Ý THANG ĐIỂM (10/11/2026): các dòng bể cũ có S theo công thức trước khi có U (hệ số ×1,0, không
 * có phần U), dòng mới theo công thức 0,9× + 0,10·U. Hai thang pha trộn trong cửa sổ 30 ngày và KHÔNG
 * được sửa lại. Trong 14 ngày đầu của bể (`FLOOR_MIN_DAYS`) vẫn dùng sàn cố định 0,59 theo cơ chế
 * hiện có; logic sàn không đổi vì U.
 */
async function resolveFloors(
  db: Database,
  profileId: number,
  period: RankPeriod,
  config: RankConfig,
): Promise<{ feed: FloorResult; notify: FloorResult }> {
  const fixed: FloorResult = { value: config.floorS, source: "fixed", days: 0 };
  if (config.floorMode === "fixed") return { feed: fixed, notify: fixed };
  let rows: Awaited<ReturnType<typeof readCandidateScores>>;
  try {
    rows = await readCandidateScores(db, {
      profileId,
      from: new Date(period.end.getTime() - FLOOR_WINDOW_DAYS * DAY_MS),
      to: period.end,
    });
  } catch (err) {
    // Bể là dữ liệu phụ: đọc hỏng thì dùng sàn cố định, không chặn việc xếp hạng và gửi tin.
    log.warn("không đọc được bể ứng viên, dùng sàn cố định", {
      profileId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return { feed: fixed, notify: fixed };
  }
  const days = new Set(rows.map((r) => r.periodEnd.getTime())).size;
  const scores = rows.filter((r) => r.rejectReason !== "not_new" && r.n !== 0).map((r) => r.score);
  return {
    // Sàn feed: mục tiêu ~30 tin/ngày; n ≤ mục tiêu (q kẹp = 0) thì không lọc theo sàn.
    feed: percentileFloor({
      scores,
      days,
      fixed: config.floorS,
      targetPerDay: config.feedFloorTargetPerDay,
      noFilterAtZeroQ: true,
    }),
    // Sàn thông báo: như sàn phân vị hiện có (~12 tin/ngày).
    notify: percentileFloor({
      scores,
      days,
      fixed: config.floorS,
      targetPerDay: config.notify.floorTargetPerDay,
    }),
  };
}

/**
 * Sự kiện có R trong vùng xám của cổng, kèm chủ đề và tài liệu cho R, để hỏi model quyết định. Bỏ
 * qua tin đã gửi không có gì mới (N = 0): đằng nào cũng bị loại, hỏi chỉ tốn tiền.
 */
function grayZone(
  evs: readonly { event: RankEvent; c: Components }[],
  cfg: RankConfig,
): GateCandidate[] {
  const out: GateCandidate[] = [];
  for (const { event, c } of evs) {
    if (!needsDecision(c.R, cfg) || c.N === 0) continue;
    if (c.topicId === null || c.documentId === null) continue;
    out.push({ event, R: c.R, topicId: c.topicId, documentId: c.documentId });
  }
  return out;
}
