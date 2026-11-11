/**
 * Model price table of Vercel AI Gateway, used to ESTIMATE cost when Gateway does not report the
 * money of a call. Normally the cost written to `llm_calls` is the number Gateway reports
 * (`providerMetadata.gateway.cost`); this is only a fallback.
 *
 * A price is not a single number: tiered by prompt length (Haiku 5.5 is 5x from 100 thousand
 * tokens, gpt-6-luna from 272 thousand), with separate prices for cache read/write tokens. So read the real price table
 * from `GET /v1/models` (public, no key needed) instead of configuring it by hand: changing the model gets the price right automatically.
 */

export interface PriceTier {
  /** USD per token (a string in the API, converted to a number when read). */
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
  /** Total input tokens (including the cache read/write parts): decides the price tier. */
  input: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Includes hidden reasoning tokens: priced at the output rate. */
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

/** Reads one `pricing` entry of `/v1/models` into a usable form. */
export function parsePrice(raw: RawPrice): ModelPrice {
  return {
    input: tiers(raw, "input"),
    output: tiers(raw, "output"),
    cacheRead: tiers(raw, "input_cache_read"),
    cacheWrite: tiers(raw, "input_cache_write"),
  };
}

/**
 * Picks the tier by the call's input token count. The API writes the `max` of the lower tier equal to the `min` of the
 * tier above (e.g. 100001), so `max` is treated as an exclusive upper bound.
 */
function pick(list: PriceTier[], inputTokens: number): number {
  if (list.length === 0) return 0;
  const hit = list.find(
    (t) => inputTokens >= (t.min ?? 0) && (t.max === undefined || inputTokens < t.max),
  );
  return (hit ?? list[list.length - 1])?.cost ?? 0;
}

/** Estimated cost (USD). One tier applies to input, output and cache, by prompt length. */
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
  /** `null` when there is no price table (network error, unknown model): the call's cost is recorded as unknown. */
  estimate(model: string, usage: TokenUsage): Promise<number | null>;
}

const CATALOG = "https://ai-gateway.vercel.sh/v1/models";

/** Price table read from Gateway, kept in memory for `ttlMs` (default 1 day). */
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
      // Network error: use the old table if there is one, otherwise accept it (the cost is recorded as unknown).
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
