/**
 * Hacker News via the Algolia API (`search_by_date`), fetching every new story since the last run.
 *
 * Fetch everything here without keyword filtering: filtering is the job of the process job (embedding), and filtering early
 * by keyword would drop AI stories whose titles contain none of the listed words.
 * About 30 stories per hour, so storing them all is still cheap.
 */
import { type RawItem, type Signals, type SourceAdapter, walkWindows } from "@radard/core";

export interface HnConfig {
  /** How many hours back the first run looks. */
  backfillHours?: number;
  /** `story` (default), or `show_hn`, `ask_hn`… by Algolia tag. */
  tag?: string;
  /** Upper bound on stories per run when catching up after downtime. Default 10.000 (~100 requests). */
  maxPerRun?: number;
}

export interface HnState {
  /**
   * Every story with `created_at_i` up to this mark (Unix seconds) has been fully fetched. NOT "the latest
   * story seen": a cursor like that skips gaps when a run hits the 1.000-result limit
   * (7.367 stories were lost while the daemon was down, 28/09–06/10).
   */
  lastCreatedAt: number;
}

interface HnHit {
  objectID: string;
  title?: string | null;
  url?: string | null;
  author?: string;
  points?: number | null;
  num_comments?: number | null;
  created_at_i: number;
  story_text?: string | null;
}

interface HnSearch {
  hits: HnHit[];
  nbHits: number;
  nbPages: number;
  page: number;
}

const API = "https://hn.algolia.com/api/v1/search_by_date";
const SEARCH_API = "https://hn.algolia.com/api/v1/search";
/** Re-fetches points for a batch of ids: `tags=story,(story_1,story_2,…)`, 50 ids per request. */
export const SIGNAL_BATCH = 50;
const PAGE_SIZE = 100;
/** Algolia pages through at most 1.000 results per query: a window with more is split into smaller ones. */
const WINDOW_CAP = 1000;
const DEFAULT_MAX = 10_000;
/**
 * Move the cursor back a bit: a story posted just before the previous run may not yet be in the
 * Algolia index. Duplicates are dropped by the (source_id, external_id) key.
 */
const OVERLAP_SECONDS = 300;

export function hnItemUrl(id: string): string {
  return `https://news.ycombinator.com/item?id=${id}`;
}

export function hitToItem(hit: HnHit): RawItem {
  const discussion = hnItemUrl(hit.objectID);
  return {
    externalId: hit.objectID,
    // Ask HN has no external link: use the discussion page itself.
    url: hit.url || discussion,
    title: hit.title ?? undefined,
    publishedAt: new Date(hit.created_at_i * 1000),
    body: JSON.stringify(hit),
    contentType: "application/json",
    meta: {
      author: hit.author,
      points: hit.points ?? 0,
      comments: hit.num_comments ?? 0,
      discussionUrl: discussion,
    },
  };
}

/** Strips HTML tags and decodes a few common entities in the `story_text` of Ask/Show HN. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** URL that re-fetches points and the latest comments for a batch of story ids. */
export function signalsUrl(ids: string[]): string {
  const params = new URLSearchParams({
    tags: `story,(${ids.map((id) => `story_${id}`).join(",")})`,
    hitsPerPage: String(ids.length),
  });
  return `${SEARCH_API}?${params}`;
}

export const hnSource: SourceAdapter<HnConfig, HnState> = {
  kind: "hn",
  async refreshSignals(externalIds, http) {
    const out = new Map<string, Signals>();
    for (let i = 0; i < externalIds.length; i += SIGNAL_BATCH) {
      const ids = externalIds.slice(i, i + SIGNAL_BATCH);
      const res = JSON.parse((await http.get(signalsUrl(ids))).body) as HnSearch;
      for (const hit of res.hits) {
        out.set(hit.objectID, {
          hn_points: hit.points ?? 0,
          hn_comments: hit.num_comments ?? 0,
        });
      }
    }
    return out;
  },
  /**
   * Points + 0.5 × comments. Comments signal that a story is "being discussed", which differs from "found it good", but
   * they can be inflated by controversy, so only half counts (xep-hang.html tab 02).
   */
  engagement(s) {
    return (s.hn_points ?? 0) + 0.5 * (s.hn_comments ?? 0);
  },
  discussionUrl(externalId, url) {
    const item = hnItemUrl(externalId);
    // Ask HN: the original post is already the discussion page.
    return url === item ? null : item;
  },
  articleUrl(externalId, url) {
    // 13/10/2026: 91.5% of HN stories have only a title to embed; the content is on the linked page.
    return url === hnItemUrl(externalId) ? null : url;
  },
  toText(body, title) {
    const hit = JSON.parse(body) as HnHit;
    return [hit.title ?? title ?? "", stripHtml(hit.story_text ?? "")].filter(Boolean).join("\n");
  },
  async fetch({ config, state, http, now }) {
    const nowSec = Math.floor(now.getTime() / 1000);
    const start =
      state?.lastCreatedAt !== undefined
        ? state.lastCreatedAt - OVERLAP_SECONDS
        : nowSec - (config.backfillHours ?? 24) * 3600;

    const page = async (lo: number, hi: number, n: number) => {
      const params = new URLSearchParams({
        tags: config.tag ?? "story",
        numericFilters: `created_at_i>${lo},created_at_i<=${hi}`,
        hitsPerPage: String(PAGE_SIZE),
        page: String(n),
      });
      const res = await http.get(`${API}?${params}`);
      return JSON.parse(res.body) as HnSearch;
    };
    const walked = await walkWindows<HnSearch, RawItem>({
      start,
      end: nowSec,
      cap: WINDOW_CAP,
      budget: config.maxPerRun ?? DEFAULT_MAX,
      count: async (lo, hi) => {
        const first = await page(lo, hi, 0);
        return { total: first.nbHits, first };
      },
      fetchAll: async (lo, hi, first) => {
        const hits = [...first.hits];
        for (let n = 1; n < first.nbPages; n++) hits.push(...(await page(lo, hi, n)).hits);
        return hits.map(hitToItem);
      },
    });
    // Do not move the cursor: if the first run finds nothing, keep the old mark (or the start mark).
    const covered = Math.max(walked.coveredUntil, state?.lastCreatedAt ?? start);
    return {
      items: walked.items,
      state: { lastCreatedAt: covered },
      httpStatus: 200,
      behind: walked.behind,
    };
  },
};
