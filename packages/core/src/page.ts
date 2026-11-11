/**
 * Web pages linked from documents (HN post → blog, GitHub, news). The core only knows these types; fetching
 * pages (including robots.txt) and extracting the main text are adapters (`@radard/adapters/pages`).
 */

/**
 * ok: HTML fetched · blocked: robots.txt does not let the bot fetch it · skipped: not an HTML page
 * (PDF, image, video) · failed: HTTP error (401/403 paywalled pages…) or network error · deferred: not decided yet
 * because robots.txt could not be read (5xx or unreachable, RFC 9309); NOT a state
 * stored in the DB: the job writes no row, so the next run retries it.
 */
export type PageStatus = "ok" | "blocked" | "skipped" | "failed" | "deferred";

export interface PageFetchResult {
  status: PageStatus;
  httpStatus?: number;
  contentType?: string;
  /** Address after redirects. */
  finalUrl?: string;
  /** Only present when `ok`. */
  html?: string;
  error?: string;
}

export interface PageFetcher {
  fetch(url: string): Promise<PageFetchResult>;
  /** Number of hosts currently in the robots.txt cache (for memory monitoring). */
  robotsCacheSize?(): number;
}

/** Main text of the page (menus, ads, footers removed); `null` when nothing significant can be extracted. */
export type PageExtractor = (html: string, url: string) => string | null;
