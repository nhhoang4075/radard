/**
 * arXiv qua API Atom (`export.arxiv.org/api/query`), lấy bài mới theo thể loại.
 *
 * Luật của arXiv: mỗi request cách nhau ≥ 3 giây (đặt ở HttpClient theo host), và bài mới
 * được công bố một đợt mỗi ngày, nên nguồn này chỉ cần chạy ngày một lần.
 *
 * BẪY đã gặp (28/09/2026): `published` là lúc tác giả NỘP bài, nhưng bài chỉ hiện trong API
 * sau khi arXiv CÔNG BỐ, trễ 1–3 ngày (cuối tuần không công bố). Con trỏ "chỉ lấy bài mới hơn
 * lần trước" sẽ bỏ sót vĩnh viễn bài công bố muộn. Nên mỗi lượt đọc lại cả một cửa sổ
 * `lookbackDays` tính lùi từ con trỏ; bài đã có thì khoá (source_id, external_id) bỏ đi.
 * 5 ngày ≈ 950 bài cho cs.CL/AI/LG/MA, khoảng 5 trang, ~15 giây.
 *
 * Lấy theo cửa sổ `submittedDate` (độ chính xác phút), mỗi cửa sổ không quá 2.000 bài, đi
 * tiến tới hiện tại; con trỏ chỉ dời tới cuối cửa sổ đã lấy đủ (xem `walkWindows`). Trước
 * 06/10/2026 adapter lấy "2.000 bài mới nhất" rồi dời con trỏ lên bài mới nhất: daemon tắt
 * lâu thì phần cũ hơn bị bỏ vĩnh viễn.
 *
 * Bản thô là đúng khối `<entry>…</entry>` trong phản hồi, không phải JSON đã parse: giữ
 * nguyên văn để job process đọc lại được mọi trường, kể cả trường hôm nay chưa dùng.
 */
import { type RawItem, type SourceAdapter, walkWindows } from "@radard/core";
import { XMLParser } from "fast-xml-parser";

export interface ArxivConfig {
  /** Ví dụ `["cs.CL", "cs.AI"]`. */
  categories: string[];
  /** Đọc lại bao nhiêu ngày tính lùi từ con trỏ (lần đầu: từ bây giờ). Mặc định 5. */
  lookbackDays?: number;
  /** Trần số bài mỗi lượt khi bắt kịp sau thời gian tắt (mỗi 200 bài một request, cách 3 giây). */
  maxPerRun?: number;
}

export interface ArxivState {
  /** Mọi bài nộp (`published`) tới mốc này đã được đọc đủ (ISO). Lượt sau đọc lùi từ đây. */
  lastPublished: string;
}

const API = "https://export.arxiv.org/api/query";
const PAGE_SIZE = 200;
const WINDOW_CAP = 2000;
const DEFAULT_MAX = 10_000;
const MINUTE = 60_000;

/** Phút Unix → `YYYYMMDDHHMM` (giờ GMT) cho `submittedDate:[… TO …]`. */
export function arxivMinute(min: number): string {
  return new Date(min * MINUTE).toISOString().slice(0, 16).replace(/[-T:]/g, "");
}

export function totalResults(feed: string): number {
  const m = /<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/.exec(feed);
  return m ? Number(m[1]) : 0;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => name === "author" || name === "category" || name === "link",
});

interface ParsedEntry {
  id: string;
  title: string;
  summary: string;
  published: string;
  updated: string;
  author?: Array<{ name: string }>;
  category?: Array<{ term: string }>;
  "arxiv:primary_category"?: { term: string };
  link?: Array<{ href: string; title?: string; rel?: string }>;
}

/** `http://arxiv.org/abs/2609.31619v2` → `{ id: "2609.31619", version: "v2" }`. */
export function parseArxivId(raw: string): { id: string; version: string | null } {
  const tail = raw.split("/abs/")[1] ?? raw;
  const m = /^(.*?)(v\d+)?$/.exec(tail.trim());
  return { id: m?.[1] ?? tail, version: m?.[2] ?? null };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function entryToItem(rawEntry: string): RawItem & { publishedIso: string } {
  const e = (parser.parse(rawEntry) as { entry: ParsedEntry }).entry;
  const { id, version } = parseArxivId(e.id);
  const pdf = e.link?.find((l) => l.title === "pdf")?.href;
  return {
    externalId: id,
    // Không kèm phiên bản: bài sửa (v2, v3) vẫn là cùng một bài.
    url: `https://arxiv.org/abs/${id}`,
    title: oneLine(e.title),
    publishedAt: new Date(e.published),
    publishedIso: e.published,
    body: rawEntry,
    contentType: "application/atom+xml",
    meta: {
      version,
      updated: e.updated,
      authors: (e.author ?? []).slice(0, 20).map((a) => a.name),
      nAuthors: e.author?.length ?? 0,
      categories: (e.category ?? []).map((c) => c.term),
      primaryCategory: e["arxiv:primary_category"]?.term,
      pdfUrl: pdf,
    },
  };
}

export function splitEntries(feed: string): string[] {
  return feed.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
}

export const arxivSource: SourceAdapter<ArxivConfig, ArxivState> = {
  kind: "arxiv",
  toText(body) {
    const e = (parser.parse(body) as { entry: ParsedEntry }).entry;
    return `${oneLine(e.title)}\n${oneLine(e.summary)}`;
  },
  async fetch({ config, state, http, now }) {
    const from = state ? new Date(state.lastPublished).getTime() : now.getTime();
    const start = Math.floor((from - (config.lookbackDays ?? 5) * 86_400_000) / MINUTE);
    const cats = config.categories.map((c) => `cat:${c}`).join(" OR ");

    const page = async (lo: number, hi: number, offset: number) => {
      const params = new URLSearchParams({
        search_query: `(${cats}) AND submittedDate:[${arxivMinute(lo)} TO ${arxivMinute(hi)}]`,
        sortBy: "submittedDate",
        sortOrder: "ascending",
        start: String(offset),
        max_results: String(PAGE_SIZE),
      });
      return (await http.get(`${API}?${params}`, { timeoutMs: 60_000 })).body;
    };
    const walked = await walkWindows<string, RawItem>({
      start,
      end: Math.floor(now.getTime() / MINUTE),
      cap: WINDOW_CAP,
      budget: config.maxPerRun ?? DEFAULT_MAX,
      count: async (lo, hi) => {
        const first = await page(lo, hi, 0);
        return { total: totalResults(first), first };
      },
      fetchAll: async (lo, hi, first) => {
        const total = totalResults(first);
        const raws = splitEntries(first);
        for (let off = PAGE_SIZE; off < total; off += PAGE_SIZE) {
          raws.push(...splitEntries(await page(lo, hi, off)));
        }
        return raws.map((raw) => {
          const { publishedIso: _, ...item } = entryToItem(raw);
          return item;
        });
      },
    });
    // Không lùi con trỏ (cửa sổ bắt đầu lùi 5 ngày, nên coveredUntil chưa chắc đã vượt mốc cũ).
    const covered = Math.max(walked.coveredUntil * MINUTE, state ? from : 0);
    return {
      items: walked.items,
      state: { lastPublished: new Date(covered).toISOString() },
      httpStatus: 200,
      behind: walked.behind,
    };
  },
};
