/**
 * Xếp hạng digest: hàm thuần, không đọc DB hay mạng (thiết kế: docs/xep-hang.html).
 *
 * Mọi thành phần điểm đều về thang 0–1 bằng cách so với MẶT BẰNG của chính nguồn đó (và chủ đề
 * đó): trung vị ứng với 0 (bình thường như mọi bài), mốc 0,1% cao nhất ứng với 1 (hiếm có).
 */
import { cosine } from "./vector.ts";

/** Mặt bằng của một tín hiệu: trung vị, mốc 0,1% cao nhất, và số mẫu đã dùng để tính. */
export interface Baseline {
  median: number;
  p999: number;
  n: number;
}

/**
 * Phần vị nội suy tuyến tính, giống `percentile_cont` của Postgres: vị trí (n − 1) × p trong
 * dãy đã sắp tăng dần, nội suy giữa hai phần tử kề nhau. `sorted` phải sắp sẵn.
 */
export function percentileCont(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

/** Mặt bằng từ một mảng giá trị bất kỳ. */
export function baselineOf(values: readonly number[]): Baseline {
  const sorted = [...values].sort((x, y) => x - y);
  return {
    median: percentileCont(sorted, 0.5),
    p999: percentileCont(sorted, 0.999),
    n: sorted.length,
  };
}

/**
 * Hằng số trộn: cần khoảng chừng này mẫu thì mặt bằng riêng của nguồn mới chiếm một nửa.
 * Mốc 0,1% của n mẫu là mẫu cao thứ n/1.000, nên dưới ~1.000 mẫu nó chính là mẫu cao nhất.
 */
export const BLEND_K = 1000;

/**
 * Trộn mặt bằng riêng của nguồn với mặt bằng chung, theo w = n / (n + 1000), áp cho cả trung vị
 * lẫn mốc 0,1%. Nguồn mới (n = 0) dùng hẳn mặt bằng chung rồi chuyển dần, không có điểm gãy.
 */
export function blendBaseline(own: Baseline | undefined, global: Baseline | undefined): Baseline {
  if (!own) {
    if (!global) throw new Error("không có mặt bằng nào để chuẩn hoá");
    return global;
  }
  if (!global) return own;
  const w = own.n / (own.n + BLEND_K);
  return {
    median: w * own.median + (1 - w) * global.median,
    p999: w * own.p999 + (1 - w) * global.p999,
    n: own.n,
  };
}

/** Ép x vào [lo, hi]. */
export function clamp(x: number, lo = 0, hi = 1): number {
  return Math.min(hi, Math.max(lo, x));
}

/** z = clamp((x − trung vị) / (mốc 0,1% − trung vị)): 0 = bình thường, 1 = hiếm có. */
export function normalize(x: number, b: Baseline): number {
  const span = b.p999 - b.median;
  if (!(span > 0)) return x > b.median ? 1 : 0;
  return clamp((x - b.median) / span);
}

// ---------------------------------------------------------------------------------------------
// Sáu thành phần và điểm S (xep-hang.html tab 04)

/** Một tài liệu của sự kiện, đủ thông tin để chấm điểm. */
export interface RankDoc {
  documentId: number;
  sourceId: number;
  urlCanonical: string;
  /** Cosine với từng chủ đề đang bật (`profile_topic_id` → điểm). */
  topicScores: ReadonlyMap<number, number>;
  /**
   * Độ nổi thô do adapter nguồn tính (`SourceAdapter.engagement`), dạng cộng được. `null`: nguồn
   * không có tín hiệu (arXiv, releases), hoặc chưa lấy được tín hiệu.
   */
  engagement: number | null;
}

export interface RankEvent {
  eventId: number;
  title: string;
  firstSeenAt: Date;
  centroid: readonly number[];
  docs: readonly RankDoc[];
}

/** Mặt bằng đã tra sẵn từ bảng `baselines`. */
export interface Baselines {
  /** Theo (nguồn, chủ đề) và mặt bằng chung của chủ đề (khoá nguồn `null`). */
  relevance(sourceId: number | null, topicId: number): Baseline | undefined;
  engagement(sourceId: number): Baseline | undefined;
  coverage(): Baseline | undefined;
}

export interface RankConfig {
  weights: { R: number; P: number; C: number; A: number; F: number };
  /** Cổng: chỉ xét sự kiện có R ≥ ngưỡng này ("có thuộc chủ đề của bạn không"). */
  gateR: number;
  /** Sàn: không lấy tin có S dưới mức này, kể cả khi chưa đủ số tin ("có đủ đáng đọc không"). */
  floorS: number;
  /** Độ nổi góp bởi nguồn không có tín hiệu (chốt 12/10/2026: 0,3). */
  neutralP: number;
  /** F khi sự kiện bắt đầu trước khoảng digest, nay có tin mới. */
  followUpF: number;
  maxItems: number;
  maxPerSource: number;
  /** Phạt trùng: từ giống `start` bắt đầu phạt, tới `start + span` thì phạt tối đa `max`. */
  mmr: { start: number; span: number; max: number };
  /** Uy tín của nguồn (A), 0–1, theo `sources.trust_score`. */
  priors: ReadonlyMap<number, number>;
}

/** Hằng số khởi đầu (xep-hang.html), chưa kiểm chứng: chỉnh lại sau tuần đầu theo 👍/👎. */
export const DEFAULT_RANK_CONFIG: Omit<RankConfig, "priors"> = {
  weights: { R: 0.4, P: 0.25, C: 0.15, A: 0.1, F: 0.1 },
  gateR: 0.6,
  floorS: 0.59,
  neutralP: 0.3,
  followUpF: 0.6,
  maxItems: 7,
  // 3 làm digest 12/10 chỉ còn 4 tin dù 5 tin HN vượt sàn; nâng lên 5 (chốt 13/10/2026).
  maxPerSource: 5,
  mmr: { start: 0.85, span: 0.1, max: 0.3 },
};

export interface Components {
  R: number;
  P: number;
  C: number;
  A: number;
  F: number;
  N: number;
  /** Chủ đề cho R cao nhất: lý do "vì sao chọn" hiện trong digest. */
  topicId: number | null;
  /** Nguồn của tài liệu cho R cao nhất: dùng cho giữ chỗ và hạn mức theo nguồn. */
  sourceId: number;
}

/**
 * Tính sáu thành phần của một sự kiện.
 *
 * `periodStart`: đầu khoảng digest (24 giờ trước). `sentDocIds`: tài liệu đã nằm trong các tin
 * đã gửi 7 ngày qua (`deliveries.document_ids`), để tính N.
 */
export function components(
  ev: RankEvent,
  base: Baselines,
  cfg: RankConfig,
  periodStart: Date,
  sentDocIds: ReadonlySet<number>,
): Components {
  const r = relevanceOf(ev, base);
  return {
    R: r.R,
    P: popularityOf(ev, base, cfg.neutralP),
    C: coverageOf(ev, base),
    A: Math.max(0, ...ev.docs.map((d) => cfg.priors.get(d.sourceId) ?? 0.5)),
    F: ev.firstSeenAt >= periodStart ? 1 : cfg.followUpF,
    N: noveltyOf(ev, sentDocIds),
    topicId: r.topicId,
    sourceId: r.sourceId,
  };
}

/** R: lớn nhất trên mọi cặp (tài liệu, chủ đề), sau chuẩn hoá theo mặt bằng của nguồn × chủ đề. */
function relevanceOf(ev: RankEvent, base: Baselines) {
  let best = { R: 0, topicId: null as number | null, sourceId: ev.docs[0]?.sourceId ?? 0 };
  for (const d of ev.docs) {
    for (const [t, score] of d.topicScores) {
      const own = base.relevance(d.sourceId, t);
      const global = base.relevance(null, t);
      if (!own && !global) continue;
      const z = normalize(score, blendBaseline(own, global));
      if (z > best.R || best.topicId === null) best = { R: z, topicId: t, sourceId: d.sourceId };
    }
  }
  return best;
}

/**
 * P: mỗi NGUỒN có mặt trong sự kiện góp một giá trị; P là giá trị lớn nhất (quyết định 13/10).
 *   - nguồn có tín hiệu: cộng độ nổi các tài liệu của nguồn đó (5 lần đăng lại = 5 nhóm người
 *     cùng chú ý), lấy ln, chuẩn hoá theo mặt bằng của CHÍNH nguồn đó;
 *   - nguồn không có tín hiệu (hoặc chưa lấy được): trung tính.
 * Không nguồn nào được đối xử riêng; và được một nguồn đo được nhắc tới (dù ít điểm) không bao
 * giờ làm P thấp hơn khi không được nhắc.
 */
function popularityOf(ev: RankEvent, base: Baselines, neutralP: number): number {
  const bySource = new Map<number, number | null>();
  for (const d of ev.docs) {
    const prev = bySource.get(d.sourceId) ?? null;
    bySource.set(d.sourceId, d.engagement === null ? prev : (prev ?? 0) + d.engagement);
  }
  let P = 0;
  for (const [s, sum] of bySource) {
    const b = sum === null ? undefined : base.engagement(s);
    P = Math.max(P, sum === null || !b ? neutralP : normalize(Math.log1p(sum), b));
  }
  return P;
}

/** C: số BÀI VIẾT khác nhau (URL), không đếm lượt đăng lại; nguồn độc lập cùng nói thì thưởng. */
function coverageOf(ev: RankEvent, base: Baselines): number {
  const urls = new Set(ev.docs.map((d) => d.urlCanonical)).size;
  const nSources = new Set(ev.docs.map((d) => d.sourceId)).size;
  const cov = base.coverage();
  return cov ? normalize(Math.log1p(urls) + 0.5 * (nSources - 1), cov) : 0;
}

/** N: đã gửi mà không có gì mới thì loại (0); có tài liệu mới thì giảm theo tỉ lệ đã gửi. */
function noveltyOf(ev: RankEvent, sentDocIds: ReadonlySet<number>): number {
  const sent = ev.docs.filter((d) => sentDocIds.has(d.documentId)).length;
  if (sent === 0) return 1;
  const fresh = (ev.docs.length - sent) / Math.max(1, ev.docs.length);
  return fresh === 0 ? 0 : 0.5 + 0.5 * fresh;
}

/** S = N × (0,40·R + 0,25·P + 0,15·C + 0,10·A + 0,10·F). Phần cá nhân hoá U để sau (wU = 0). */
export function scoreOf(c: Components, cfg: Pick<RankConfig, "weights">): number {
  const w = cfg.weights;
  return c.N * (w.R * c.R + w.P * c.P + w.C * c.C + w.A * c.A + w.F * c.F);
}

// ---------------------------------------------------------------------------------------------
// Chọn ≤ 7 tin (xep-hang.html tab 06)

export interface Scored {
  event: RankEvent;
  c: Components;
  S: number;
}

export interface Rejected {
  event: RankEvent;
  c: Components;
  S: number;
  reason: "gate" | "floor" | "not_new" | "source_cap" | "not_picked";
}

export interface Selection {
  picked: (Scored & { penalty: number; reserved: boolean })[];
  rejected: Rejected[];
}

/** Phạt trùng: 0 khi giống dưới `start`, tăng tuyến tính tới `max` khi giống ≥ `start + span`. */
export function mmrPenalty(maxSim: number, mmr: RankConfig["mmr"]): number {
  return mmr.max * clamp((maxSim - mmr.start) / mmr.span);
}

/**
 * Chọn tin: cổng R, sàn S, loại tin đã gửi không có gì mới; giữ một chỗ cho mỗi nguồn có ứng
 * viên vượt sàn; phần còn lại chọn từng tin một theo S trừ phạt trùng với tin đã chọn (MMR,
 * Carbonell & Goldstein 1998), mỗi nguồn tối đa `maxPerSource` tin. Kết quả sắp theo S − phạt.
 */
export function select(
  scored: readonly Scored[],
  cfg: RankConfig,
  sim: (a: RankEvent, b: RankEvent) => number = (a, b) => cosine(a.centroid, b.centroid),
): Selection {
  const { pool, rejected } = screen(scored, cfg);
  const picked: Selection["picked"] = [];
  const perSource = new Map<number, number>();
  const take = (s: Scored, penalty: number, reserved: boolean) => {
    picked.push({ ...s, penalty, reserved });
    perSource.set(s.c.sourceId, (perSource.get(s.c.sourceId) ?? 0) + 1);
  };
  const isPicked = (s: Scored) => picked.some((p) => p.event.eventId === s.event.eventId);

  // Giữ chỗ: tin tốt nhất của mỗi nguồn (pool đã sắp theo S, nên gặp trước là tốt nhất).
  const seen = new Set<number>();
  for (const s of pool) {
    if (picked.length >= cfg.maxItems) break;
    if (seen.has(s.c.sourceId)) continue;
    seen.add(s.c.sourceId);
    take(s, 0, true);
  }

  // Phần còn lại: từng tin một, S trừ phạt trùng với tin đã chọn giống nó nhất.
  while (picked.length < cfg.maxItems) {
    const open = pool.filter(
      (s) => !isPicked(s) && (perSource.get(s.c.sourceId) ?? 0) < cfg.maxPerSource,
    );
    const best = bestByPenalizedScore(open, picked, cfg, sim);
    if (!best) break;
    take(best.s, best.penalty, false);
  }

  for (const s of pool.filter((x) => !isPicked(x))) {
    const capped = (perSource.get(s.c.sourceId) ?? 0) >= cfg.maxPerSource;
    rejected.push({ ...s, reason: capped ? "source_cap" : "not_picked" });
  }
  // Gửi theo điểm SAU phạt, không theo S: sắp theo S thì tin bị phạt vì trùng (vd hai tin Nvidia)
  // lại đứng ngay cạnh tin nó trùng, đúng điều bước phạt muốn tránh.
  picked.sort((a, b) => b.S - b.penalty - (a.S - a.penalty));
  return { picked, rejected };
}

/** Cổng R, tin đã gửi không có gì mới, sàn S; phần còn lại sắp theo S giảm dần. */
function screen(scored: readonly Scored[], cfg: RankConfig) {
  const rejected: Rejected[] = [];
  const pool: Scored[] = [];
  for (const s of scored) {
    if (s.c.R < cfg.gateR) rejected.push({ ...s, reason: "gate" });
    else if (s.c.N === 0) rejected.push({ ...s, reason: "not_new" });
    else if (s.S < cfg.floorS) rejected.push({ ...s, reason: "floor" });
    else pool.push(s);
  }
  pool.sort((a, b) => b.S - a.S);
  return { pool, rejected };
}

function bestByPenalizedScore(
  open: readonly Scored[],
  picked: readonly Scored[],
  cfg: RankConfig,
  sim: (a: RankEvent, b: RankEvent) => number,
) {
  let best: { s: Scored; penalty: number; value: number } | null = null;
  for (const s of open) {
    const maxSim = Math.max(...picked.map((p) => sim(s.event, p.event)));
    const penalty = mmrPenalty(maxSim, cfg.mmr);
    const value = s.S - penalty;
    if (!best || value > best.value) best = { s, penalty, value };
  }
  return best;
}
