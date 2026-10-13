/**
 * Bảng giá model của Vercel AI Gateway, dùng để ƯỚC TÍNH chi phí khi Gateway không báo số
 * tiền của một lời gọi. Bình thường chi phí ghi vào `llm_calls` là số Gateway báo
 * (`providerMetadata.gateway.cost`); đây chỉ là dự phòng.
 *
 * Giá không phải một con số: chia bậc theo độ dài prompt (Haiku 5.5 gấp 5 lần từ 100 nghìn
 * token, gpt-6-luna từ 272 nghìn), có giá riêng cho token đọc/ghi cache. Nên đọc bảng giá thật
 * từ `GET /v1/models` (công khai, không cần khoá) thay vì cấu hình tay: đổi model là giá tự đúng.
 */

export interface PriceTier {
  /** USD mỗi token (chuỗi trong API, đổi sang số khi đọc). */
  cost: number;
  min?: number;
  max?: number;
}

export interface ModelPrice {
  input: PriceTier[];
  output: PriceTier[];
  cacheRead: PriceTier[];
  cacheWrite: PriceTier[];
}

export interface TokenUsage {
  /** Tổng token đầu vào (gồm cả phần đọc/ghi cache): quyết định bậc giá. */
  input: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Gồm cả token suy nghĩ ẩn: tính theo giá output. */
  output?: number;
}

interface RawTier {
  cost: string;
  min?: number;
  max?: number;
}

type RawPrice = Record<string, string | RawTier[] | unknown>;

function tiers(raw: RawPrice, key: string): PriceTier[] {
  const list = raw[`${key}_tiers`];
  if (Array.isArray(list) && list.length > 0) {
    return (list as RawTier[]).map((t) => ({ cost: Number(t.cost), min: t.min, max: t.max }));
  }
  const flat = raw[key];
  return typeof flat === "string" ? [{ cost: Number(flat) }] : [];
}

/** Đọc một mục `pricing` của `/v1/models` thành dạng dùng được. */
export function parsePrice(raw: RawPrice): ModelPrice {
  return {
    input: tiers(raw, "input"),
    output: tiers(raw, "output"),
    cacheRead: tiers(raw, "input_cache_read"),
    cacheWrite: tiers(raw, "input_cache_write"),
  };
}

/**
 * Chọn bậc theo số token đầu vào của lời gọi. API ghi `max` của bậc dưới bằng `min` của bậc
 * trên (ví dụ 100001), nên coi `max` là cận trên không tính.
 */
function pick(list: PriceTier[], inputTokens: number): number {
  if (list.length === 0) return 0;
  const hit = list.find(
    (t) => inputTokens >= (t.min ?? 0) && (t.max === undefined || inputTokens < t.max),
  );
  return (hit ?? list[list.length - 1])?.cost ?? 0;
}

/** Chi phí ước tính (USD). Cùng một bậc cho đầu vào, đầu ra và cache, theo độ dài prompt. */
export function estimateCost(price: ModelPrice, u: TokenUsage): number {
  const cacheRead = u.cacheRead ?? 0;
  const cacheWrite = u.cacheWrite ?? 0;
  const plain = Math.max(0, u.input - cacheRead - cacheWrite);
  return (
    plain * pick(price.input, u.input) +
    cacheRead * pick(price.cacheRead.length ? price.cacheRead : price.input, u.input) +
    cacheWrite * pick(price.cacheWrite.length ? price.cacheWrite : price.input, u.input) +
    (u.output ?? 0) * pick(price.output, u.input)
  );
}

export interface PriceBook {
  /** `null` khi không có bảng giá (mạng lỗi, model lạ): lời gọi ghi chi phí là chưa biết. */
  estimate(model: string, usage: TokenUsage): Promise<number | null>;
}

const CATALOG = "https://ai-gateway.vercel.sh/v1/models";

/** Bảng giá đọc từ Gateway, giữ trong bộ nhớ `ttlMs` (mặc định 1 ngày). */
export function gatewayPriceBook(opts: { ttlMs?: number; fetchFn?: typeof fetch } = {}): PriceBook {
  const ttl = opts.ttlMs ?? 86_400_000;
  const fetchFn = opts.fetchFn ?? fetch;
  let cache: { at: number; prices: Map<string, ModelPrice> } | null = null;

  async function load(): Promise<Map<string, ModelPrice> | null> {
    if (cache && Date.now() - cache.at < ttl) return cache.prices;
    try {
      const res = await fetchFn(CATALOG, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return cache?.prices ?? null;
      const body = (await res.json()) as { data: Array<{ id: string; pricing?: RawPrice }> };
      const prices = new Map<string, ModelPrice>();
      for (const m of body.data) if (m.pricing) prices.set(m.id, parsePrice(m.pricing));
      cache = { at: Date.now(), prices };
      return prices;
    } catch {
      // Lỗi mạng: dùng bảng cũ nếu có, nếu không thì chịu (chi phí ghi là chưa biết).
      return cache?.prices ?? null;
    }
  }

  return {
    async estimate(model, usage) {
      const price = (await load())?.get(model);
      return price ? estimateCost(price, usage) : null;
    },
  };
}
