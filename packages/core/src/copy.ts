/**
 * All NEW user-facing strings for the "Với tôi?" button (Telegram and web), gathered in one place for the owner to approve
 * wording (decision 11/11/2026: "the wording of both buttons and the Telegram message format are approved by the project owner").
 * Approved by the project owner (11/11/2026). Changing it here changes it everywhere.
 */
export const FOR_ME_LABELS = {
  /** Button label in the Telegram message. */
  button: "Với tôi?",
  /** Shown immediately on tap (while the model is writing). */
  working: "Đang viết…",
  /** Message does not belong to this profile's feed (or was not found). */
  notFound: "Không tìm thấy tin này",
  /** Daily quota used up. */
  limit: "Hôm nay bạn đã dùng hết lượt “Với tôi?”, mai thử lại nhé",
  /** Model not configured, or the model failed. */
  unavailable: "Chưa viết được lúc này, bạn thử lại sau nhé",
} as const;
