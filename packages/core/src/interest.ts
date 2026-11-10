// Lõi THUẦN của điểm gu U: gom các tin 👍 thành vài "tâm" sở thích rồi chấm độ hợp gu của một tin.
// Không DB, không gọi model, không đọc env, không ngẫu nhiên: cùng đầu vào cho cùng đầu ra.
//
// TODO(spec: cụm 👎 sau ~30 👎): chưa dựng cụm cho tin 👎; hàm ở đây chỉ nhận tin 👍.

export type InterestItem = {
  id: string;
  /** Vector cả tài liệu, đã chuẩn hoá L2. */
  vector: readonly number[];
  ageDays: number;
};

export type PreviousCluster = { name: string | null; center: readonly number[] };

export type InterestCluster = {
  /** `active` (>= minMembers tin) tham gia tính U; `pending` (chờ) thì không. */
  status: "active" | "pending";
  /** Tên mang từ lần chạy trước; null nếu không có. Chỉ cụm active mới nhận tên. */
  name: string | null;
  /** Trung bình có trọng số của vector thành viên, rồi chuẩn hoá L2. */
  center: number[];
  /** I_k: tổng trọng số theo tuổi của các tin trong cụm. */
  importance: number;
  /** Id tin gần `center` nhất (cosine), để chủ dự án xem cụm này là gì. */
  medoid: string;
  /** Id các thành viên, sắp tăng dần. */
  memberIds: string[];
};

export type ClusterInterestsOptions = {
  /** Ngưỡng cắt cây theo chiều cao Ward (xem `wardHeight`). BẮT BUỘC, không có mặc định. */
  distanceThreshold: number;
  /** Trần số cụm: cắt theo ngưỡng ra nhiều hơn thì gộp tiếp tới mức này. */
  maxClusters?: number;
  /** Số tin tối thiểu (đếm tin, không đếm trọng số) để cụm thành `active`. */
  minMembers?: number;
  halfLifeDays?: number;
  /** Tin có trọng số nhỏ hơn mức này bị bỏ. */
  dropBelowWeight?: number;
  /** Các cụm của lần chạy trước, dùng để giữ tên. */
  previous?: readonly PreviousCluster[];
  /** Cosine tối thiểu để một cụm mới nhận tên cụm cũ. Bắt buộc khi có `previous`. */
  nameCarryMinCosine?: number;
};

export const DEFAULT_MAX_INTEREST_CLUSTERS = 6;
export const DEFAULT_MIN_CLUSTER_MEMBERS = 3;
export const DEFAULT_HALF_LIFE_DAYS = 60;
export const DEFAULT_DROP_BELOW_WEIGHT = 0.1;

/** Trọng số theo tuổi: nửa đời `halfLifeDays` ngày. Tuổi âm coi như 0. */
export function ageWeight(ageDays: number, halfLifeDays = DEFAULT_HALF_LIFE_DAYS): number {
  return 0.5 ** (Math.max(0, ageDays) / halfLifeDays);
}

function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  const na = Math.sqrt(dot(a, a));
  const nb = Math.sqrt(dot(b, b));
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Chiều cao Ward giữa hai cụm khối lượng mA, mB, tâm cách nhau `centerDist2` (bình phương):
 * sqrt(2·mA·mB/(mA+mB) · |cA−cB|²). Hai tin khối lượng 1 cho đúng khoảng cách Euclid giữa chúng
 * (cùng quy ước với scipy `linkage(method="ward")`). Dưới đây ta giữ bình phương chiều cao.
 */
function wardHeight2(mA: number, mB: number, centerDist2: number): number {
  return ((2 * mA * mB) / (mA + mB)) * centerDist2;
}

type Node = { members: number[]; mass: number };

function squaredDistance(a: readonly number[], b: readonly number[]): number {
  let d2 = 0;
  for (let t = 0; t < a.length; t++) {
    const diff = (a[t] as number) - (b[t] as number);
    d2 += diff * diff;
  }
  return d2;
}

/** Ma trận bình phương chiều cao Ward giữa mọi cặp tin. */
function initialHeights(
  vectors: readonly (readonly number[])[],
  masses: readonly number[],
): number[][] {
  const n = vectors.length;
  const h2: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d2 = squaredDistance(vectors[i] as readonly number[], vectors[j] as readonly number[]);
      const v = wardHeight2(masses[i] as number, masses[j] as number, d2);
      (h2[i] as number[])[j] = v;
      (h2[j] as number[])[i] = v;
    }
  }
  return h2;
}

/** Cặp cụm còn sống có chiều cao nhỏ nhất; hoà thì cặp (i, j) nhỏ nhất theo chỉ số. */
function closestPair(nodes: readonly (Node | null)[], h2: readonly number[][]) {
  let bi = -1;
  let bj = -1;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < nodes.length; i++) {
    if (!nodes[i]) continue;
    const row = h2[i] as number[];
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[j] && (row[j] as number) < best) {
        best = row[j] as number;
        bi = i;
        bj = j;
      }
    }
  }
  return { bi, bj, best };
}

/** Gộp cụm bj vào bi và cập nhật h2 theo Lance–Williams. */
function mergeNodes(nodes: (Node | null)[], h2: number[][], bi: number, bj: number, best: number) {
  const ni = nodes[bi] as Node;
  const nj = nodes[bj] as Node;
  for (let k = 0; k < nodes.length; k++) {
    const nk = nodes[k];
    if (!nk || k === bi || k === bj) continue;
    const mk = nk.mass;
    const row = h2[k] as number[];
    const v =
      ((mk + ni.mass) * (row[bi] as number) + (mk + nj.mass) * (row[bj] as number) - mk * best) /
      (ni.mass + nj.mass + mk);
    row[bi] = v;
    (h2[bi] as number[])[k] = v;
  }
  nodes[bi] = { members: [...ni.members, ...nj.members], mass: ni.mass + nj.mass };
  nodes[bj] = null;
}

/**
 * Ward có trọng số bằng công thức Lance–Williams trên bình phương chiều cao:
 * h²(k, i∪j) = ((mk+mi)·h²(k,i) + (mk+mj)·h²(k,j) − mk·h²(i,j)) / (mi+mj+mk).
 * Dừng khi chiều cao nhỏ nhất > τ và số cụm <= maxClusters. Hoà: cặp (i, j) nhỏ nhất theo chỉ số
 * (các tin đã sắp theo id nên kết quả không phụ thuộc thứ tự đầu vào).
 */
function wardCut(
  vectors: readonly (readonly number[])[],
  masses: readonly number[],
  threshold: number,
  maxClusters: number,
): number[][] {
  const nodes: (Node | null)[] = masses.map((m, i) => ({ members: [i], mass: m }));
  const h2 = initialHeights(vectors, masses);
  const limit2 = threshold * threshold;
  for (let alive = nodes.length; alive > 1; alive--) {
    const { bi, bj, best } = closestPair(nodes, h2);
    if (best > limit2 && alive <= maxClusters) break;
    mergeNodes(nodes, h2, bi, bj, best);
  }
  return nodes.filter((x): x is Node => x !== null).map((x) => x.members);
}

function carryNames(
  clusters: InterestCluster[],
  previous: readonly PreviousCluster[],
  minCos: number,
) {
  const pairs: { c: number; p: number; cos: number }[] = [];
  clusters.forEach((cl, c) => {
    if (cl.status !== "active") return;
    previous.forEach((pv, p) => {
      if (pv.name === null) return;
      const cos = cosine(cl.center, pv.center);
      if (cos >= minCos) pairs.push({ c, p, cos });
    });
  });
  // Tham lam theo cosine giảm dần; hoà thì theo chỉ số cụm mới rồi cụm cũ (xác định).
  pairs.sort((x, y) => y.cos - x.cos || x.c - y.c || x.p - y.p);
  const usedC = new Set<number>();
  const usedP = new Set<number>();
  for (const { c, p } of pairs) {
    if (usedC.has(c) || usedP.has(p)) continue;
    usedC.add(c);
    usedP.add(p);
    (clusters[c] as InterestCluster).name = (previous[p] as PreviousCluster).name;
  }
}

/**
 * Gom các tin 👍 thành cụm sở thích, từ đầu mỗi lần gọi. Trả về cả cụm `active` và `pending`,
 * sắp theo importance giảm dần, hoà thì theo id nhỏ nhất của thành viên.
 */
export function clusterInterests(
  items: readonly InterestItem[],
  opts: ClusterInterestsOptions,
): InterestCluster[] {
  const {
    distanceThreshold,
    maxClusters = DEFAULT_MAX_INTEREST_CLUSTERS,
    minMembers = DEFAULT_MIN_CLUSTER_MEMBERS,
    halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
    dropBelowWeight = DEFAULT_DROP_BELOW_WEIGHT,
    previous,
    nameCarryMinCosine,
  } = opts;
  if (!Number.isFinite(distanceThreshold) || distanceThreshold < 0) {
    throw new Error("distanceThreshold phải là số hữu hạn >= 0");
  }
  if (maxClusters < 1) throw new Error("maxClusters phải >= 1");
  if (previous && previous.length > 0 && nameCarryMinCosine === undefined) {
    throw new Error("có previous thì phải truyền nameCarryMinCosine");
  }

  const kept = items
    .map((it) => ({ ...it, weight: ageWeight(it.ageDays, halfLifeDays) }))
    .filter((it) => it.weight >= dropBelowWeight)
    .sort((a, b) => compareId(a.id, b.id));
  if (kept.length === 0) return [];
  const dim = (kept[0] as { vector: readonly number[] }).vector.length;
  for (const it of kept) {
    if (it.vector.length !== dim) throw new Error(`vector của tin ${it.id} sai số chiều`);
  }

  const groups = wardCut(
    kept.map((k) => k.vector),
    kept.map((k) => k.weight),
    distanceThreshold,
    maxClusters,
  );

  const clusters: InterestCluster[] = groups.map((idx) => {
    const members = [...idx].sort((a, b) => a - b); // chỉ số đã theo id
    const sum = new Array<number>(dim).fill(0);
    let importance = 0;
    for (const m of members) {
      const it = kept[m] as (typeof kept)[number];
      importance += it.weight;
      for (let t = 0; t < dim; t++)
        sum[t] = (sum[t] as number) + it.weight * (it.vector[t] as number);
    }
    const norm = Math.sqrt(dot(sum, sum));
    const center = norm === 0 ? sum : sum.map((x) => x / norm);
    let medoid = kept[members[0] as number] as (typeof kept)[number];
    let bestCos = Number.NEGATIVE_INFINITY;
    for (const m of members) {
      const it = kept[m] as (typeof kept)[number];
      const c = cosine(it.vector, center);
      if (c > bestCos) {
        bestCos = c;
        medoid = it;
      }
    }
    return {
      status: members.length >= minMembers ? "active" : "pending",
      name: null,
      center,
      importance,
      medoid: medoid.id,
      memberIds: members.map((m) => (kept[m] as (typeof kept)[number]).id),
    };
  });

  clusters.sort(
    (a, b) =>
      b.importance - a.importance || compareId(a.memberIds[0] as string, b.memberIds[0] as string),
  );

  if (previous && previous.length > 0) {
    carryNames(clusters, previous, nameCarryMinCosine as number);
  }
  return clusters;
}

/**
 * Điểm gu U của một vector tin: max trên cụm active của sqrt(π_k) · max(0, cos(vector, center_k)),
 * với π_k = I_k / I_max. Cosine âm kẹp về 0 để U nằm trong [0, 1]. Không có cụm active thì 0.
 */
export function interestScore(
  vector: readonly number[],
  clusters: readonly InterestCluster[],
): number {
  const active = clusters.filter((c) => c.status === "active");
  if (active.length === 0) return 0;
  const iMax = Math.max(...active.map((c) => c.importance));
  if (!(iMax > 0)) return 0;
  let best = 0;
  for (const c of active) {
    const s = Math.sqrt(c.importance / iMax) * Math.max(0, cosine(vector, c.center));
    if (s > best) best = s;
  }
  return best;
}
