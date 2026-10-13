/**
 * Trang web được tài liệu link tới (bài HN → blog, GitHub, báo). Lõi chỉ biết các kiểu này; tải
 * trang (kèm robots.txt) và rút phần chữ chính là adapter (`@radard/adapters/pages`).
 */

/**
 * ok: tải được HTML · blocked: robots.txt không cho bot tải · skipped: không phải trang HTML
 * (PDF, ảnh, video) · failed: lỗi HTTP (401/403 trang trả phí…) hoặc lỗi mạng.
 */
export type PageStatus = "ok" | "blocked" | "skipped" | "failed";

export interface PageFetchResult {
  status: PageStatus;
  httpStatus?: number;
  contentType?: string;
  /** Địa chỉ sau redirect. */
  finalUrl?: string;
  /** Chỉ có khi `ok`. */
  html?: string;
  error?: string;
}

export interface PageFetcher {
  fetch(url: string): Promise<PageFetchResult>;
}

/** Phần chữ chính của trang (bỏ menu, quảng cáo, chân trang); `null` khi không rút được gì đáng kể. */
export type PageExtractor = (html: string, url: string) => string | null;
