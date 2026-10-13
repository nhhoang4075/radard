import { afterAll, expect, test } from "bun:test";
import { createHttpClient, HttpError } from "../src/http.ts";

// Server cục bộ ghi lại thời điểm, phương thức và body của request, để đo khoảng giãn thật.
const hits: { at: number; method: string; body: string; type: string | null }[] = [];
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
afterAll(() => server.stop(true));

const gapsOf = () => hits.slice(1).map((h, i) => h.at - (hits[i]?.at ?? 0));

test("host có luật riêng thì giãn theo luật đó", async () => {
  const host = `localhost:${server.port}`;
  const http = createHttpClient({ minIntervalMs: 0, perHostIntervalMs: { [host]: 150 } });
  hits.length = 0;
  await Promise.all([1, 2, 3].map(() => http.get(`http://${host}/`)));
  for (const g of gapsOf()) expect(g).toBeGreaterThanOrEqual(140);
});

test("POST gửi body nguyên văn, chung lượt giãn với GET; mã ≥ 400 thành HttpError", async () => {
  const host = `localhost:${server.port}`;
  const http = createHttpClient({ minIntervalMs: 0, perHostIntervalMs: { [host]: 150 } });
  hits.length = 0;
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
  for (const g of gapsOf()) expect(g).toBeGreaterThanOrEqual(140);

  const err = await http.post(`http://${host}/loi`, "{}").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(401);
});
