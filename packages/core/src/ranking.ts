/**
 * Xếp hạng digest: hàm thuần, không đọc DB hay mạng (thiết kế: docs/xep-hang.html).
 *
 * Mọi thành phần điểm đều về thang 0–1 bằng cách so với MẶT BẰNG của chính nguồn đó (và chủ đề
 * đó): trung vị ứng với 0 (bình thường như mọi bài), mốc 0,1% cao nhất ứng với 1 (hiếm có).
 */
import { type InterestCluster, interestScore } from "./interest.ts";
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
  /**
   * Vector cả tài liệu (đã chuẩn hoá L2) để chấm điểm gu U; vắng thì tài liệu không góp vào U.
   * Chỉ cần nạp khi có cụm gu active.
   */
  vector?: readonly number[];
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
  weights: { R: number; P: number; C: number; A: number; F: number; U: number };
  /**
   * Cổng: chỉ xét sự kiện có R ≥ ngưỡng này ("có thuộc chủ đề của bạn không"). Sự kiện có R trong
   * vùng `decision` thì hỏi model quyết định thay cho luật này; luật chỉ còn dùng khi không hỏi được.
   */
  gateR: number;
  /**
   * Vùng xám của cổng: R ∈ [low, high) thì hỏi model quyết định "tin này có chủ yếu nói về chủ đề
   * không", xác suất ≥ `minP` thì qua. R ≥ high qua luôn, R < low bị loại luôn.
   */
  decision: { low: number; high: number; minP: number };
  /** Sàn: không lấy tin có S dưới mức này, kể cả khi chưa đủ số tin ("có đủ đáng đọc không"). */
  floorS: number;
  /**
   * Nguồn của sàn: "fixed" luôn dùng `floorS`; "percentile" dùng phân vị 30 ngày (floor.ts) khi
   * bể có đủ 14 ngày dữ liệu, chưa đủ thì vẫn dùng `floorS`.
   */
  floorMode: "fixed" | "percentile";
  /** Độ nổi góp bởi nguồn không có tín hiệu (chốt 12/10/2026: 0,3). */
  neutralP: number;
  /** F khi sự kiện bắt đầu trước khoảng digest, nay có tin mới. */
  followUpF: number;
  /**
   * Gom cụm gu từ tin 👍 (interest.ts). `distanceThreshold` là τ của Ward (đo 10/11/2026 trên 👍
   * thật, chủ dự án duyệt τ = 1,4). Mỗi tham số ở đây truyền thẳng xuống `clusterInterests`.
   */
  interest: {
    distanceThreshold: number;
    maxClusters: number;
    minMembers: number;
    halfLifeDays: number;
    dropBelowWeight: number;
    nameCarryMinCosine: number;
  };
  maxItems: number;
  maxPerSource: number;
  /** Phạt trùng: từ giống `start` bắt đầu phạt, tới `start + span` thì phạt tối đa `max`. */
  mmr: { start: number; span: number; max: number };
  /**
   * Nhiệt độ T của chọn Gumbel top-k: khoá chọn là S + T·G (G ~ Gumbel(0,1)). T = 0: chọn xác
   * định như trước. Cổng, sàn và loại tin đã gửi luôn tính trên S thật, không nhiễu.
   */
  temperature: number;
  /** Uy tín của nguồn (A), 0–1, theo `sources.trust_score`. */
  priors: ReadonlyMap<number, number>;
}

/** Hằng số khởi đầu (xep-hang.html), chưa kiểm chứng: chỉnh lại sau tuần đầu theo 👍/👎. */
export const DEFAULT_RANK_CONFIG: Omit<RankConfig, "priors"> = {
  // Duyệt 10/11/2026: hệ số cũ (0,40/0,25/0,15/0,10/0,10) nhân 0,9, cộng w_U = 0,10; tổng = 1.
  // Chuẩn hoá lại L1 sau khi fit hằng tuần là việc sau.
  weights: { R: 0.36, P: 0.225, C: 0.135, A: 0.09, F: 0.09, U: 0.1 },
  interest: {
    distanceThreshold: 1.4,
    maxClusters: 6,
    minMembers: 3,
    halfLifeDays: 60,
    dropBelowWeight: 0.1,
    // Cụm mới chỉ nhận tên cụm cũ khi tâm hai cụm có cosine >= mức này. 0,8 = chọn của người
    // triển khai (spec bắt buộc có mức, chưa đo): đủ gần để coi là "cùng sở thích".
    nameCarryMinCosine: 0.8,
  },
  gateR: 0.6,
  // Đo 13–16/10/2026 trên tin thật có R trong [0,5; 0,7): Jev ở ngưỡng 0,6 khớp nhãn tham chiếu
  // 84%, luật cũ (R ≥ 0,6) chỉ 53%; bạn đã xác nhận các nhãn tham chiếu.
  decision: { low: 0.5, high: 0.7, minP: 0.6 },
  floorS: 0.59,
  floorMode: "percentile",
  neutralP: 0.3,
  followUpF: 0.6,
  maxItems: 7,
  // 3 làm digest 12/10 chỉ còn 4 tin dù 5 tin HN vượt sàn; nâng lên 5 (chốt 13/10/2026).
  maxPerSource: 5,
  mmr: { start: 0.85, span: 0.1, max: 0.3 },
  // Chủ dự án sẽ chọn T theo số đo thật; 0 = chọn xác định như cũ.
  temperature: 0,
};

export interface Components {
  R: number;
  P: number;
  C: number;
  A: number;
  F: number;
  /** Điểm gu: 0 khi chưa có cụm active (hoặc không có vector tài liệu). */
  U: number;
  N: number;
  /** Chủ đề cho R cao nhất: lý do "vì sao chọn" hiện trong digest. */
  topicId: number | null;
  /** Nguồn của tài liệu cho R cao nhất: dùng cho giữ chỗ và hạn mức theo nguồn. */
  sourceId: number;
  /** Tài liệu cho R cao nhất: đưa cho model quyết định khi R nằm trong vùng xám của cổng. */
  documentId: number | null;
}

/**
 * Tính sáu thành phần của một sự kiện.
 *
 * `periodStart`: đầu khoảng digest (24 giờ trước). `sentUrls`: `url_canonical` của mọi tài liệu đã
 * nằm trong các tin đã gửi, không giới hạn thời gian (`deliveries.document_ids`), để tính N.
 * `interests`: cụm gu active của hồ sơ (interest.ts); vắng hoặc rỗng thì U = 0. U của sự kiện là
 * U lớn nhất trên các tài liệu có vector.
 */
export function components(
  ev: RankEvent,
  base: Baselines,
  cfg: RankConfig,
  periodStart: Date,
  sentUrls: ReadonlySet<string>,
  interests: readonly InterestCluster[] = [],
): Components {
  const r = relevanceOf(ev, base);
  return {
    R: r.R,
    P: popularityOf(ev, base, cfg.neutralP),
    C: coverageOf(ev, base),
    A: Math.max(0, ...ev.docs.map((d) => cfg.priors.get(d.sourceId) ?? 0.5)),
    F: ev.firstSeenAt >= periodStart ? 1 : cfg.followUpF,
    U: tasteOf(ev, interests),
    N: noveltyOf(ev, sentUrls),
    topicId: r.topicId,
    sourceId: r.sourceId,
    documentId: r.documentId,
  };
}

/** U: `interestScore` lớn nhất trên các tài liệu có vector; không có cụm active thì 0. */
function tasteOf(ev: RankEvent, interests: readonly InterestCluster[]): number {
  let u = 0;
  for (const d of ev.docs) if (d.vector) u = Math.max(u, interestScore(d.vector, interests));
  return u;
}

/** R: lớn nhất trên mọi cặp (tài liệu, chủ đề), sau chuẩn hoá theo mặt bằng của nguồn × chủ đề. */
function relevanceOf(ev: RankEvent, base: Baselines) {
  let best = {
    R: 0,
    topicId: null as number | null,
    sourceId: ev.docs[0]?.sourceId ?? 0,
    documentId: null as number | null,
  };
  for (const d of ev.docs) {
    for (const [t, score] of d.topicScores) {
      const own = base.relevance(d.sourceId, t);
      const global = base.relevance(null, t);
      if (!own && !global) continue;
      const z = normalize(score, blendBaseline(own, global));
      if (z > best.R || best.topicId === null)
        best = { R: z, topicId: t, sourceId: d.sourceId, documentId: d.documentId };
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

/**
 * N: đã gửi mà không có gì mới thì loại (0); có tin mới thì giảm theo tỉ lệ đã gửi. "Mới" tính theo
 * URL chuẩn hoá, không theo tài liệu: một bài HN đăng lại cùng bài arXiv đã gửi là tài liệu mới
 * nhưng không phải tin mới (quyết định 09/11/2026, vụ Next-Concept Modeling gửi 3 lần).
 */
function noveltyOf(ev: RankEvent, sentUrls: ReadonlySet<string>): number {
  const urls = new Set(ev.docs.map((d) => d.urlCanonical));
  const sent = [...urls].filter((u) => sentUrls.has(u)).length;
  if (sent === 0) return 1;
  const fresh = (urls.size - sent) / Math.max(1, urls.size);
  return fresh === 0 ? 0 : 0.5 + 0.5 * fresh;
}

/** S = N × (0,36·R + 0,225·P + 0,135·C + 0,09·A + 0,09·F + 0,10·U) (duyệt 10/11/2026). */
export function scoreOf(c: Components, cfg: Pick<RankConfig, "weights">): number {
  const w = cfg.weights;
  return c.N * (w.R * c.R + w.P * c.P + w.C * c.C + w.A * c.A + w.F * c.F + w.U * c.U);
}

// ---------------------------------------------------------------------------------------------
// Chọn ≤ 7 tin (xep-hang.html tab 06)

export interface Scored {
  event: RankEvent;
  c: Components;
  S: number;
  /**
   * Câu trả lời của model quyết định cho cổng (R trong vùng xám): `true` qua, `false` loại. Vắng
   * khi không hỏi (R ngoài vùng xám) hoặc không hỏi được: khi đó dùng luật R ≥ `gateR`.
   */
  gate?: boolean;
}

export interface Rejected {
  event: RankEvent;
  c: Components;
  S: number;
  /** `decision_reject`: R trong vùng xám và model quyết định trả lời "không thuộc chủ đề". */
  reason: "gate" | "decision_reject" | "floor" | "not_new" | "source_cap" | "not_picked";
}

export interface Selection {
  picked: (Scored & { penalty: number; reserved: boolean })[];
  rejected: Rejected[];
}

/** Phạt trùng: 0 khi giống dưới `start`, tăng tuyến tính tới `max` khi giống ≥ `start + span`. */
export function mmrPenalty(maxSim: number, mmr: RankConfig["mmr"]): number {
  return mmr.max * clamp((maxSim - mmr.start) / mmr.span);
}

/** Nhiễu Gumbel(0,1) từ một số U ∈ [0,1): −ln(−ln U), U kẹp vào (ε, 1−ε) để không ra vô hạn. */
export function gumbelNoise(u: number): number {
  const eps = 1e-12;
  const x = Math.min(1 - eps, Math.max(eps, u));
  return -Math.log(-Math.log(x));
}

/**
 * Chọn tin: cổng R, sàn S, loại tin đã gửi không có gì mới; giữ một chỗ cho mỗi nguồn có ứng
 * viên vượt sàn; phần còn lại chọn từng tin một theo khoá trừ phạt trùng với tin đã chọn (MMR,
 * Carbonell & Goldstein 1998), mỗi nguồn tối đa `maxPerSource` tin. Kết quả sắp theo S − phạt.
 *
 * Khoá chọn là S khi `cfg.temperature` = 0 (xác định, không gọi `rng`); khi T > 0 là S + T·G với
 * G ~ Gumbel(0,1) rút MỘT LẦN cho mỗi ứng viên của pool trong mỗi lần gọi, dùng cho cả bước giữ
 * chỗ lẫn bước MMR (Gumbel top-k). Khoá nhiễu chỉ quyết định tin nào vào danh sách: phạt trùng
 * trả về và thứ tự kết quả vẫn theo S thật. `rng` trả số trong [0,1); T > 0 mà thiếu `rng` là lỗi.
 */
export function select(
  scored: readonly Scored[],
  cfg: RankConfig,
  sim: (a: RankEvent, b: RankEvent) => number = (a, b) => cosine(a.centroid, b.centroid),
  rng?: () => number,
): Selection {
  const { pool, rejected } = screen(scored, cfg);
  const noisy = cfg.temperature > 0;
  if (noisy && !rng) throw new Error("temperature > 0 cần rng");
  const keyOf = new Map<Scored, number>();
  for (const s of pool)
    keyOf.set(s, noisy && rng ? s.S + cfg.temperature * gumbelNoise(rng()) : s.S);
  // pool đã sắp theo S; sắp lại theo khoá (sort ổn định, T = 0 giữ nguyên thứ tự cũ).
  const order = noisy ? [...pool].sort((a, b) => (keyOf.get(b) ?? 0) - (keyOf.get(a) ?? 0)) : pool;
  const picked: Selection["picked"] = [];
  const perSource = new Map<number, number>();
  const take = (s: Scored, penalty: number, reserved: boolean) => {
    picked.push({ ...s, penalty, reserved });
    perSource.set(s.c.sourceId, (perSource.get(s.c.sourceId) ?? 0) + 1);
  };
  const isPicked = (s: Scored) => picked.some((p) => p.event.eventId === s.event.eventId);

  // Giữ chỗ: tin có khoá cao nhất của mỗi nguồn (order đã sắp theo khoá, gặp trước là tốt nhất).
  const seen = new Set<number>();
  for (const s of order) {
    if (picked.length >= cfg.maxItems) break;
    if (seen.has(s.c.sourceId)) continue;
    seen.add(s.c.sourceId);
    take(s, 0, true);
  }

  // Phần còn lại: từng tin một, khoá trừ phạt trùng với tin đã chọn giống nó nhất.
  while (picked.length < cfg.maxItems) {
    const open = order.filter(
      (s) => !isPicked(s) && (perSource.get(s.c.sourceId) ?? 0) < cfg.maxPerSource,
    );
    const best = bestByPenalizedScore(open, picked, cfg, sim, (s) => keyOf.get(s) ?? s.S);
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

/** R nằm trong vùng xám của cổng: cần hỏi model quyết định. */
export function needsDecision(R: number, cfg: Pick<RankConfig, "decision">): boolean {
  return R >= cfg.decision.low && R < cfg.decision.high;
}

/** Qua cổng: theo câu trả lời của model quyết định nếu có, không thì R ≥ `gateR`. */
export function passesGate(
  s: { c: Pick<Components, "R">; gate?: boolean },
  cfg: Pick<RankConfig, "gateR">,
): boolean {
  return s.gate ?? s.c.R >= cfg.gateR;
}

/** Cổng (R hoặc model quyết định), tin đã gửi không có gì mới, sàn S; phần còn lại sắp theo S. */
function screen(scored: readonly Scored[], cfg: RankConfig) {
  const rejected: Rejected[] = [];
  const pool: Scored[] = [];
  for (const s of scored) {
    if (!passesGate(s, cfg))
      rejected.push({ ...s, reason: s.gate === false ? "decision_reject" : "gate" });
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
  keyOf: (s: Scored) => number,
) {
  let best: { s: Scored; penalty: number; value: number } | null = null;
  for (const s of open) {
    const maxSim = Math.max(...picked.map((p) => sim(s.event, p.event)));
    const penalty = mmrPenalty(maxSim, cfg.mmr);
    const value = keyOf(s) - penalty;
    if (!best || value > best.value) best = { s, penalty, value };
  }
  return best;
}
