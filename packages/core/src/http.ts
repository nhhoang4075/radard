/**
 * HTTP cho adapter nguồn: GET có điều kiện và giới hạn tốc độ theo host.
 *
 * Crawl lịch sự không phải chỉ để khỏi bị chặn: 304 không tải lại body, và với GitHub
 * một request 304 có kèm token (`Authorization`) không bị trừ quota; không có token thì
 * vẫn bị trừ (đã thử 28/09/2026). Giới hạn theo host để hai nguồn cùng domain
 * (vài feed của một blog) không cộng dồn thành một cơn bão request.
 */
export interface HttpResponse {
  status: number;
  body: string;
  /** Địa chỉ cuối cùng sau khi đi theo redirect. */
  url?: string;
  /** `true`: body bị cắt ở `maxBytes`. */
  truncated?: boolean;
  etag?: string;
  lastModified?: string;
  headers: Headers;
}

export interface GetOptions {
  etag?: string;
  lastModified?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Đọc body tối đa chừng này byte rồi dừng (trang web lạ có thể rất nặng). */
  maxBytes?: number;
}

export interface HttpClient {
  get(url: string, opts?: GetOptions): Promise<HttpResponse>;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly bodySnippet: string,
  ) {
    super(`HTTP ${status} ${url}`);
  }
}

const USER_AGENT = "radard/0.1 (personal research daemon; +https://nguyenhuyhoang.work)";

export interface HttpClientOptions {
  /** Khoảng cách tối thiểu giữa hai request tới cùng một host. */
  minIntervalMs?: number;
  /** Host nào có luật riêng thì ghi ở đây, ví dụ arXiv yêu cầu ≥ 3 giây. */
  perHostIntervalMs?: Record<string, number>;
}

export function createHttpClient(opts: HttpClientOptions = {}): HttpClient {
  const minInterval = opts.minIntervalMs ?? 1000;
  const nextAllowed = new Map<string, number>();

  async function waitTurn(host: string): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, nextAllowed.get(host) ?? 0);
    nextAllowed.set(host, at + (opts.perHostIntervalMs?.[host] ?? minInterval));
    if (at > now) await Bun.sleep(at - now);
  }

  return {
    async get(url, o = {}) {
      await waitTurn(new URL(url).host);
      const headers: Record<string, string> = { "user-agent": USER_AGENT, ...o.headers };
      if (o.etag) headers["if-none-match"] = o.etag;
      if (o.lastModified) headers["if-modified-since"] = o.lastModified;

      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
      });
      if (res.status >= 400) {
        const snippet = await res.text().catch(() => "");
        throw new HttpError(res.status, url, snippet.slice(0, 300));
      }
      const { body, truncated } =
        res.status === 304 ? { body: "", truncated: false } : await readBody(res, o.maxBytes);
      return {
        status: res.status,
        body,
        url: res.url || url,
        truncated,
        etag: res.headers.get("etag") ?? undefined,
        lastModified: res.headers.get("last-modified") ?? undefined,
        headers: res.headers,
      };
    },
  };
}

async function readBody(
  res: Response,
  maxBytes: number | undefined,
): Promise<{ body: string; truncated: boolean }> {
  if (maxBytes === undefined || !res.body) return { body: await res.text(), truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= maxBytes) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const all = new Uint8Array(Math.min(size, maxBytes));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, all.length - at);
    all.set(part, at);
    at += part.length;
    if (at >= all.length) break;
  }
  return { body: new TextDecoder().decode(all), truncated };
}
