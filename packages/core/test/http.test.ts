import { afterAll, expect, test } from "bun:test";
import { createHttpClient } from "../src/http.ts";

// Server cục bộ ghi lại thời điểm nhận request, để đo khoảng giãn thật.
const hits: number[] = [];
const server = Bun.serve({
  port: 0,
  fetch() {
    hits.push(Date.now());
    return new Response("ok");
  },
});
afterAll(() => server.stop(true));

test("host có luật riêng thì giãn theo luật đó", async () => {
  const host = `localhost:${server.port}`;
  const http = createHttpClient({ minIntervalMs: 0, perHostIntervalMs: { [host]: 150 } });
  hits.length = 0;
  await Promise.all([1, 2, 3].map(() => http.get(`http://${host}/`)));
  const gaps = hits.slice(1).map((t, i) => t - (hits[i] ?? 0));
  for (const g of gaps) expect(g).toBeGreaterThanOrEqual(140);
});
