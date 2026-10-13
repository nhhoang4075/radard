import { afterAll, expect, test } from "bun:test";
import { createHttpClient, HttpError } from "../src/http.ts";

// Server cục bộ ghi lại phương thức và body của request. Khoảng giãn đo ở LÚC GỬI (bọc `fetch`), vì
// client chỉ kiểm soát lúc gửi: đo lúc server nhận thì lượt đầu mở kết nối chậm vài ms (máy đang
// chạy nhiều file test) làm khoảng cách trông ngắn hơn, test lỗi thất thường (139 ms, 13/10/2026).
const hits: { at: number; method: string; body: string; type: string | null }[] = [];
const sentAt: number[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    sentAt.push(performance.now());
    return realFetch(input, init);
  },
  realFetch,
);
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    hits.push({
      at: Date.now(),
      method: req.method,
      body: await req.text(),
      type: req.headers.get("content-type"),
    });
    return new URL(req.url).pathname === "/loi"
      ? new Response("không được", { status: 401 })
      : new Response("ok");
  },
});
afterAll(() => {
  globalThis.fetch = realFetch;
  server.stop(true);
});

const gapsOf = () => sentAt.slice(1).map((t, i) => t - (sentAt[i] ?? 0));

test("host có luật riêng thì giãn theo luật đó", async () => {
  const host = `localhost:${server.port}`;
  const http = createHttpClient({ minIntervalMs: 0, perHostIntervalMs: { [host]: 150 } });
  hits.length = 0;
  sentAt.length = 0;
  await Promise.all([1, 2, 3].map(() => http.get(`http://${host}/`)));
  expect(gapsOf()).toHaveLength(2);
  for (const g of gapsOf()) expect(g).toBeGreaterThanOrEqual(148);
});

test("POST gửi body nguyên văn, chung lượt giãn với GET; mã ≥ 400 thành HttpError", async () => {
  const host = `localhost:${server.port}`;
  const http = createHttpClient({ minIntervalMs: 0, perHostIntervalMs: { [host]: 150 } });
  hits.length = 0;
  sentAt.length = 0;
  const [a, b] = await Promise.all([
    http.get(`http://${host}/`),
    http.post(`http://${host}/`, '{"q":1}', { headers: { "content-type": "application/json" } }),
  ]);
  expect([a.body, b.body]).toEqual(["ok", "ok"]);
  expect(hits.map((h) => [h.method, h.body])).toEqual([
    ["GET", ""],
    ["POST", '{"q":1}'],
  ]);
  expect(hits[1]?.type).toBe("application/json");
  expect(gapsOf()).toHaveLength(1);
  for (const g of gapsOf()) expect(g).toBeGreaterThanOrEqual(148);

  const err = await http.post(`http://${host}/loi`, "{}").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(401);
});
