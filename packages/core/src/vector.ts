/**
 * Pure vector operations for filtering and merging. Kept in the core because it has no dependencies and can be tested on its own.
 */

export function norm(v: readonly number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

/** Cosine similarity in [-1, 1]. A zero vector gives 0 instead of NaN. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`khác số chiều: ${a.length} vs ${b.length}`);
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  const n = norm(a) * norm(b);
  return n === 0 ? 0 : dot / n;
}

/**
 * Center of a cluster after adding one vector to a cluster holding `count` elements: a running mean.
 * Avoids re-reading every document of the event on each merge.
 */
export function runningMean(centroid: readonly number[], count: number, v: readonly number[]) {
  return centroid.map((c, i) => c + ((v[i] ?? 0) - c) / (count + 1));
}
