/**
 * Fetches the linked page and extracts its main text.
 *
 * - Blocks SSRF: only http/https on ports 80/443, every DNS address must be public, manual redirects up to 5
 *   steps, and each target is checked again (see `@radard/core` url-guard).
 * - Honors robots.txt per host of EACH step (so the final host after redirects), read once per
 *   host in each process, cached for 24 hours. Per RFC 9309: 4xx = no rules, fetching allowed; 5xx or
 *   unreachable = do not fetch the page.
 * - Reads HTML only, up to `maxBytes`; PDFs, images and videos are skipped.
 * - Extracts text with Readability (Firefox's "reader mode" engine) on the linkedom DOM. Tried on 40 links
 *   real HN links on 13/10/2026: 30 pages yielded text (median 7.800 characters), 4 pages blocked with
 *   401/403 (WSJ, Reuters, NYT), 6 pages had almost no text (YouTube, pages that only run JS).
 */
import { Readability } from "@mozilla/readability";
import {
  type AddressResolver,
  type CheckedUrl,
  checkUrlShape,
  defaultResolver,
  type GetOptions,
  type HttpClient,
  HttpError,
  type HttpResponse,
  MAX_REDIRECTS,
  type PageExtractor,
  type PageFetcher,
  type PageFetchResult,
  resolvePublicUrl,
  UrlBlockedError,
} from "@radard/core";
import { parseHTML } from "linkedom";
import robotsParser from "robots-parser";

/** Bot name in robots.txt (matches the start of the HttpClient User-Agent). */
const BOT = "radard";
/** Maximum number of addresses to try when connecting fails. */
const MAX_PIN_ATTEMPTS = 3;
const ROBOTS_TTL_MS = 24 * 3_600_000;
/** Below this level nothing counts as extracted: the page is only a shell and needs JavaScript. */
const MIN_TEXT_CHARS = 300;

export function createPageFetcher(opts: {
  http: HttpClient;
  maxBytes?: number;
  timeoutMs?: number;
  /** DNS resolver; injectable so tests need no network. Default `node:dns/promises`. */
  resolve?: AddressResolver;
  /** Connects directly to the checked address (default `true`); only disabled in tests that use a fake client. */
  pinAddress?: boolean;
}): PageFetcher {
  type Rules = { at: number; allowed: (url: string) => boolean };
  const robots = new Map<string, Rules>();
  const resolve = opts.resolve ?? defaultResolver;

  /**
   * GET connects directly to a CHECKED address (prevents DNS rebinding). Tries in turn up to
   * `MAX_PIN_ATTEMPTS` addresses when connecting fails (a crude happy eyeballs); an HTTP error stops.
   */
  async function getPinned(
    url: string,
    checked: CheckedUrl,
    getOpts: GetOptions,
  ): Promise<HttpResponse> {
    const base = { ...getOpts, redirect: "manual" } as const;
    if (checked.literal || opts.pinAddress === false) return opts.http.get(url, base);
    let last: unknown;
    for (const address of checked.addresses.slice(0, MAX_PIN_ATTEMPTS)) {
      try {
        return await opts.http.get(url, { ...base, connectTo: address });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        last = err;
      }
    }
    throw last;
  }

  /**
   * GETs a URL, following redirects manually for up to `MAX_REDIRECTS` steps. EACH target (including the first)
   * goes through `assertPublicUrl` (scheme, port, every address) before a request is sent; `gate` runs before each
   * request, so robots.txt is checked against that step's host. Returns `null` when `gate` refuses.
   */
  async function guardedGet(
    start: string,
    getOpts: GetOptions,
    gate?: (url: string) => Promise<PageFetchResult | null>,
  ): Promise<{ res: HttpResponse; url: string } | PageFetchResult> {
    let current = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const checked = await resolvePublicUrl(current, resolve);
      const refused = await gate?.(current);
      if (refused) return refused;
      const res = await getPinned(current, checked, getOpts);
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return { res, url: current };
      current = new URL(location, current).href;
    }
    throw new UrlBlockedError(`quá ${MAX_REDIRECTS} lần redirect`, start);
  }

  function sweepExpired(now: number): void {
    for (const [key, entry] of robots) if (now - entry.at >= ROBOTS_TTL_MS) robots.delete(key);
  }

  /** `unreachable`: robots.txt 5xx, timed out or not reachable → do not fetch the page (RFC 9309 §2.3.1.4). */
  async function robotsFor(url: string): Promise<Rules | "unreachable"> {
    const origin = new URL(url).origin;
    const hit = robots.get(origin);
    if (hit && Date.now() - hit.at < ROBOTS_TTL_MS) return hit;
    let check: (u: string) => boolean = () => true;
    try {
      const got = await guardedGet(`${origin}/robots.txt`, {
        timeoutMs: 10_000,
        maxBytes: 500_000,
      });
      if (!("res" in got)) return "unreachable";
      if (got.res.status >= 200 && got.res.status < 300) {
        const parsed = robotsParser(`${origin}/robots.txt`, got.res.body);
        check = (u) => parsed.isAllowed(u, BOT) !== false;
      }
      // Other 3xx codes (no location): treated as no rules.
    } catch (err) {
      // 4xx (404…): no robots.txt, fetching allowed. 5xx, network error, blocked: fetching not allowed.
      // Blocked by url-guard (a redirect into a private address...) is an active block, not a temporary error: the error
      // propagates out of `fetch` and becomes `failed`.
      if (err instanceof UrlBlockedError) throw err;
      if (!(err instanceof HttpError) || err.status >= 500) return "unreachable";
    }
    // Expired entries of a host that is not seen again are never overwritten, so clean them up here to keep the Map from growing.
    const now = Date.now();
    sweepExpired(now);
    const rules = { at: now, allowed: check };
    robots.set(origin, rules);
    return rules;
  }

  return {
    robotsCacheSize: () => robots.size,
    async fetch(url) {
      try {
        // Check scheme and port before anything else: a bad URL sends no request to the network.
        checkUrlShape(url);
        const got = await guardedGet(
          url,
          {
            timeoutMs: opts.timeoutMs ?? 15_000,
            maxBytes: opts.maxBytes ?? 2_000_000,
            headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" },
          },
          async (hopUrl) => {
            const rules = await robotsFor(hopUrl);
            if (rules === "unreachable") {
              // Defer: the job writes no row, and the next run picks this URL again.
              return { status: "deferred", error: "robots.txt không đọc được (5xx hoặc lỗi mạng)" };
            }
            return rules.allowed(hopUrl)
              ? null
              : { status: "blocked", error: "robots.txt không cho phép" };
          },
        );
        if (!("res" in got)) return got;
        const { res } = got;
        const contentType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
        const base = { httpStatus: res.status, contentType, finalUrl: got.url };
        if (!/html|xml/.test(contentType)) {
          return { ...base, status: "skipped", error: `không phải HTML: ${contentType || "?"}` };
        }
        return { ...base, status: "ok", html: res.body };
      } catch (err) {
        if (err instanceof UrlBlockedError) {
          return { status: "failed", error: err.message.slice(0, 300) };
        }
        if (err instanceof HttpError) {
          return { status: "failed", httpStatus: err.status, error: `HTTP ${err.status}` };
        }
        const e = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        return { status: "failed", error: e.slice(0, 300) };
      }
    },
  };
}

export const extractPageText: PageExtractor = (html, url) => {
  try {
    const { document } = parseHTML(html);
    // Readability reads `baseURI` to resolve relative links; linkedom does not have it, so a <base> tag is attached.
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.appendChild(base);
    const article = new Readability(document as unknown as Document).parse();
    const text = (article?.textContent ?? "").replace(/\s+/g, " ").trim();
    return text.length >= MIN_TEXT_CHARS ? text : null;
  } catch {
    return null;
  }
};
