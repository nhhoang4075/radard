/**
 * Biến thể cách chấm điểm. Thêm một biến thể = thêm một object (qua `defineVariant`); không sửa
 * bộ chấm.
 */
import { mulberry32 } from "./bootstrap.ts";
import { type EvalDay, type EvalSample, gainOf } from "./types.ts";

export interface Variant<P = undefined> {
  name: string;
  /**
   * Tuỳ chọn: học tham số trên các ngày huấn luyện. Bộ chấm chỉ đưa ngày thường, không bao giờ
   * đưa ngày khoá kín.
   */
  fit?: (trainDays: readonly EvalDay[]) => P;
  /** Điểm của một tin; cao hơn = xếp trước. `params` là kết quả `fit` (nếu có). */
  score: (item: EvalSample, params: P) => number;
}

/** Biến thể đã xoá kiểu tham số, để chung một danh sách. */
export interface AnyVariant {
  name: string;
  fit?: (trainDays: readonly EvalDay[]) => unknown;
  score: (item: EvalSample, params: unknown) => number;
}

export function defineVariant<P>(v: Variant<P>): AnyVariant {
  return v as unknown as AnyVariant;
}

/**
 * Trọng số của công thức hiện tại, SAO CHÉP cứng ở đây (không đọc `DEFAULT_RANK_CONFIG`): đổi
 * cấu hình thật không được làm baseline trôi.
 * S = N × (0,40·R + 0,25·P + 0,15·C + 0,10·A + 0,10·F).
 */
export const BASELINE_WEIGHTS = { R: 0.4, P: 0.25, C: 0.15, A: 0.1, F: 0.1 } as const;

export const baselineVariant = defineVariant({
  name: "baseline",
  score: ({ score: c }: EvalSample) =>
    c.N *
    (BASELINE_WEIGHTS.R * c.R +
      BASELINE_WEIGHTS.P * c.P +
      BASELINE_WEIGHTS.C * c.C +
      BASELINE_WEIGHTS.A * c.A +
      BASELINE_WEIGHTS.F * c.F),
});

/** Xếp đúng theo nhãn: NDCG phải = 1 ở mọi ngày. Kiểm tính đúng của bộ chấm, không phải đối thủ. */
export const oracleVariant = defineVariant({
  name: "oracle",
  score: (item: EvalSample) => gainOf(item),
});

/** Hạt giống của biến thể ngẫu nhiên. */
export const RANDOM_SEED = 7;

/** FNV-1a 32 bit của một chuỗi. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Điểm ngẫu nhiên có hạt giống, xác định theo (ngày, vị trí, url): làm sàn. */
export const randomVariant = defineVariant({
  name: "random",
  score: (item: EvalSample) =>
    mulberry32(hashString(`${RANDOM_SEED}|${item.date}|${item.position}|${item.urls.join(" ")}`))(),
});

/** Ba biến thể tham chiếu; baseline luôn đứng đầu. */
export const REFERENCE_VARIANTS: readonly AnyVariant[] = [
  baselineVariant,
  oracleVariant,
  randomVariant,
];
