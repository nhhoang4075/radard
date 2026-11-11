/**
 * Source interface. The core only knows this type; each source (HN, arXiv, GitHub…) is an adapter.
 *
 * A source's state (cursor, ETag…) is `unknown` to the core: the adapter reads it itself and returns the
 * new state. This way adding a source type needs no schema change.
 */
import type { HttpClient } from "./http.ts";

/** A raw item fetched from the source, before any processing. */
export interface RawItem {
  /** Id on the source side. Together with source_id it is the idempotent key of `documents`. */
  externalId: string;
  url: string;
  title?: string;
  publishedAt?: Date;
  /** Original content exactly as received (JSON, HTML, XML). Stored unchanged in ObjectStore. */
  body: string;
  contentType: string;
  /** A few convenience fields for lookup without opening the raw item (score, author…). */
  meta?: Record<string, unknown>;
}

export interface FetchContext<C, S> {
  config: C;
  /** `undefined` on the first run. */
  state: S | undefined;
  http: HttpClient;
  now: Date;
}

export interface FetchResult<S> {
  items: RawItem[];
  /** State for the next run to resume from. Only saved when the run succeeds. */
  state: S;
  /** Server returned 304: nothing new, not an error. */
  notModified?: boolean;
  httpStatus?: number;
  /**
   * This run stops before catching up to now (budget exhausted, or an error after a few
   * windows). `items` and `state` only include what was fully fetched; the next run resumes there. Records the reason.
   */
  behind?: string;
  /**
   * GitHub repo measurements readable in this run (the Trending page has total stars and "N stars today" for
   * every repo on the page, including repos already stored as documents). The fetch job writes directly to `repo_stats`
   * (append only), since `documents` keeps only one row per repo. Other sources do not declare this.
   */
  repoStats?: RepoObservation[];
}

/** One GitHub repo measurement; see `repo_stats` in @radard/db. */
export interface RepoObservation {
  /** `owner/repo`; the fetch job lowercases it itself. */
  repo: string;
  stars: number;
  forks: number | null;
  source: "github_stars" | "trending_daily";
  /** Increase reported by the source itself ("N stars today"); `null` when radard captured it itself. */
  reportedGain: number | null;
}

/**
 * Moves forward through time windows (lo, hi], each window returning at most `cap` results (the API's
 * pagination limit), up to `end`. The cursor only advances to the end of a FULLY fetched window, so there is never a gap:
 * if the daemon is off for a long time, later runs gradually fill it in, and no item is lost.
 *
 * `count(lo, hi)` returns the total number of results in the window (with the first page included to avoid a re-call), `fetchAll`
 * fetches the whole window. Times are integers in the source's unit (seconds, minutes…).
 */
export async function walkWindows<P, T>(opts: {
  start: number;
  end: number;
  cap: number;
  budget: number;
  count: (lo: number, hi: number) => Promise<{ total: number; first: P }>;
  fetchAll: (lo: number, hi: number, first: P) => Promise<T[]>;
}): Promise<{ items: T[]; coveredUntil: number; behind?: string }> {
  const items: T[] = [];
  let lo = opts.start;
  let span = Math.max(1, opts.end - lo);
  while (lo < opts.end) {
    if (items.length >= opts.budget) {
      return { items, coveredUntil: lo, behind: `hết ngân sách ${opts.budget} mục mỗi lượt` };
    }
    const hi = Math.min(opts.end, lo + span);
    let page: { total: number; first: P };
    try {
      page = await opts.count(lo, hi);
      if (page.total > opts.cap && hi - lo > 1) {
        // Window too full: halve it and ask again.
        span = Math.max(1, Math.floor((hi - lo) / 2));
        continue;
      }
      items.push(...(await opts.fetchAll(lo, hi, page.first)));
    } catch (err) {
      // If no window finished, report the error as before; if some windows finished, keep what was obtained.
      if (lo === opts.start) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      return { items, coveredUntil: lo, behind: `lỗi giữa chừng: ${msg}`.slice(0, 500) };
    }
    lo = hi;
    span *= 2;
  }
  return { items, coveredUntil: lo };
}

export interface SourceAdapter<C = unknown, S = unknown> {
  readonly kind: string;
  fetch(ctx: FetchContext<C, S>): Promise<FetchResult<S>>;
  /**
   * Extracts the text to embed from the raw item of THIS source (called by the process job). If absent, the process job
   * uses the title. Placed next to `fetch` because only the adapter knows how its raw item is structured.
   */
  toText?(body: string, title: string | null): string;
  /**
   * Re-fetches the LATEST community signals (score, comments…) of the documents, by `externalId`.
   * Called right before ranking: the count stored when the item was fetched is almost always from the moment it was posted. Returns a map
   * externalId → { signal name: value }; documents no longer on the source are absent.
   */
  refreshSignals?(externalIds: string[], http: HttpClient): Promise<Map<string, Signals>>;
  /**
   * Community interest in ONE document, from its signals, in ADDITIVE form: documents from the same
   * source in one event are summed, and only then is ln taken (xep-hang.html tab 04). A source without
   * signals does not declare this function: the formula uses neutral engagement.
   */
  engagement?(signals: Signals): number | null;
  /**
   * The document's discussion page (HN comments…), different from the original post at `url`. The digest shows it as a
   * "Discussion" link. If there is no separate discussion page (or `url` already is that page), `null`;
   * a source without discussions does not declare this function.
   */
  discussionUrl?(externalId: string, url: string): string | null;
  /**
   * The page holding the document's CONTENT, when the source's raw item only has a title and link (an HN post is usually
   * a link to a blog, GitHub or a news site). The `pages` job fetches this page, and the process job embeds the title together with
   * the page's main text. `null`: the content is already in the raw item (Ask HN). A source that already has its content
   * (arXiv has an abstract, GitHub has release notes) does not declare this function.
   */
  articleUrl?(externalId: string, url: string): string | null;
}

/** Signals of a document: name set by the adapter (`hn_points`…) → value. */
export type Signals = Record<string, number>;
