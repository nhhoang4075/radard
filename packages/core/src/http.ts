/**
 * HTTP cho adapter nguồn: GET có điều kiện, POST (GraphQL của GitHub) và giới hạn tốc độ theo host.
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

export type PostOptions = Pick<GetOptions, "headers" | "timeoutMs" | "maxBytes">;

/**
 * `post` bắt buộc chứ không tuỳ chọn: mọi client thật đều POST được, còn để tuỳ chọn thì chỗ gọi
 * phải xử lý trường hợp "không có post" vốn chỉ xảy ra trong test. Bản giả trong test chỉ cần khai
 * báo thêm một hàm ném lỗi.
 */
export interface HttpClient {
  get(url: string, opts?: GetOptions): Promise<HttpResponse>;
  /** Gửi `body` nguyên văn, người gọi tự đặt `content-type`. Cùng giãn theo host, cùng `HttpError`. */
  post(url: string, body: string, opts?: PostOptions): Promise<HttpResponse>;
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
  /** Request trước tới mỗi host: xong lượt chờ của nó thì mới tới lượt request sau. */
  const queues = new Map<string, Promise<void>>();
  /** Lúc request gần nhất tới mỗi host thật sự được gửi đi. */
  const lastSent = new Map<string, number>();

  /**
   * Xếp hàng theo host, rồi chờ đủ khoảng cách tính từ lúc request TRƯỚC THẬT SỰ GỬI. Trước 13/10/2026
   * lượt sau được hẹn theo giờ hẹn của lượt trước, nên lượt trước gửi trễ vài ms (máy bận) thì
   * khoảng cách thật ngắn đi đúng chừng đó (đo được 142 ms cho luật 150 ms).
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

  /** Phần chung của GET và POST: chờ lượt theo host, quá giờ thì huỷ, mã ≥ 400 thành `HttpError`. */
  async function send(
    url: string,
    init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
    o: PostOptions,
  ): Promise<HttpResponse> {
    await waitTurn(new URL(url).host);
    const res = await fetch(url, {
      ...init,
      headers: { "user-agent": USER_AGENT, ...init.headers },
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
