/**
 * Bộ chấm bất biến (a): kiểu dữ liệu. Phát lại các ngày đã gửi, chấm lại thứ tự tin bằng các
 * thành phần điểm đã lưu lúc chọn và nhãn 👍/👎; không gọi model, không đọc DB.
 */

/** Mức nhãn của một tin: 👍, chưa bấm (cũng là một mức), 👎. */
export type Level = "like" | "none" | "dislike";

/**
 * Gain của từng mức (chốt: 👍 = 2, chưa bấm = 1, 👎 = 0). Đổi ở ĐÂY nếu sau này muốn khác; mọi
 * chỉ số đọc từ bảng này.
 */
export const GAIN: Readonly<Record<Level, number>> = { like: 2, none: 1, dislike: 0 };

/** Các thành phần điểm lưu trong `digests.meta.plan.items[].score` lúc chọn. */
export interface StoredScore {
  S: number;
  penalty: number;
  R: number;
  P: number;
  C: number;
  A: number;
  F: number;
  N: number;
}

/** Một tin đã gửi trong một ngày. */
export interface EvalSample {
  /** Ngày (YYYY-MM-DD, giờ Việt Nam) của digest chứa tin. */
  date: string;
  /** Vị trí trong digest (1…7). Dùng để phá hoà một cách xác định. */
  position: number;
  /** `url_canonical` của các tài liệu trong sự kiện: khoá bền của nhãn (event_id đổi khi dựng lại). */
  urls: string[];
  level: Level;
  score: StoredScore;
}

/** Mọi tin đã gửi trong một ngày (tối đa 7). */
export interface EvalDay {
  date: string;
  samples: EvalSample[];
}

export const gainOf = (s: Pick<EvalSample, "level">): number => GAIN[s.level];

/** Ngày không có gì để phân biệt (mọi tin cùng mức): không đo được thứ tự nên bị loại khỏi trung bình. */
export function isInformative(day: EvalDay): boolean {
  const first = day.samples[0];
  if (!first) return false;
  return day.samples.some((s) => s.level !== first.level);
}
