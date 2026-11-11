/**
 * Mọi chuỗi MỚI người dùng thấy ở nút "Với tôi?" (Telegram và web), gom một chỗ để chủ dự án duyệt
 * câu chữ (quyết định 11/11/2026: "câu chữ của hai nút và định dạng tin Telegram chủ dự án duyệt").
 * TẠM, CHƯA DUYỆT: đổi ở đây là đổi mọi nơi.
 */
export const FOR_ME_LABELS = {
  /** Nhãn nút trong tin Telegram. */
  button: "Với tôi?",
  /** Hiện ngay khi bấm (trong lúc model viết). */
  working: "Đang viết…",
  /** Tin không thuộc feed của hồ sơ này (hoặc không tìm thấy). */
  notFound: "Không tìm thấy tin này",
  /** Hết hạn mức ngày. */
  limit: "Hôm nay bạn đã dùng hết lượt “Với tôi?”, mai thử lại nhé",
  /** Chưa cấu hình model hoặc model lỗi. */
  unavailable: "Chưa viết được lúc này, bạn thử lại sau nhé",
} as const;
