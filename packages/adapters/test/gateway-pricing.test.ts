import { describe, expect, test } from "bun:test";
import { estimateCost, gatewayPriceBook, parsePrice } from "../src/gateway-pricing.ts";

/** Mục `pricing` thật của anthropic/claude-haiku-5.5 trên ai-gateway.vercel.sh/v1/models, 11/10/2026. */
const HAIKU = {
  input: "0.0000001",
  input_tiers: [
    { cost: "0.0000001", min: 0, max: 100001 },
    { cost: "0.0000005", min: 100001 },
  ],
  output: "0.0000005",
  output_tiers: [
    { cost: "0.0000005", min: 0, max: 100001 },
    { cost: "0.0000025", min: 100001 },
  ],
  input_cache_read: "0.00000001",
  input_cache_read_tiers: [
    { cost: "0.00000001", min: 0, max: 100001 },
    { cost: "0.00000005", min: 100001 },
  ],
  input_cache_write: "0.000000125",
  input_cache_write_tiers: [
    { cost: "0.000000125", min: 0, max: 100001 },
    { cost: "0.000000625", min: 100001 },
  ],
  web_search: "10",
};
const price = parsePrice(HAIKU);
const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-12);

describe("estimateCost", () => {
  test("khớp số Gateway báo cho digest mẫu: 1.518 vào, 2.157 ra → $0,00123", () => {
    close(estimateCost(price, { input: 1518, output: 2157 }), 0.0012303);
  });

  test("prompt dài vượt 100 nghìn token: cả đầu vào lẫn đầu ra lên bậc 2 (gấp 5)", () => {
    close(estimateCost(price, { input: 150_000, output: 1000 }), 150_000 * 5e-7 + 1000 * 2.5e-6);
  });

  test("ranh giới bậc: 100.000 vẫn bậc 1, 100.001 sang bậc 2", () => {
    close(estimateCost(price, { input: 100_000 }), 100_000 * 1e-7);
    close(estimateCost(price, { input: 100_001 }), 100_001 * 5e-7);
  });

  test("token đọc từ cache tính giá cache, phần còn lại tính giá thường", () => {
    close(estimateCost(price, { input: 50_000, cacheRead: 40_000 }), 10_000 * 1e-7 + 40_000 * 1e-8);
  });

  test("model chỉ có giá phẳng (như embedding) vẫn tính được", () => {
    close(estimateCost(parsePrice({ input: "0.00000001" }), { input: 1_000_000 }), 0.01);
  });
});

describe("gatewayPriceBook", () => {
  const catalog = { data: [{ id: "anthropic/claude-haiku-5.5", pricing: HAIKU }] };
  const fakeFetch = (fail = false) => {
    let calls = 0;
    const fn = (async () => {
      calls++;
      if (fail) throw new Error("mạng lỗi");
      return new Response(JSON.stringify(catalog));
    }) as unknown as typeof fetch;
    return { fn, calls: () => calls };
  };

  test("đọc bảng giá một lần rồi dùng lại trong thời hạn", async () => {
    const f = fakeFetch();
    const book = gatewayPriceBook({ fetchFn: f.fn });
    close(
      (await book.estimate("anthropic/claude-haiku-5.5", { input: 1518, output: 2157 })) ?? -1,
      0.0012303,
    );
    await book.estimate("anthropic/claude-haiku-5.5", { input: 10 });
    expect(f.calls()).toBe(1);
  });

  test("model không có trong bảng giá, hoặc mạng lỗi: trả null", async () => {
    expect(
      await gatewayPriceBook({ fetchFn: fakeFetch().fn }).estimate("x/unknown", { input: 10 }),
    ).toBeNull();
    expect(
      await gatewayPriceBook({ fetchFn: fakeFetch(true).fn }).estimate(
        "anthropic/claude-haiku-5.5",
        { input: 10 },
      ),
    ).toBeNull();
  });
});
