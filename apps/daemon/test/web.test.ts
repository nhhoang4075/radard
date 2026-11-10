/** Theo dõi lượt mở link: token, route /o/:token, ghi `link_opens`. Không mở cổng thật. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createDatabase, deliveries, digests, linkOpens, profile, runMigrations } from "@radard/db";
import { sql } from "drizzle-orm";
import { withTrackedLinks } from "../src/jobs/digest.ts";
import { createWebApp } from "../src/web/app.ts";
import { buildTrackingUrl, signToken, verifyToken } from "../src/web/token.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 4 });
const SECRET = "khoa-thu-nghiem-0123456789";
const BASE = "https://radard.example.com";
const TARGET_0 = "https://example.org/bai-chinh?a=1";
const TARGET_1 = "http://example.net:8080/bai-lien-quan";

let clock = new Date("2026-11-10T00:00:00Z");
const web = () => createWebApp({ db, secret: SECRET, now: () => clock });
const tokenOf = (k: number, digestId = 1, position = 1) =>
  signToken(SECRET, { digestId, position, k });
const open = (w: ReturnType<typeof web>, token: string, init?: RequestInit) =>
  w.app.request(`/o/${token}`, init);
const opens = () => db.select().from(linkOpens);

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  clock = new Date("2026-11-10T00:00:00Z");
  await db.execute(sql`truncate profile, digests, deliveries, link_opens restart identity cascade`);
  await db.insert(profile).values([
    { id: 1, promptContext: "a" },
    { id: 2, promptContext: "b" },
  ]);
  await db.insert(digests).values({
    profileId: 2,
    channel: "telegram",
    recipient: "1",
    periodStart: new Date("2026-11-09T00:00:00Z"),
    periodEnd: new Date("2026-11-10T00:00:00Z"),
    lang: "vi",
  });
  await db.insert(deliveries).values({
    profileId: 2,
    digestId: 1,
    channel: "telegram",
    recipient: "1",
    messageId: "9",
    kind: "event",
    eventId: 5,
    position: 1,
    body: "tin",
    meta: {
      links: [
        { url: TARGET_0, label: "example.org", role: "main" },
        { url: TARGET_1, label: "example.net", role: "related" },
      ],
    },
  });
});

afterAll(async () => {
  await db.$bun.close();
});

describe("token", () => {
  test("vector HMAC cố định tự tính: 128 bit đầu của HMAC-SHA256, base64url 22 ký tự", () => {
    const payload = "v1.12.3.0";
    const mac = createHmac("sha256", "k")
      .update(payload)
      .digest()
      .subarray(0, 16)
      .toString("base64url");
    expect(mac).toHaveLength(22);
    expect(signToken("k", { digestId: 12, position: 3, k: 0 })).toBe(`${payload}.${mac}`);
  });

  test("buildTrackingUrl rồi verifyToken khớp", () => {
    const url = buildTrackingUrl({
      baseUrl: `${BASE}/`,
      secret: SECRET,
      digestId: 7,
      position: 2,
      k: 3,
    });
    expect(url.startsWith(`${BASE}/o/v1.7.2.3.`)).toBe(true);
    expect(verifyToken(SECRET, url.slice(url.indexOf("/o/") + 3))).toEqual({
      digestId: 7,
      position: 2,
      k: 3,
    });
    expect(verifyToken("khoa-khac", url.slice(url.indexOf("/o/") + 3))).toBeNull();
  });

  test("từ chối tham số không phải số nguyên không âm khi dựng", () => {
    expect(() => signToken(SECRET, { digestId: -1, position: 1, k: 0 })).toThrow();
    expect(() => signToken(SECRET, { digestId: 1, position: 1.5, k: 0 })).toThrow();
    expect(() => signToken("", { digestId: 1, position: 1, k: 0 })).toThrow();
  });
});

describe("GET /o/:token", () => {
  test("hợp lệ: 302 tới URL trong DB, đúng header, đúng một dòng link_opens với profile_id của delivery", async () => {
    const w = web();
    const res = await open(w, tokenOf(1), { headers: { "user-agent": "Mozilla/5.0" } });
    await w.idle();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(TARGET_1);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const rows = await opens();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      profileId: 2, // = deliveries.profile_id, không phải hằng 1
      deliveryId: 1,
      linkIndex: 1,
      userAgent: "Mozilla/5.0",
      isPrefetch: false,
    });
  });

  test("UA của Telegram hoặc header prefetch chỉ gắn cờ, vẫn ghi; UA dài bị cắt 200 ký tự", async () => {
    const w = web();
    await open(w, tokenOf(0), { headers: { "user-agent": "TelegramBot (like TwitterBot)" } });
    await open(w, tokenOf(1), { headers: { purpose: "prefetch", "user-agent": "x".repeat(500) } });
    await w.idle();
    const rows = (await opens()).sort((a, b) => a.linkIndex - b.linkIndex);
    expect(rows.map((r) => r.isPrefetch)).toEqual([true, true]);
    expect(rows[1]?.userAgent).toHaveLength(200);
  });

  test("token sai: 404 và không ghi gì", async () => {
    const w = web();
    const good = tokenOf(0);
    const [v, d, p, k, mac] = good.split(".") as [string, string, string, string, string];
    const flip = (c: string) => (c === "a" ? "b" : "a");
    const bad = [
      `${v}.${d}.${p}.${k}.${flip(mac[0] as string)}${mac.slice(1)}`, // sửa 1 ký tự của MAC
      `${v}.2.${p}.${k}.${mac}`, // sửa digest_id
      `${v}.${d}.2.${k}.${mac}`, // sửa position
      `${v}.${d}.${p}.1.${mac}`, // sửa k
      `${v}.${d}.${p}.${k}`, // thiếu MAC
      `${v}.${d}.${p}.${mac}`, // thiếu phần k
      `v2.${d}.${p}.${k}.${mac}`, // sai tiền tố
      `${v}.${d}.${p}.${k}.${mac.slice(0, 21)}`, // MAC ngắn
      `${v}.${d}.${p}.${k}.${mac}A`, // MAC dài
      `${v}.01.${p}.${k}.${mac}`, // số dạng không chuẩn
      `${v}.${d}.${p}.-0.${mac}`,
      "rac",
    ];
    for (const t of bad) {
      const res = await open(w, encodeURIComponent(t));
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Not found");
    }
    await w.idle();
    expect(await opens()).toHaveLength(0);
  });

  test("token đúng MAC nhưng không có delivery hoặc k ngoài danh sách: 404, không ghi", async () => {
    const w = web();
    expect((await open(w, tokenOf(0, 99, 1))).status).toBe(404);
    expect((await open(w, tokenOf(0, 1, 5))).status).toBe(404);
    expect((await open(w, tokenOf(2))).status).toBe(404);
    await w.idle();
    expect(await opens()).toHaveLength(0);
  });

  test("mở lại trong 24 giờ không thêm dòng; sau 24 giờ thì thêm", async () => {
    const w = web();
    const t = tokenOf(0);
    await open(w, t);
    clock = new Date(clock.getTime() + 23 * 3600_000);
    expect((await open(w, t)).status).toBe(302);
    await w.idle();
    expect(await opens()).toHaveLength(1);
    // link khác cùng tin là một cặp khác
    await open(w, tokenOf(1));
    await w.idle();
    expect(await opens()).toHaveLength(2);
    clock = new Date(clock.getTime() + 2 * 3600_000); // tổng 25 giờ kể từ lần đầu
    await open(w, t);
    await w.idle();
    expect((await opens()).filter((r) => r.linkIndex === 0)).toHaveLength(2);
  });

  test("hai request đồng thời cùng token chỉ ra một dòng", async () => {
    const w = web();
    const t = tokenOf(0);
    const res = await Promise.all(Array.from({ length: 6 }, () => open(w, t)));
    await w.idle();
    expect(res.map((r) => r.status)).toEqual(Array(6).fill(302));
    expect(await opens()).toHaveLength(1);
  });

  test("không có LINK_SECRET: 404 mọi token, không ghi", async () => {
    const w = createWebApp({ db, secret: undefined, now: () => clock });
    for (const t of [tokenOf(0), tokenOf(1)]) expect((await open(w, t)).status).toBe(404);
    expect(
      (await open(createWebApp({ db, secret: "", now: () => clock }), tokenOf(0))).status,
    ).toBe(404);
    await w.idle();
    expect(await opens()).toHaveLength(0);
    expect((await w.app.request("/healthz")).status).toBe(200);
  });

  test("URL đích không lấy từ request: ?url= và ?next= bị bỏ qua", async () => {
    const w = web();
    const res = await w.app.request(
      `/o/${tokenOf(0)}?url=https://evil.example&next=https://evil.example/x&redirect=//evil.example`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(TARGET_0);
  });

  test("URL trong DB không phải http/https (javascript:, ftp:) thì 404", async () => {
    await db.execute(sql`update deliveries set meta = jsonb_build_object('links',
      jsonb_build_array(jsonb_build_object('url','javascript:alert(1)'), jsonb_build_object('url','ftp://x/y')))`);
    const w = web();
    expect((await open(w, tokenOf(0))).status).toBe(404);
    expect((await open(w, tokenOf(1))).status).toBe(404);
    await w.idle();
    expect(await opens()).toHaveLength(0);
  });

  test("lỗi ghi vẫn chuyển hướng 302", async () => {
    await db.execute(sql`alter table link_opens rename to link_opens_tmp`);
    try {
      const w = web();
      const res = await open(w, tokenOf(0));
      await w.idle();
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(TARGET_0);
    } finally {
      await db.execute(sql`alter table link_opens_tmp rename to link_opens`);
    }
    expect(await opens()).toHaveLength(0);
  });
});

describe("withTrackedLinks (nối vào soạn tin)", () => {
  const msg = {
    kind: "digest" as const,
    title: "t",
    lines: ["x"],
    links: [
      { url: "https://a.example/1", label: "a", role: "main" as const },
      { url: "https://b.example/2", label: "b", role: "related" as const },
    ],
  };

  test("không cấu hình thì giữ nguyên tin (link trực tiếp)", () => {
    expect(withTrackedLinks(msg, undefined, 1, 1)).toBe(msg);
  });

  test("có cấu hình: url thành link theo dõi k = 0,1; nhãn và vai trò giữ nguyên, tin gốc không đổi", () => {
    const out = withTrackedLinks(msg, { baseUrl: BASE, secret: SECRET }, 4, 2);
    expect(out.links?.map((l) => [l.label, l.role])).toEqual([
      ["a", "main"],
      ["b", "related"],
    ]);
    out.links?.forEach((l, k) => {
      expect(l.url).toBe(
        buildTrackingUrl({ baseUrl: BASE, secret: SECRET, digestId: 4, position: 2, k }),
      );
      expect(verifyToken(SECRET, l.url.slice(`${BASE}/o/`.length))).toEqual({
        digestId: 4,
        position: 2,
        k,
      });
    });
    expect(msg.links[0]?.url).toBe("https://a.example/1");
  });
});
