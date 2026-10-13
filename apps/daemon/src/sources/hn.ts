/**
 * Hacker News qua API Algolia (`search_by_date`), lấy mọi story mới từ lần chạy trước.
 *
 * Lấy hết chứ không lọc theo từ khoá ở đây: lọc là việc của job process (embedding), và lọc sớm
 * bằng từ khoá sẽ bỏ sót những bài về AI mà tiêu đề không chứa từ nào trong danh sách.
 * Khoảng 30 story mỗi giờ, nên lưu hết vẫn rẻ.
 */
import { type RawItem, type Signals, type SourceAdapter, walkWindows } from "@radard/core";

export interface HnConfig {
  /** Lần chạy đầu lấy lùi bao nhiêu giờ. */
  backfillHours?: number;
  /** `story` (mặc định), hoặc `show_hn`, `ask_hn`… theo tag của Algolia. */
  tag?: string;
  /** Trần số story mỗi lượt khi bắt kịp sau thời gian tắt. Mặc định 10.000 (~100 request). */
  maxPerRun?: number;
}

export interface HnState {
  /**
   * Mọi story có `created_at_i` tới mốc này (giây Unix) đã được lấy đủ. KHÔNG phải "story
   * mới nhất đã thấy": con trỏ kiểu đó nhảy qua lỗ hổng khi một lượt chạm giới hạn 1.000
   * kết quả (đã mất 7.367 story khi daemon tắt 28/09–06/10).
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
/** Lấy lại điểm theo lô id: `tags=story,(story_1,story_2,…)`, 50 id mỗi request. */
export const SIGNAL_BATCH = 50;
const PAGE_SIZE = 100;
/** Algolia chỉ cho phân trang tới 1.000 kết quả mỗi truy vấn: cửa sổ nào nhiều hơn thì thu hẹp. */
const WINDOW_CAP = 1000;
const DEFAULT_MAX = 10_000;
/**
 * Lùi con trỏ một chút: story đăng sát lúc lượt trước chạy có thể chưa kịp vào index của
 * Algolia. Trùng thì khoá (source_id, external_id) tự bỏ.
 */
const OVERLAP_SECONDS = 300;

export function hnItemUrl(id: string): string {
  return `https://news.ycombinator.com/item?id=${id}`;
}

export function hitToItem(hit: HnHit): RawItem {
  const discussion = hnItemUrl(hit.objectID);
  return {
    externalId: hit.objectID,
    // Ask HN không có link ngoài: lấy chính trang thảo luận.
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

/** Bỏ thẻ HTML và giải mã vài thực thể thường gặp trong `story_text` của Ask/Show HN. */
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

/** URL lấy lại điểm và bình luận mới nhất cho một lô story id. */
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
   * Điểm + 0,5 × bình luận. Bình luận là tín hiệu "đang được bàn", khác "thấy hay", nhưng dễ bị
   * thổi phồng bởi tranh cãi, nên chỉ tính nửa (xep-hang.html tab 02).
   */
  engagement(s) {
    return (s.hn_points ?? 0) + 0.5 * (s.hn_comments ?? 0);
  },
  discussionUrl(externalId, url) {
    const item = hnItemUrl(externalId);
    // Ask HN: bài gốc đã là trang thảo luận.
    return url === item ? null : item;
  },
  articleUrl(externalId, url) {
    // 13/10/2026: 91,5% bài HN chỉ có tiêu đề để embed; nội dung nằm ở trang được link tới.
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
    // Không lùi con trỏ: lượt đầu không có gì thì giữ mốc cũ (hoặc mốc bắt đầu).
    const covered = Math.max(walked.coveredUntil, state?.lastCreatedAt ?? start);
    return {
      items: walked.items,
      state: { lastCreatedAt: covered },
      httpStatus: 200,
      behind: walked.behind,
    };
  },
};
