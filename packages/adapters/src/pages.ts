/**
 * Tải trang được link tới và rút phần chữ chính.
 *
 * - Chặn SSRF: chỉ http/https cổng 80/443, mọi địa chỉ DNS phải công khai, redirect đi tay tối đa 5
 *   bước và mỗi đích kiểm lại (xem `@radard/core` url-guard).
 * - Tôn trọng robots.txt theo host của TỪNG bước (nên là host cuối sau redirect), đọc một lần mỗi
 *   host trong mỗi tiến trình, giữ 24 giờ. Theo RFC 9309: 4xx = không có luật, cho tải; 5xx hoặc
 *   không kết nối được = không tải trang.
 * - Chỉ đọc HTML, tối đa `maxBytes`; PDF, ảnh, video bỏ qua.
 * - Rút chữ bằng Readability (bộ "chế độ đọc" của Firefox) trên DOM của linkedom. Thử trên 40 link
 *   HN thật ngày 13/10/2026: 30 trang rút được chữ (trung vị 7.800 ký tự), 4 trang chặn bằng
 *   401/403 (WSJ, Reuters, NYT), 6 trang gần như không có chữ (YouTube, trang chỉ chạy JS).
 */
import { Readability } from "@mozilla/readability";
import {
  type AddressResolver,
  assertPublicUrl,
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
  UrlBlockedError,
} from "@radard/core";
import { parseHTML } from "linkedom";
import robotsParser from "robots-parser";

/** Tên bot trong robots.txt (khớp phần đầu User-Agent của HttpClient). */
const BOT = "radard";
const ROBOTS_TTL_MS = 24 * 3_600_000;
/** Dưới mức này coi như không rút được gì: trang chỉ có khung, cần JavaScript. */
const MIN_TEXT_CHARS = 300;

export function createPageFetcher(opts: {
  http: HttpClient;
  maxBytes?: number;
  timeoutMs?: number;
  /** Phân giải DNS; tiêm được để test không cần mạng. Mặc định `node:dns/promises`. */
  resolve?: AddressResolver;
}): PageFetcher {
  type Rules = { at: number; allowed: (url: string) => boolean };
  const robots = new Map<string, Rules>();
  const resolve = opts.resolve ?? defaultResolver;

  /**
   * GET một URL, đi theo redirect bằng tay tối đa `MAX_REDIRECTS` bước. MỖI đích (kể cả đích đầu)
   * qua `assertPublicUrl` (lược đồ, cổng, mọi địa chỉ) rồi mới gửi request; `gate` chạy trước mỗi
   * request để robots.txt tính theo đúng host của bước đó. Trả `null` khi `gate` từ chối.
   */
  async function guardedGet(
    start: string,
    getOpts: GetOptions,
    gate?: (url: string) => Promise<PageFetchResult | null>,
  ): Promise<{ res: HttpResponse; url: string } | PageFetchResult> {
    let current = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicUrl(current, resolve);
      const refused = await gate?.(current);
      if (refused) return refused;
      const res = await opts.http.get(current, { ...getOpts, redirect: "manual" });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return { res, url: current };
      current = new URL(location, current).href;
    }
    throw new UrlBlockedError(`quá ${MAX_REDIRECTS} lần redirect`, start);
  }

  /** `unreachable`: robots.txt 5xx hoặc không kết nối được → không tải trang (RFC 9309 §2.3.1.4). */
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
      // Các mã 3xx còn lại (không có location): coi như không có luật.
    } catch (err) {
      // 4xx (404…): không có robots.txt, được tải. 5xx, lỗi mạng, bị chặn: không được tải.
      if (!(err instanceof HttpError) || err.status >= 500) return "unreachable";
    }
    // Mục hết hạn của host không gặp lại sẽ không bao giờ bị ghi đè, nên dọn ở đây để Map không phình.
    const now = Date.now();
    for (const [key, entry] of robots) if (now - entry.at >= ROBOTS_TTL_MS) robots.delete(key);
    const rules = { at: now, allowed: check };
    robots.set(origin, rules);
    return rules;
  }

  return {
    robotsCacheSize: () => robots.size,
    async fetch(url) {
      try {
        // Kiểm lược đồ và cổng trước mọi thứ khác: URL sai thì không có request nào ra mạng.
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
              // Hoãn: job không ghi dòng nào, lần chạy sau tự chọn lại URL này.
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
    // Readability đọc `baseURI` để giải link tương đối; linkedom không có, nên gắn thẻ <base>.
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
