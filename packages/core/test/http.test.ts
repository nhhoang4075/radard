import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, createServer as createTlsServer } from "node:tls";
import { createHttpClient, HttpError } from "../src/http.ts";

// Local server records the method and body of each request. The spacing is measured at SEND time (wrapping `fetch`), because
// the client only controls send time: measuring at receipt makes the first connection setup a few ms slower (machine
// running many test files), so the gap looks shorter and the test fails erratically (139 ms, 13/10/2026).
const hits: {
  at: number;
  method: string;
  body: string;
  type: string | null;
  host: string | null;
}[] = [];
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
      host: req.headers.get("host"),
    });
    if (new URL(req.url).pathname === "/chuyen") {
      return new Response(null, { status: 302, headers: { location: "/dich" } });
    }
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

test('redirect: "manual" trả thẳng 3xx kèm location; mặc định vẫn đi theo', async () => {
  const http = createHttpClient({ minIntervalMs: 0 });
  const base = `http://localhost:${server.port}`;
  const manual = await http.get(`${base}/chuyen`, { redirect: "manual" });
  expect(manual.status).toBe(302);
  expect(manual.headers.get("location")).toBe("/dich");
  const followed = await http.get(`${base}/chuyen`);
  expect(followed.status).toBe(200);
  expect(followed.url).toBe(`${base}/dich`);
});

// Pinning the address: connects to the checked IP, but Host, SNI and certificate verification still use the original name.
test("connectTo: HTTP giữ header Host của tên gốc", async () => {
  const http = createHttpClient({ minIntervalMs: 0 });
  hits.length = 0;
  const res = await http.get(`http://pinned.example:${server.port}/x`, {
    connectTo: "127.0.0.1",
  });
  expect(res.status).toBe(200);
  expect(res.url).toBe(`http://pinned.example:${server.port}/x`);
  expect(hits.at(-1)?.host).toBe(`pinned.example:${server.port}`);
});

const openssl = Bun.spawnSync(["openssl", "version"]).exitCode === 0;
describe.skipIf(!openssl)("connectTo: HTTPS", () => {
  const dir = mkdtempSync(join(tmpdir(), "radard-tls-"));
  Bun.spawnSync([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-keyout",
    join(dir, "k.pem"),
    "-out",
    join(dir, "c.pem"),
    "-subj",
    "/CN=pin.test",
    "-addext",
    "subjectAltName=DNS:pin.test",
  ]);
  const cert = readFileSync(join(dir, "c.pem"), "utf8");
  const key = readFileSync(join(dir, "k.pem"), "utf8");
  const sni: string[] = [];
  const hosts: (string | null)[] = [];
  let port = 0;
  let tlsServer: ReturnType<typeof createTlsServer>;
  beforeAll(async () => {
    tlsServer = createTlsServer(
      {
        key,
        cert,
        SNICallback: (name, cb) => {
          sni.push(name);
          cb(null, createSecureContext({ key, cert }));
        },
      },
      (sock) => {
        sock.on("data", (d) => {
          hosts.push(/^host: (.*)\r$/im.exec(d.toString())?.[1] ?? null);
          sock.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
        });
      },
    );
    await new Promise<void>((r) => tlsServer.listen(0, "127.0.0.1", r));
    port = (tlsServer.address() as { port: number }).port;
  });
  afterAll(() => {
    tlsServer.close();
    rmSync(dir, { recursive: true, force: true });
  });
  // For the test that trusts a self-signed certificate via a private CA (verification NOT disabled); the real client has no such path.
  const withCa = (init: RequestInit | undefined) =>
    ({ ...init, tls: { ...((init as { tls?: object })?.tls ?? {}), ca: cert } }) as RequestInit;
  const fetchBefore = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = Object.assign(
      (i: Parameters<typeof fetch>[0], init?: RequestInit) => fetchBefore(i, withCa(init)),
      fetchBefore,
    );
  });
  afterAll(() => {
    globalThis.fetch = fetchBefore;
  });

  test("SNI và Host theo tên gốc; chứng chỉ được kiểm chứng theo tên đó", async () => {
    const http = createHttpClient({ minIntervalMs: 0 });
    const res = await http.get(`https://pin.test:${port}/`, { connectTo: "127.0.0.1" });
    expect(res.body).toBe("ok");
    expect(sni.at(-1)).toBe("pin.test");
    expect(hosts.at(-1)).toBe(`pin.test:${port}`);
  });

  test("tên gốc không khớp chứng chỉ thì LỖI (kiểm chứng không bị tắt)", async () => {
    const http = createHttpClient({ minIntervalMs: 0 });
    await expect(
      http.get(`https://other.test:${port}/`, { connectTo: "127.0.0.1" }),
    ).rejects.toThrow();
  });
});
