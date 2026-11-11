/**
 * arXiv via the Atom API (`export.arxiv.org/api/query`), fetching new papers by category.
 *
 * arXiv rule: each request must be at least 3 seconds apart (set in HttpClient per host), and new papers
 * are published once a day, so this source only needs to run once a day.
 *
 * PITFALL hit (28/09/2026): `published` is when the author SUBMITTED the paper, but it only appears in the API
 * after arXiv PUBLISHES it, 1–3 days later (nothing is published on weekends). A cursor that "only fetches papers newer
 * than last time" would permanently miss late-published papers. So each run re-reads a whole window
 * of `lookbackDays` back from the cursor; papers already present are dropped by the (source_id, external_id) key.
 * 5 days ≈ 950 papers for cs.CL/AI/LG/MA, about 5 pages, ~15 seconds.
 *
 * Fetches by `submittedDate` window (minute precision), each window at most 2.000 papers, moving
 * forward to the present; the cursor only advances to the end of a window that was fully fetched (see `walkWindows`). Before
 * 06/10/2026 the adapter fetched the "2.000 newest papers" and then moved the cursor up to the newest one: a daemon that was
 * down for a long time permanently lost the older part.
 *
 * The raw copy is the exact `<entry>…</entry>` block in the response, not parsed JSON: keep it
 * verbatim so the process job can re-read every field, including fields not used today.
 */
import { type RawItem, type SourceAdapter, walkWindows } from "@radard/core";
import { XMLParser } from "fast-xml-parser";

export interface ArxivConfig {
  /** Example: `["cs.CL", "cs.AI"]`. */
  categories: string[];
  /** How many days back to re-read from the cursor (first run: from now). Default 5. */
  lookbackDays?: number;
  /** Upper bound on papers per run when catching up after downtime (one request per 200 papers, 3 seconds apart). */
  maxPerRun?: number;
}

export interface ArxivState {
  /** Every submission (`published`) up to this mark (ISO) has been fully read. The next run reads back from here. */
  lastPublished: string;
}

const API = "https://export.arxiv.org/api/query";
const PAGE_SIZE = 200;
const WINDOW_CAP = 2000;
const DEFAULT_MAX = 10_000;
const MINUTE = 60_000;

/** Unix minutes → `YYYYMMDDHHMM` (GMT) for `submittedDate:[… TO …]`. */
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
    // No version: a revised paper (v2, v3) is still the same paper.
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
    // Do not move the cursor (the window starts 5 days back, so coveredUntil may not have passed the old mark).
    const covered = Math.max(walked.coveredUntil * MINUTE, state ? from : 0);
    return {
      items: walked.items,
      state: { lastPublished: new Date(covered).toISOString() },
      httpStatus: 200,
      behind: walked.behind,
    };
  },
};
