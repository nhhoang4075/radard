import { describe, expect, test } from "bun:test";
import { rateLimitWait, reportedCost } from "../src/ai-gateway.ts";

describe("rateLimitWait", () => {
  test("đọc thời gian chờ từ lỗi rate limit thật của Gateway (06/10/2026)", () => {
    const err = new Error(
      "Rate limit exceeded for alibaba/qwen3-embedding-0.6b for provider deepinfra: this team's limit of 5 requests per minute (across all regions) was reached. Retry after 60s.",
    );
    err.name = "GatewayRateLimitError";
    expect(rateLimitWait(err)).toBe(60);
  });

  test("lỗi rate limit không ghi thời gian thì chờ 60 giây", () => {
    const err = new Error("Rate limit exceeded");
    expect(rateLimitWait(err)).toBe(60);
  });

  test("lỗi khác không phải rate limit", () => {
    expect(rateLimitWait(new Error("Free tier users do not have access to this model"))).toBeNull();
  });
});

describe("reportedCost", () => {
  test("đọc chi phí và generationId Gateway báo (mẫu thật 11/10/2026)", () => {
    const meta = { gateway: { cost: "0.0000036", generationId: "gen_01M4N1YJXDTXQCZJGQ6XHNZET2" } };
    expect(reportedCost(meta)).toEqual({
      cost: 0.0000036,
      generationId: "gen_01M4N1YJXDTXQCZJGQ6XHNZET2",
    });
  });
  test("không có thông tin chi phí thì trả null để dùng giá ước tính", () => {
    expect(reportedCost(undefined)).toBeNull();
    expect(reportedCost({ gateway: {} })).toBeNull();
    expect(reportedCost({ gateway: { cost: "abc" } })).toBeNull();
  });
});
