/**
 * Sàn điểm theo phân vị (duyệt 10/11/2026): sàn = phân vị q của điểm S các sự kiện qua cổng trong
 * 30 ngày trước, với q = 1 − 12/n (n = số sự kiện qua cổng trung bình mỗi ngày), để khoảng 12
 * tin/ngày vượt sàn; ngày không nổi bật thì ít tin hơn. Chưa đủ 14 ngày dữ liệu thì dùng sàn cố định.
 * Lưu ý (10/11/2026): S trong bể trước khi có điểm gu U theo công thức cũ (không có U, hệ số ×1,0),
 * sau đó theo công thức mới (0,9× + 0,10·U); cửa sổ 30 ngày pha trộn hai thang, không sửa dữ liệu cũ.
 * Hàm thuần: việc đọc bể và lọc dòng ở `apps/daemon/src/jobs/rank.ts`.
 */
import { percentileCont } from "./ranking.ts";

/** Số tin mỗi ngày mà sàn nhắm tới. */
export const FLOOR_TARGET_PER_DAY = 12;
/** Cửa sổ lấy điểm: [end − 30 ngày, end). */
export const FLOOR_WINDOW_DAYS = 30;
/** Số ngày có dữ liệu tối thiểu để dùng phân vị; dưới mức này dùng sàn cố định. */
export const FLOOR_MIN_DAYS = 14;
/** Kẹp q vào [0, 0,99]. n ≤ 12 cho q ≤ 0 (sàn = điểm thấp nhất, không lọc thêm); 0,99 chặn q → 1. */
export const FLOOR_MAX_Q = 0.99;

export type FloorSource = "percentile" | "fixed";

export interface FloorResult {
  value: number;
  source: FloorSource;
  /** Chỉ có khi nguồn là phân vị. */
  q?: number;
  /** Số sự kiện qua cổng trung bình mỗi ngày; chỉ có khi nguồn là phân vị. */
  n?: number;
  /** Số ngày có dữ liệu trong cửa sổ. */
  days: number;
}

/**
 * @param scores điểm S (chưa trừ phạt) của các sự kiện qua cổng trong cửa sổ, đã bỏ tin đã gửi
 * @param days số ngày khác nhau có dữ liệu trong cửa sổ
 * @param fixed sàn cố định, dùng khi chưa đủ ngày hoặc không có điểm nào
 */
export function percentileFloor(args: {
  scores: readonly number[];
  days: number;
  fixed: number;
  minDays?: number;
  targetPerDay?: number;
  maxQ?: number;
}): FloorResult {
  const { scores, days, fixed } = args;
  const minDays = args.minDays ?? FLOOR_MIN_DAYS;
  if (days < minDays || scores.length === 0) return { value: fixed, source: "fixed", days };
  const n = scores.length / days;
  const target = args.targetPerDay ?? FLOOR_TARGET_PER_DAY;
  const q = Math.min(Math.max(1 - target / n, 0), args.maxQ ?? FLOOR_MAX_Q);
  const sorted = [...scores].sort((a, b) => a - b);
  return { value: percentileCont(sorted, q), source: "percentile", q, n, days };
}
