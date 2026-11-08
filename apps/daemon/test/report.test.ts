/**
 * Báo cáo nghiệm thu trên DB thử (`TEST_DATABASE_URL`): ngày thiếu digest, digest muộn, tin thử không
 * tính, lượt bấm mới nhất thắng, tỉ lệ fetch tách theo nguồn, chi phí theo ngày lịch giờ VN.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createDatabase,
  deliveries,
  digests,
  documents,
  events,
  feedback,
  fetchRuns,
  llmCalls,
  runMigrations,
  sources,
} from "@radard/db";
import { sql } from "drizzle-orm";
import { buildReport, formatReport, type Report, reportWindow } from "../src/jobs/report.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
/** Người nhận giả, không phải chat id thật. */
const ME = "100000001";
const H = 3_600_000;
const MIN = 60_000;
/** 07:15 giờ VN ngày 20/10: khung cuối là 07:00 ngày 20/10, cửa sổ từ 07:00 ngày 13/10. */
const NOW = new Date("2026-10-20T00:15:00Z");
const END = new Date("2026-10-20T00:00:00Z");
const START = new Date("2026-10-13T00:00:00Z");
/** Khung 07:00 giờ VN của ngày thứ `i` trong cửa sổ (1…7: 14/10 … 20/10). */
const slot = (i: number) => new Date(START.getTime() + i * 24 * H);

let hn = 0;
let trending = 0;
let msg = 0;

async function addRuns(sourceId: number, status: string, n: number, error?: string, at = START) {
  for (let i = 0; i < n; i++) {
    await db.insert(fetchRuns).values({
      sourceId,
      status,
      error: error ?? null,
      startedAt: new Date(at.getTime() + (i + 1) * H),
    });
  }
}

async function addDigest(
  periodEnd: Date,
  status: "sent" | "sending" | "failed",
  delayMin: number | null,
  ranking?: { candidates: number; passedGate: number },
): Promise<number> {
  const [d] = await db
    .insert(digests)
    .values({
      channel: "telegram",
      recipient: ME,
      periodStart: new Date(periodEnd.getTime() - 24 * H),
      periodEnd,
      status,
      lang: "vi",
      sentAt: delayMin === null ? null : new Date(periodEnd.getTime() + delayMin * MIN),
      meta: ranking ? { plan: { version: 1, ranking } } : {},
    })
    .returning({ id: digests.id });
  return d?.id ?? 0;
}

async function addDelivery(
  digestId: number | null,
  position: number,
  sentAt?: Date,
): Promise<number> {
  const kind = digestId === null ? "test" : position === 0 ? "header" : "event";
  const [d] = await db
    .insert(deliveries)
    .values({
      digestId,
      channel: "telegram",
      recipient: ME,
      messageId: String(++msg),
      kind,
      position: digestId === null ? null : position,
      eventId: kind === "event" ? position : null,
      body: "tin",
      ...(sentAt ? { sentAt } : {}),
    })
    .returning({ id: deliveries.id });
  return d?.id ?? 0;
}

async function press(deliveryId: number, ...kinds: ("like" | "dislike" | "clear" | "comment")[]) {
  for (const kind of kinds) {
    await db.insert(feedback).values({
      deliveryId,
      channel: "telegram",
      recipient: ME,
      kind,
      text: kind === "comment" ? "hay" : null,
    });
  }
}

async function addCall(at: string, task: string, costUsd: number) {
  await db.insert(llmCalls).values({
    at: new Date(at),
    task,
    provider: "fake",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    reasoningTokens: 0,
    costUsd,
    latencyMs: 1,
    ok: true,
  });
}

async function addDoc(sourceId: number, fetchedAt: string, publishedAt?: string) {
  const id = ++msg;
  await db.insert(documents).values({
    sourceId,
    externalId: String(id),
    url: `https://x.com/${id}`,
    urlCanonical: `https://x.com/${id}`,
    fetchedAt: new Date(fetchedAt),
    ...(publishedAt ? { publishedAt: new Date(publishedAt) } : {}),
    contentSha256: `s${id}`,
    rawKey: `r/${id}`,
    contentType: "application/json",
  });
}

async function addEvent(firstSeenAt: string) {
  const v = new Array(1024).fill(0);
  v[++msg % 1024] = 1;
  const at = new Date(firstSeenAt);
  await db
    .insert(events)
    .values({ title: "e", firstSeenAt: at, lastSeenAt: at, centroid: v, embeddingModel: "m" });
}

/** Các delivery sự kiện của digest ngày 1 và ngày 2, kèm một tin thử và một tin ngoài cửa sổ. */
const ev: Record<string, number> = {};

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  msg = 0;
  await db.execute(
    sql`truncate sources, digests, deliveries, feedback, llm_calls, events restart identity cascade`,
  );
  const rows = await db
    .insert(sources)
    .values([
      { kind: "hn", name: "HN", cadence: "*/15 * * * *" },
      { kind: "github_trending", name: "GitHub Trending", cadence: "0 * * * *" },
    ])
    .returning({ id: sources.id });
  hn = rows[0]?.id ?? 0;
  trending = rows[1]?.id ?? 0;

  // HN: 19/20 thành công (95%, vừa đạt). Trending: 2/5 (2 lỗi, 1 lượt kẹt ở running).
  await addRuns(hn, "ok", 15);
  await addRuns(hn, "not_modified", 3);
  await addRuns(hn, "behind", 1);
  await addRuns(hn, "error", 1, `HTTP 503 ${"x".repeat(200)}`);
  await addRuns(trending, "ok", 2);
  await addRuns(trending, "error", 2, "selector không khớp");
  await addRuns(trending, "running", 1);
  // Ngoài cửa sổ (trước 07:00 ngày 13/10): không tính.
  await addRuns(hn, "error", 5, "cũ", new Date(START.getTime() - 10 * H));

  // Digest: ngày 3 thiếu, ngày 5 muộn 25 phút, ngày 6 lỗi; khung đầu cửa sổ (13/10) không tính.
  const d1 = await addDigest(slot(1), "sent", 2, { candidates: 120, passedGate: 30 });
  const d2 = await addDigest(slot(2), "sent", 9.5, { candidates: 80, passedGate: 0 });
  await addDigest(slot(4), "sent", 3);
  await addDigest(slot(5), "sent", 25);
  await addDigest(slot(6), "failed", null);
  await addDigest(slot(7), "sent", 1);
  const old = await addDigest(START, "sent", 1);

  await addDelivery(d1, 0, new Date(slot(1).getTime() + 2 * MIN));
  for (const p of [1, 2, 3]) ev[`d1p${p}`] = await addDelivery(d1, p);
  for (const p of [1, 2]) ev[`d2p${p}`] = await addDelivery(d2, p);
  ev.test = await addDelivery(null, 0);
  ev.old = await addDelivery(old, 1);

  await press(ev.d1p1 ?? 0, "like", "dislike"); // đổi ý: 👎
  await press(ev.d1p2 ?? 0, "like");
  await press(ev.d1p3 ?? 0, "dislike", "like", "comment"); // đổi ý: 👍; nhận xét không tính
  await press(ev.d2p1 ?? 0, "comment"); // chỉ nhận xét: chưa bấm
  await press(ev.test ?? 0, "like", "like", "like");
  await press(ev.old ?? 0, "like");

  // Chi phí: ngày lịch 13/10 giờ VN bắt đầu 12/10 17:00 UTC.
  await addCall("2026-10-12T16:59:00Z", "digest", 5); // 12/10 23:59 VN: ngoài
  await addCall("2026-10-12T17:00:00Z", "digest", 0.03); // 13/10 00:00 VN
  await addCall("2026-10-13T16:59:00Z", "embed", 0.001); // 13/10 23:59 VN
  await addCall("2026-10-15T03:00:00Z", "digest", 0.08);
  await addCall("2026-10-15T04:00:00Z", "topic", 0.04); // 15/10: 0,12 > trần

  await addDoc(hn, "2026-10-13T01:00:00Z");
  await addDoc(hn, "2026-10-13T02:00:00Z");
  await addDoc(trending, "2026-10-13T18:00:00Z"); // 14/10 01:00 VN
  await addDoc(hn, "2026-10-19T17:00:00Z"); // 20/10 00:00 VN: ngoài
  await addEvent("2026-10-13T05:00:00Z");
  await addEvent("2026-10-13T06:00:00Z");
  await addEvent("2026-10-18T10:00:00Z");
});

afterAll(async () => {
  await db.$bun.close();
});

const report = (): Promise<Report> => buildReport(db, reportWindow(NOW));

describe("reportWindow", () => {
  test("7 khung 07:00 và 7 ngày lịch giờ VN trọn vẹn", () => {
    const w = reportWindow(NOW);
    expect(w.start).toEqual(START);
    expect(w.end).toEqual(END);
    expect(w.slots).toEqual([1, 2, 3, 4, 5, 6, 7].map(slot));
    expect(w.days).toEqual([
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
    ]);
    expect(w.dayStart).toEqual(new Date("2026-10-12T17:00:00Z"));
  });

  test("lúc 07:05 khung hôm nay chưa quá hạn: cửa sổ kết thúc ở khung hôm qua", () => {
    expect(reportWindow(new Date("2026-10-20T00:05:00Z")).end).toEqual(slot(6));
    expect(reportWindow(new Date("2026-10-20T00:10:00Z")).end).toEqual(END);
  });

  test("--since=24h: một khung, một ngày", () => {
    const w = reportWindow(NOW, 24);
    expect(w.slots).toEqual([END]);
    expect(w.days).toEqual(["2026-10-19"]);
  });
});

describe("buildReport", () => {
  test("fetch: tỉ lệ chung và theo nguồn, lỗi gộp theo 100 ký tự đầu", async () => {
    const f = (await report()).fetch;
    expect([f.ok, f.total]).toEqual([21, 25]);
    expect(f.pass).toBe(false);
    expect(f.bySource).toEqual([
      { source: "GitHub Trending", total: 5, ok: 2, rate: 0.4, pass: false },
      { source: "HN", total: 20, ok: 19, rate: 0.95, pass: true },
    ]);
    expect(f.errors.map((e) => [e.source, e.status, e.n, e.error.length])).toEqual([
      ["GitHub Trending", "error", 2, "selector không khớp".length],
      ["GitHub Trending", "running", 1, 0],
      ["HN", "error", 1, 100],
    ]);
  });

  test("digest: ngày thiếu, muộn > 10 phút, lỗi đều không đúng giờ", async () => {
    const d = (await report()).digests;
    expect([d.onTime, d.expected, d.pass]).toEqual([4, 7, false]);
    expect(d.days.map((x) => [x.date, x.status, x.delayMin, x.onTime, x.items])).toEqual([
      ["2026-10-14", "sent", 2, true, 3],
      ["2026-10-15", "sent", 9.5, true, 2],
      ["2026-10-16", "missing", null, false, 0],
      ["2026-10-17", "sent", 3, true, 0],
      ["2026-10-18", "sent", 25, false, 0],
      ["2026-10-19", "failed", null, false, 0],
      ["2026-10-20", "sent", 1, true, 0],
    ]);
    expect([d.days[0]?.candidates, d.days[0]?.passedGate]).toEqual([120, 30]);
    expect(d.days[3]?.candidates).toBeNull();
  });

  test("digest: đo theo tin mở đầu, không theo digests.sent_at", async () => {
    // Ngày 3 (16/10, đang thiếu): tin mở đầu 1 phút nhưng digests.sent_at muộn 40 phút -> đúng giờ.
    const onTime = await addDigest(slot(3), "sent", 40);
    await addDelivery(onTime, 0, new Date(slot(3).getTime() + MIN));
    // Ngày 5: digests.sent_at chỉ 1 phút nhưng tin mở đầu muộn 15 phút -> không đúng giờ.
    await db.execute(sql`update digests set sent_at = period_end + interval '1 minute'
      where period_end = ${slot(5)}`);
    const late = await db.execute<{ id: number }>(
      sql`select id from digests where period_end = ${slot(5)}`,
    );
    await addDelivery([...late][0]?.id ?? 0, 0, new Date(slot(5).getTime() + 15 * MIN));
    const days = (await report()).digests.days;
    expect([days[2]?.delayMin, days[2]?.onTime, days[2]?.headerFallback]).toEqual([1, true, false]);
    expect([days[4]?.delayMin, days[4]?.onTime, days[4]?.headerFallback]).toEqual([
      15,
      false,
      false,
    ]);
  });

  test("digest: chưa có tin mở đầu thì dùng digests.sent_at và ghi chú", async () => {
    const days = (await report()).digests.days;
    // Ngày 1 có tin mở đầu; ngày 2 (digest 9,5 phút) chưa có.
    expect([days[0]?.delayMin, days[0]?.headerFallback]).toEqual([2, false]);
    expect([days[1]?.delayMin, days[1]?.onTime, days[1]?.headerFallback]).toEqual([
      9.5,
      true,
      true,
    ]);
    const table = formatReport(await report()).find(
      (b) => Array.isArray(b) && b[0] && "tin mở đầu lúc" in b[0],
    ) as Record<string, unknown>[];
    expect(table[0]?.["ghi chú"]).toBe("");
    expect(String(table[1]?.["ghi chú"])).toContain("digests.sent_at");
  });

  test("phản hồi: chỉ tin sự kiện trong cửa sổ, lượt bấm mới nhất thắng", async () => {
    const f = (await report()).feedback;
    // 5 tin sự kiện (tin thử và tin của khung ngoài cửa sổ không tính); 3 tin đã bấm.
    expect(f).toEqual({
      pass: false,
      deliveries: 5,
      rated: 3,
      rate: 0.6,
      likes: 2,
      dislikes: 1,
      likeShare: 2 / 3,
    });
  });

  test("phản hồi: bấm thêm một tin thì đạt 70%", async () => {
    await press(ev.d2p1 ?? 0, "dislike");
    const f = (await report()).feedback;
    expect([f.rated, f.rate, f.pass, f.dislikes]).toEqual([4, 0.8, true, 2]);
  });

  test("phản hồi: tin đã bỏ chọn (clear) không tính là có phản hồi, bấm lại thì tính lại", async () => {
    await press(ev.d2p1 ?? 0, "like", "clear");
    expect((await report()).feedback.rated).toBe(3);
    await press(ev.d2p1 ?? 0, "dislike");
    expect((await report()).feedback.rated).toBe(4);
  });

  test("chi phí: theo ngày lịch giờ VN, theo việc, ngày vượt trần bị đánh dấu", async () => {
    const c = (await report()).cost;
    expect(c.days).toHaveLength(7);
    const day13 = c.days[0];
    expect(day13?.day).toBe("2026-10-13");
    expect(day13?.usd).toBeCloseTo(0.031, 8);
    expect(day13?.byTask).toEqual({ digest: 0.03, embed: 0.001 });
    expect(c.days[2]?.usd).toBeCloseTo(0.12, 8);
    expect(c.days.filter((d) => d.over).map((d) => d.day)).toEqual(["2026-10-15"]);
    expect(c.days[1]).toEqual({ day: "2026-10-14", usd: 0, byTask: {}, over: false });
    expect(c.pass).toBe(false);
    expect(c.total).toBeCloseTo(0.151, 8);
    expect(c.tasks.map((t) => [t.task, t.calls])).toEqual([
      ["digest", 2],
      ["topic", 1],
      ["embed", 1],
    ]);
  });

  test("số liệu: tài liệu theo ngày đăng, bài lấy bù tính về ngày đăng; 'lấy về' theo fetched_at", async () => {
    // Lấy bù: đăng 17/10 10:00 VN, tải về 19/10 10:00 VN.
    await addDoc(hn, "2026-10-19T03:00:00Z", "2026-10-17T03:00:00Z");
    const m = (await report()).metrics;
    const day = (d: string) => m.docsPerDay.find((x) => x.day === d);
    expect(day("2026-10-17")).toEqual({
      day: "2026-10-17",
      bySource: { "GitHub Trending": 0, HN: 1 },
      total: 1,
      fetched: 0,
    });
    expect(day("2026-10-19")).toEqual({
      day: "2026-10-19",
      bySource: { "GitHub Trending": 0, HN: 0 },
      total: 0,
      fetched: 1,
    });
    // Không có published_at (3 tài liệu cũ) thì đếm theo fetched_at ở cả hai cột.
    expect(day("2026-10-13")).toMatchObject({ total: 2, fetched: 2 });
    expect(day("2026-10-14")).toMatchObject({ total: 1, fetched: 1 });
    const block = formatReport(await report()).find(
      (b) => Array.isArray(b) && b[0] && "lấy về" in b[0],
    ) as Record<string, unknown>[];
    expect(block[4]).toMatchObject({ "tổng tài liệu đăng": 1, "lấy về": 0 });
  });

  test("số liệu: tài liệu/ngày theo nguồn, sự kiện/ngày", async () => {
    const m = (await report()).metrics;
    expect(m.sources).toEqual(["GitHub Trending", "HN"]);
    expect(m.docsPerDay[0]).toEqual({
      day: "2026-10-13",
      bySource: { "GitHub Trending": 0, HN: 2 },
      total: 2,
      fetched: 2,
    });
    expect(m.docsPerDay[1]?.bySource).toEqual({ "GitHub Trending": 1, HN: 0 });
    expect(m.docsPerDay.reduce((a, d) => a + d.total, 0)).toBe(3);
    expect(m.eventsPerDay.map((e) => e.n)).toEqual([2, 0, 0, 0, 0, 1, 0]);
  });

  test("tổng: chỉ đạt khi cả bốn tiêu chí đạt; bản in có ✓ / ✗", async () => {
    const r = await report();
    expect(r.pass).toBe(false);
    const text = formatReport(r)
      .filter((b): b is string => typeof b === "string")
      .join("\n");
    expect(text).toContain("✗ 1. Fetch thành công ≥ 95,0%: 84,0% (21/25 lượt)");
    expect(text).toContain("✗ 2. Digest đúng giờ (tin mở đầu lệch < 10 phút sau 07:00): 4/7");
    expect(text).toContain("✗ 3. ≥ 70% tin sự kiện có ít nhất một 👍 hoặc 👎: 60,0% (3/5 tin)");
    expect(text).toContain("✗ Tổng: đạt 0/4 tiêu chí");
  });

  test("đủ điều kiện thì đạt", async () => {
    await db.execute(sql`delete from fetch_runs where status not in ('ok', 'not_modified')`);
    await db.execute(
      sql`update digests set status = 'sent', sent_at = period_end + interval '1 minute'`,
    );
    await addDigest(slot(3), "sent", 4);
    await db.execute(sql`delete from llm_calls where task = 'topic'`);
    await press(ev.d2p1 ?? 0, "like");
    const r = await report();
    expect([r.fetch.pass, r.digests.pass, r.feedback.pass, r.cost.pass, r.pass]).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(formatReport(r).at(-1)).toBe("✓ Tổng: đạt 4/4 tiêu chí");
  });
});
