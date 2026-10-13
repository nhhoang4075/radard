/**
 * Phép toán vector thuần cho lọc và gộp. Để ở lõi vì không phụ thuộc gì và test được riêng.
 */

export function norm(v: readonly number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

/** Cosine similarity trong [-1, 1]. Vector 0 cho 0 thay vì NaN. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`khác số chiều: ${a.length} vs ${b.length}`);
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  const n = norm(a) * norm(b);
  return n === 0 ? 0 : dot / n;
}

/**
 * Tâm cụm mới khi thêm một vector vào cụm đang có `count` phần tử: trung bình cộng dồn.
 * Không phải đọc lại mọi tài liệu của sự kiện mỗi lần gộp thêm.
 */
export function runningMean(centroid: readonly number[], count: number, v: readonly number[]) {
  return centroid.map((c, i) => c + ((v[i] ?? 0) - c) / (count + 1));
}
