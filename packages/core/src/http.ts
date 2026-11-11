import { hostnameOf } from "./url-guard.ts";

/**
 * HTTP for source adapters: conditional GET, POST (GitHub's GraphQL), and per-host rate limiting.
 *
 * Polite crawling is not only about avoiding blocks: a 304 does not re-download the body, and for GitHub
 * a 304 request that carries a token (`Authorization`) is not charged against the quota; without a token it
 * is still charged (tested 28/09/2026). Limits are per host, so two sources on the same domain
 * (several feeds of one blog) do not add up into a flood of requests.
 */
export interface HttpResponse {
  status: number;
  body: string;
  /** Final address after following redirects. */
  url?: string;
  /** `true`: body was cut at `maxBytes`. */
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
  /** Read at most this many bytes, then stop (unknown web pages may be very heavy). */
  maxBytes?: number;
  /**
   * `"manual"`: do not follow redirects automatically; return the 3xx response directly (with the `location` header) so the
   * caller checks each target (the path for loading unknown pages). Default: follow redirects like `fetch`.
   */
  redirect?: "manual";
  /**
   * Connect directly to this IP address instead of letting `fetch` resolve the hostname again (prevents DNS rebinding:
   * the address already checked by `resolvePublicUrl` is the one connected to). Keep the `Host` header, SNI and
   * certificate verification by the original hostname. Not used when the host in the URL is already an IP.
   */
  connectTo?: string;
}

export type PostOptions = Pick<
  GetOptions,
  "headers" | "timeoutMs" | "maxBytes" | "redirect" | "connectTo"
>;

/**
 * `post` is required, not optional: every real client can POST, and if it were optional the call sites would
 * have to handle the "no post" case, which only happens in tests. The test fake only needs to declare
 * one extra function that throws.
 */
export interface HttpClient {
  get(url: string, opts?: GetOptions): Promise<HttpResponse>;
  /** Send `body` verbatim; the caller sets `content-type` itself. Same per-host spacing, same `HttpError`. */
  post(url: string, body: string, opts?: PostOptions): Promise<HttpResponse>;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly bodySnippet: string,
    /** From the `Retry-After` header (429/503) if the server sends it; in milliseconds. */
    readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status} ${url}`);
  }
}

/** `Retry-After` is a number of seconds or an HTTP date; if malformed, treat it as absent. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs >= 0 ? Math.round(secs * 1000) : undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const USER_AGENT = "radard/0.1 (personal research daemon; +https://nguyenhuyhoang.work)";

export interface HttpClientOptions {
  /** Minimum gap between two requests to the same host. */
  minIntervalMs?: number;
  /** Hosts with their own rule are listed here, e.g. arXiv requires ≥ 3 seconds. */
  perHostIntervalMs?: Record<string, number>;
}

export function createHttpClient(opts: HttpClientOptions = {}): HttpClient {
  const minInterval = opts.minIntervalMs ?? 1000;
  /** Previous request to each host: its wait must finish before the next request goes. */
  const queues = new Map<string, Promise<void>>();
  /** Time the most recent request to each host was actually sent. */
  const lastSent = new Map<string, number>();

  /**
   * Queue per host, then wait the full gap counted from when the PREVIOUS request was ACTUALLY SENT. Before 13/10/2026
   * the next slot was scheduled from the previous slot's planned time, so if the previous request was sent a few ms late (busy machine),
   * the real gap was shorter by that much (measured 142 ms for a 150 ms rule).
   */
  async function waitTurn(host: string): Promise<void> {
    const prev = queues.get(host) ?? Promise.resolve();
    let release = () => {};
    const mine = new Promise<void>((r) => {
      release = r;
    });
    queues.set(
      host,
      prev.then(() => mine),
    );
    await prev;
    try {
      const interval = opts.perHostIntervalMs?.[host] ?? minInterval;
      const wait = (lastSent.get(host) ?? Number.NEGATIVE_INFINITY) + interval - performance.now();
      if (wait > 0) await Bun.sleep(wait);
      lastSent.set(host, performance.now());
    } finally {
      release();
    }
  }

  /** Shared part of GET and POST: wait for the host's turn, abort on timeout, status ≥ 400 becomes an `HttpError`. */
  async function send(
    url: string,
    init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
    o: PostOptions,
  ): Promise<HttpResponse> {
    await waitTurn(new URL(url).host);
    const pinned = o.connectTo ? pinTo(url, o.connectTo) : null;
    const res = await fetch(pinned?.url ?? url, {
      ...init,
      headers: { "user-agent": USER_AGENT, ...init.headers, ...pinned?.headers },
      signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
      ...(o.redirect ? { redirect: o.redirect } : {}),
      ...(pinned?.tls ? { tls: pinned.tls } : {}),
    } as RequestInit);
    if (res.status >= 400) {
      const snippet = await res.text().catch(() => "");
      throw new HttpError(
        res.status,
        url,
        snippet.slice(0, 300),
        parseRetryAfter(res.headers.get("retry-after")),
      );
    }
    const { body, truncated } =
      res.status === 304 ? { body: "", truncated: false } : await readBody(res, o.maxBytes);
    return {
      status: res.status,
      body,
      url: pinned ? url : res.url || url,
      truncated,
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
      headers: res.headers,
    };
  }

  return {
    async get(url, o = {}) {
      const headers: Record<string, string> = { ...o.headers };
      if (o.etag) headers["if-none-match"] = o.etag;
      if (o.lastModified) headers["if-modified-since"] = o.lastModified;
      return send(url, { method: "GET", headers }, o);
    },
    async post(url, body, o = {}) {
      return send(url, { method: "POST", headers: { ...o.headers }, body }, o);
    },
  };
}

/**
 * URL pointing directly at the IP + the original `Host` header; for https also `tls.serverName` so SNI and certificate
 * checks still use the original hostname (tested on Bun 1.4.3: a wrong name or an untrusted CA still errors).
 */
function pinTo(url: string, address: string) {
  const u = new URL(url);
  const original = u.host;
  const name = hostnameOf(u);
  u.hostname = address.includes(":") ? `[${address}]` : address;
  return {
    url: u.href,
    headers: { host: original },
    tls: u.protocol === "https:" ? { serverName: name } : undefined,
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
