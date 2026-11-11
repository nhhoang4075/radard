// Pure core of the taste score U: groups 👍 items into a few interest "centers", then scores how well an item fits.
// No DB, no model calls, no env reads, no randomness: the same input always gives the same output.
//
// TODO(spec: 👎 clusters after ~30 👎): clusters are not built for 👎 items yet; this function only accepts 👍 items.

export type InterestItem = {
  id: string;
  /** Vector of the whole document, L2-normalized. */
  vector: readonly number[];
  ageDays: number;
};

export type PreviousCluster = { name: string | null; center: readonly number[] };

export type InterestCluster = {
  /** `active` (>= minMembers items) counts toward U; `pending` (waiting) does not. */
  status: "active" | "pending";
  /** Name carried from the previous run; null if none. Only active clusters receive a name. */
  name: string | null;
  /** Weighted mean of the member vectors, then L2-normalized. */
  center: number[];
  /** I_k: total age-weighted weight of the items in the cluster. */
  importance: number;
  /** Id of the item closest to `center` (cosine), so the project owner can see what the cluster is. */
  medoid: string;
  /** Member ids, sorted ascending. */
  memberIds: string[];
};

export type ClusterInterestsOptions = {
  /** Tree cut threshold on the Ward height (see `wardHeight`). REQUIRED, no default. */
  distanceThreshold: number;
  /** Cluster cap: if the threshold cut yields more, keep merging until this count. */
  maxClusters?: number;
  /** Minimum number of items (counted, not weighted) for a cluster to become `active`. */
  minMembers?: number;
  halfLifeDays?: number;
  /** Items with weight below this are dropped. */
  dropBelowWeight?: number;
  /** Clusters from the previous run, used to keep names. */
  previous?: readonly PreviousCluster[];
  /** Minimum cosine for a new cluster to inherit an old cluster's name. Required when `previous` is given. */
  nameCarryMinCosine?: number;
};

export const DEFAULT_MAX_INTEREST_CLUSTERS = 6;
export const DEFAULT_MIN_CLUSTER_MEMBERS = 3;
export const DEFAULT_HALF_LIFE_DAYS = 60;
export const DEFAULT_DROP_BELOW_WEIGHT = 0.1;

/** Age weight: half-life `halfLifeDays` days. A negative age counts as 0. */
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
 * Ward height between two clusters with masses mA, mB and centers `centerDist2` apart (squared):
 * sqrt(2·mA·mB/(mA+mB) · |cA−cB|²). Two items of mass 1 give exactly the Euclidean distance between them
 * (same convention as scipy `linkage(method="ward")`). Below we keep the squared height.
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

/** Matrix of squared Ward heights between every pair of items. */
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

/** The live cluster pair with the smallest height; on a tie, the pair (i, j) with the smallest indices. */
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

/** Merge cluster bj into bi and update h2 by Lance–Williams. */
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
 * Weighted Ward via the Lance–Williams formula on squared heights:
 * h²(k, i∪j) = ((mk+mi)·h²(k,i) + (mk+mj)·h²(k,j) − mk·h²(i,j)) / (mi+mj+mk).
 * Stop when the smallest height > τ and the cluster count <= maxClusters. Ties: the pair (i, j) with the smallest indices
 * (items are sorted by id, so the result does not depend on input order).
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
  // Greedy by descending cosine; ties by new cluster index, then old one (deterministic).
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
 * Groups 👍 items into interest clusters, rebuilt from scratch on every call. Returns both `active` and `pending` clusters,
 * sorted by importance descending, ties by the smallest member id.
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
    const members = [...idx].sort((a, b) => a - b); // indices are already in id order
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
 * Taste score U of an item vector: max over active clusters of sqrt(π_k) · max(0, cos(vector, center_k)),
 * with π_k = I_k / I_max. Negative cosines are clamped to 0 so U lies in [0, 1]. With no active cluster, 0.
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
