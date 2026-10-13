/**
 * Báo cáo nghiệm thu 7 ngày (tuan-3-thuc-thi.html, bước 9): chấm từng tiêu chí, đọc thẳng từ các
 * bảng. Không gọi mạng, không gọi model.
 *
 *   1. ≥ 95% lượt fetch thành công (ok, not_modified, behind): chung và theo từng nguồn, vì một
 *      trang cào (GitHub Trending) hỏng không được che mất việc các nguồn còn lại có khoẻ không.
 *   2. Mọi digest đến đúng giờ: `sent`, tin MỞ ĐẦU tới người dùng lệch < 10 phút sau khung 07:00
 *      giờ VN (`deliveries.sent_at` của tin header, vị trí 0; chưa có thì dùng `digests.sent_at`).
 *   3. ≥ 70% tin sự kiện có ít nhất một 👍/👎 (D6, chốt 13/10/2026). Chỉ `deliveries.kind = 'event'`; mỗi tin lấy
 *      lượt bấm MỚI NHẤT (feedback chỉ ghi thêm, đổi ý là dòng mới).
 *   4. Chi phí model < $0,1 mỗi ngày lịch giờ VN.
 *   5. Số liệu đầu tiên: tài liệu/ngày theo nguồn, sự kiện/ngày, số sự kiện qua cổng mỗi digest,
 *      tỉ lệ 👍.
 *
 * Cửa sổ: các khoảng 24 giờ của digest kết thúc ở khung 07:00 gần nhất đã quá hạn gửi. Fetch,
 * digest và phản hồi tính theo cửa sổ này; chi phí và số liệu theo ngày tính theo NGÀY LỊCH giờ VN
 * (00:00 → 24:00) nằm trọn trước khung cuối.
 */
import { type Database, digests } from "@radard/db";
import { and, asc, gt, lte, sql } from "drizzle-orm";
import { type DigestPlan, digestSlot } from "./digest.ts";

/** VN không đổi giờ theo mùa nên lệch UTC cố định +7 (như digest.ts). */
const VN_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export const FETCH_MIN_SUCCESS = 0.95;
/** Digest đến đúng giờ khi lệch so với khung dưới chừng này phút. */
export const DIGEST_MAX_DELAY_MIN = 10;
export const FEEDBACK_MIN_RATED = 0.7;
export const COST_MAX_USD_PER_DAY = 0.1;
/** Trạng thái fetch tính là thành công: `behind` là đã lấy được, chỉ chưa bắt kịp hiện tại. */
export const FETCH_OK_STATUSES = ["ok", "not_modified", "behind"] as const;
const ERROR_SNIPPET_CHARS = 100;

// ---------------------------------------------------------------------------------------------
// Kiểu dữ liệu trả về

export interface ReportWindow {
  /** Khoảng [start, end) cho fetch; khoảng (start, end] cho mốc kết thúc của digest. */
  start: Date;
  end: Date;
  /** Các khung 07:00 giờ VN trong cửa sổ, cũ trước. Mỗi khung phải có một digest. */
  slots: Date[];
  /** Ngày lịch giờ VN [dayStart, dayEnd), dạng `2026-10-12`, cũ trước. */
  days: string[];
  dayStart: Date;
  dayEnd: Date;
}

export interface FetchSourceRow {
  source: string;
  total: number;
  ok: number;
  rate: number | null;
  pass: boolean;
}

export interface FetchErrorGroup {
  source: string;
  status: string;
  /** 100 ký tự đầu của lỗi; trống khi lượt còn `running` (đang chạy hoặc bị bỏ dở). */
  error: string;
  n: number;
  lastAt: Date;
}

export interface FetchReport {
  pass: boolean;
  total: number;
  ok: number;
  rate: number | null;
  bySource: FetchSourceRow[];
  errors: FetchErrorGroup[];
}

export interface DigestDay {
  slot: Date;
  /** Ngày của khung, giờ VN: `2026-10-13`. */
  date: string;
  digestId: number | null;
  status: "sent" | "sending" | "failed" | "missing";
  /** Lúc tin mở đầu tới người dùng; chưa có tin mở đầu thì là `digests.sent_at`. */
  sentAt: Date | null;
  /** Chưa có delivery tin mở đầu nên `sentAt` lấy từ `digests.sent_at` (sau tin cuối). */
  headerFallback: boolean;
  /** Phút từ khung 07:00 tới `sentAt`; trống khi digest chưa `sent`. */
  delayMin: number | null;
  onTime: boolean;
  /** Số tin sự kiện đã gửi (deliveries `event`), không tính tin mở đầu. */
  items: number;
  /** Từ `meta.plan.ranking`; trống khi chưa có plan. */
  candidates: number | null;
  passedGate: number | null;
}

export interface DigestReport {
  pass: boolean;
  onTime: number;
  expected: number;
  days: DigestDay[];
}

export interface FeedbackReport {
  pass: boolean;
  /** Tin sự kiện của các digest trong cửa sổ. */
  deliveries: number;
  /** Tin có ít nhất một 👍/👎. */
  rated: number;
  rate: number | null;
  /** Theo lượt bấm mới nhất của mỗi tin. */
  likes: number;
  dislikes: number;
  likeShare: number | null;
}

export interface CostDay {
  day: string;
  usd: number;
  byTask: Record<string, number>;
  over: boolean;
}

export interface CostReport {
  pass: boolean;
  total: number;
  days: CostDay[];
  tasks: { task: string; usd: number; calls: number }[];
}

export interface MetricsReport {
  sources: string[];
  docsPerDay: { day: string; bySource: Record<string, number>; total: number }[];
  /** Theo `events.first_seen_at` (bảng events không có giờ tạo; `events rebuild` dựng lại). */
  eventsPerDay: { day: string; n: number }[];
}

export interface Report {
  window: ReportWindow;
  fetch: FetchReport;
  digests: DigestReport;
  feedback: FeedbackReport;
  cost: CostReport;
  metrics: MetricsReport;
  pass: boolean;
}

// ---------------------------------------------------------------------------------------------
// Cửa sổ

/** 00:00 giờ VN của ngày chứa `d`. */
function vnMidnight(d: Date): Date {
  const t = d.getTime() + VN_OFFSET_MS;
  return new Date(t - (t % DAY_MS) - VN_OFFSET_MS);
}

/** `2026-10-12`: ngày giờ VN chứa `d`. */
export function vnDay(d: Date): string {
  return new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Cửa sổ `hours` giờ kết thúc ở khung 07:00 gần nhất ĐÃ QUÁ HẠN gửi (07:10): chạy lúc 07:05 thì
 * khung hôm nay chưa tính, để digest đang gửi không bị chấm là thiếu.
 */
export function reportWindow(now: Date, hours = 7 * 24): ReportWindow {
  const end = digestSlot(new Date(now.getTime() - DIGEST_MAX_DELAY_MIN * MINUTE_MS));
  const start = new Date(end.getTime() - hours * 3_600_000);
  const slots: Date[] = [];
  for (let t = end.getTime(); t > start.getTime(); t -= DAY_MS) slots.unshift(new Date(t));
  const dayStart = vnMidnight(start);
  const dayEnd = vnMidnight(end);
  const days: string[] = [];
  for (let t = dayStart.getTime(); t < dayEnd.getTime(); t += DAY_MS) days.push(vnDay(new Date(t)));
  return { start, end, slots, days, dayStart, dayEnd };
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);

// ---------------------------------------------------------------------------------------------
// 1. Fetch

const OK_LIST = sql.raw(FETCH_OK_STATUSES.map((s) => `'${s}'`).join(", "));

async function fetchReport(db: Database, w: ReportWindow): Promise<FetchReport> {
  const rows = [
    ...(await db.execute<{ source: string; total: number; ok: number }>(sql`
      select s.name source, count(*)::int total,
        count(*) filter (where fr.status in (${OK_LIST}))::int ok
      from fetch_runs fr join sources s on s.id = fr.source_id
      where fr.started_at >= ${w.start} and fr.started_at < ${w.end}
      group by s.name order by s.name`)),
  ];
  const errors = [
    ...(await db.execute<{
      source: string;
      status: string;
      error: string;
      n: number;
      last_at: Date | string;
    }>(sql`
      select s.name source, fr.status, left(coalesce(fr.error, ''), ${ERROR_SNIPPET_CHARS}) error,
        count(*)::int n, max(fr.started_at) last_at
      from fetch_runs fr join sources s on s.id = fr.source_id
      where fr.started_at >= ${w.start} and fr.started_at < ${w.end}
        and fr.status not in (${OK_LIST})
      group by 1, 2, 3 order by n desc, source`)),
  ];
  const bySource = rows.map((r) => {
    const rate = ratio(r.ok, r.total);
    return {
      source: r.source,
      total: r.total,
      ok: r.ok,
      rate,
      pass: rate !== null && rate >= FETCH_MIN_SUCCESS,
    };
  });
  const total = rows.reduce((a, r) => a + r.total, 0);
  const ok = rows.reduce((a, r) => a + r.ok, 0);
  const rate = ratio(ok, total);
  // Cố ý: lượt kẹt ở `running` không nằm trong FETCH_OK_STATUSES nên tính là hỏng (lượt chưa xong là lượt hỏng).
  return {
    pass: rate !== null && rate >= FETCH_MIN_SUCCESS,
    total,
    ok,
    rate,
    bySource,
    errors: errors.map((e) => ({
      source: e.source,
      status: e.status,
      error: e.error,
      n: e.n,
      lastAt: new Date(e.last_at),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// 2. Digest

type DigestRow = {
  id: number;
  periodEnd: Date;
  status: string;
  sentAt: Date | null;
  /** `deliveries.sent_at` của tin mở đầu (kind `header`, vị trí 0); trống khi chưa có. */
  headerSentAt: Date | null;
  meta: Record<string, unknown>;
  items: number;
};

function digestDay(slot: Date, row: DigestRow | undefined): DigestDay {
  const base = { slot, date: vnDay(slot) };
  if (!row) {
    return {
      ...base,
      digestId: null,
      status: "missing",
      sentAt: null,
      headerFallback: false,
      delayMin: null,
      onTime: false,
      items: 0,
      candidates: null,
      passedGate: null,
    };
  }
  const headerFallback = row.headerSentAt === null;
  const arrivedAt = row.headerSentAt ?? row.sentAt;
  const sent = row.status === "sent" && arrivedAt !== null;
  const delayMin =
    sent && arrivedAt ? Math.round((arrivedAt.getTime() - slot.getTime()) / 6_000) / 10 : null;
  const ranking = (row.meta.plan as DigestPlan | undefined)?.ranking;
  return {
    ...base,
    digestId: row.id,
    status: row.status as DigestDay["status"],
    sentAt: arrivedAt,
    headerFallback: headerFallback && arrivedAt !== null,
    delayMin,
    onTime: delayMin !== null && delayMin >= 0 && delayMin < DIGEST_MAX_DELAY_MIN,
    items: row.items,
    candidates: ranking?.candidates ?? null,
    passedGate: ranking?.passedGate ?? null,
  };
}

async function digestReport(db: Database, w: ReportWindow): Promise<DigestReport> {
  const rows: DigestRow[] = await db
    .select({
      id: digests.id,
      periodEnd: digests.periodEnd,
      status: digests.status,
      sentAt: digests.sentAt,
      // `digests.sent_at` đặt SAU tin cuối nên không đo được giờ người dùng nhận tin đầu.
      headerSentAt: sql<Date | null>`(select h.sent_at from deliveries h
        where h.digest_id = digests.id and h.kind = 'header' and h.position = 0)`,
      meta: digests.meta,
      // Ghi rõ `digests.id`: trong truy vấn con, "id" trần sẽ bị hiểu là id của deliveries.
      items: sql<number>`(select count(*)::int from deliveries x
        where x.digest_id = digests.id and x.kind = 'event')`,
    })
    .from(digests)
    .where(and(gt(digests.periodEnd, w.start), lte(digests.periodEnd, w.end)))
    .orderBy(asc(digests.id));
  // MVP-0 có một người nhận: mỗi khung một dòng. Nhiều dòng cùng khung thì lấy dòng tạo trước.
  const bySlot = new Map<number, DigestRow>();
  for (const r of rows) {
    if (!bySlot.has(r.periodEnd.getTime())) {
      bySlot.set(r.periodEnd.getTime(), {
        ...r,
        headerSentAt: r.headerSentAt === null ? null : new Date(r.headerSentAt),
      });
    }
  }
  const days = w.slots.map((s) => digestDay(s, bySlot.get(s.getTime())));
  const onTime = days.filter((d) => d.onTime).length;
  return { pass: days.length > 0 && onTime === days.length, onTime, expected: days.length, days };
}

// ---------------------------------------------------------------------------------------------
// 3. Phản hồi

async function feedbackReport(db: Database, w: ReportWindow): Promise<FeedbackReport> {
  const [r] = [
    ...(await db.execute<{ deliveries: number; rated: number; likes: number; dislikes: number }>(
      sql`
      with ev as (
        select dl.id from deliveries dl join digests d on d.id = dl.digest_id
        where dl.kind = 'event' and d.period_end > ${w.start} and d.period_end <= ${w.end}
      ), latest as (
        -- feedback chỉ ghi thêm: dòng mới nhất (id lớn nhất) là ý kiến hiện tại
        select distinct on (f.delivery_id) f.delivery_id, f.kind
        from feedback f join ev on ev.id = f.delivery_id
        where f.kind in ('like', 'dislike')
        order by f.delivery_id, f.id desc
      )
      select (select count(*)::int from ev) deliveries, count(*)::int rated,
        count(*) filter (where kind = 'like')::int likes,
        count(*) filter (where kind = 'dislike')::int dislikes
      from latest`,
    )),
  ];
  const { deliveries = 0, rated = 0, likes = 0, dislikes = 0 } = r ?? {};
  const rate = ratio(rated, deliveries);
  return {
    pass: rate !== null && rate >= FEEDBACK_MIN_RATED,
    deliveries,
    rated,
    rate,
    likes,
    dislikes,
    likeShare: ratio(likes, rated),
  };
}

// ---------------------------------------------------------------------------------------------
// 4. Chi phí

async function costReport(db: Database, w: ReportWindow): Promise<CostReport> {
  const rows = [
    ...(await db.execute<{ day: string; task: string; usd: number; calls: number }>(sql`
      select to_char(at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') as day, task,
        sum(cost_usd)::float8 usd, count(*)::int calls
      from llm_calls where at >= ${w.dayStart} and at < ${w.dayEnd}
      group by 1, 2 order by 1, 2`)),
  ];
  const days: CostDay[] = w.days.map((day) => {
    const mine = rows.filter((r) => r.day === day);
    const usd = mine.reduce((a, r) => a + r.usd, 0);
    return {
      day,
      usd,
      byTask: Object.fromEntries(mine.map((r) => [r.task, r.usd])),
      over: usd >= COST_MAX_USD_PER_DAY,
    };
  });
  const tasks = new Map<string, { task: string; usd: number; calls: number }>();
  for (const r of rows) {
    const t = tasks.get(r.task) ?? { task: r.task, usd: 0, calls: 0 };
    t.usd += r.usd;
    t.calls += r.calls;
    tasks.set(r.task, t);
  }
  return {
    pass: days.length > 0 && days.every((d) => !d.over),
    total: days.reduce((a, d) => a + d.usd, 0),
    days,
    tasks: [...tasks.values()].sort((a, b) => b.usd - a.usd),
  };
}

// ---------------------------------------------------------------------------------------------
// 5. Số liệu đầu tiên

async function metricsReport(db: Database, w: ReportWindow): Promise<MetricsReport> {
  const docs = [
    ...(await db.execute<{ day: string; source: string; n: number }>(sql`
      select to_char(d.fetched_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') as day,
        s.name source, count(*)::int n
      from documents d join sources s on s.id = d.source_id
      where d.fetched_at >= ${w.dayStart} and d.fetched_at < ${w.dayEnd}
      group by 1, 2`)),
  ];
  const evs = [
    ...(await db.execute<{ day: string; n: number }>(sql`
      select to_char(first_seen_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') as day,
        count(*)::int n
      from events where first_seen_at >= ${w.dayStart} and first_seen_at < ${w.dayEnd}
      group by 1`)),
  ];
  const sources = [...new Set(docs.map((d) => d.source))].sort();
  const docsPerDay = w.days.map((day) => {
    const bySource: Record<string, number> = Object.fromEntries(sources.map((s) => [s, 0]));
    for (const d of docs) if (d.day === day) bySource[d.source] = d.n;
    return { day, bySource, total: Object.values(bySource).reduce((a, n) => a + n, 0) };
  });
  const eventsPerDay = w.days.map((day) => ({
    day,
    n: evs.find((e) => e.day === day)?.n ?? 0,
  }));
  return { sources, docsPerDay, eventsPerDay };
}

// ---------------------------------------------------------------------------------------------

export async function buildReport(db: Database, w: ReportWindow): Promise<Report> {
  const fetch = await fetchReport(db, w);
  const digestsOut = await digestReport(db, w);
  const feedback = await feedbackReport(db, w);
  const cost = await costReport(db, w);
  const metrics = await metricsReport(db, w);
  return {
    window: w,
    fetch,
    digests: digestsOut,
    feedback,
    cost,
    metrics,
    pass: fetch.pass && digestsOut.pass && feedback.pass && cost.pass,
  };
}

// ---------------------------------------------------------------------------------------------
// Trình bày: mỗi phần là các dòng chữ và bảng; cli.ts chỉ việc in (console.log / console.table).

export type Block = string | Record<string, unknown>[];

const mark = (pass: boolean) => (pass ? "✓" : "✗");
/** Số thập phân kiểu Việt: dấu phẩy. */
const dec = (x: number, digits: number) => x.toFixed(digits).replace(".", ",");
const pct = (x: number | null) => (x === null ? "—" : `${dec(x * 100, 1)}%`);
const usd = (x: number) => `$${dec(x, 4)}`;
/** `13/10 07:04` giờ VN. */
function vnTime(d: Date): string {
  const s = new Date(d.getTime() + VN_OFFSET_MS).toISOString();
  return `${s.slice(8, 10)}/${s.slice(5, 7)} ${s.slice(11, 16)}`;
}

function fetchBlocks(f: FetchReport): Block[] {
  const out: Block[] = [
    `${mark(f.pass)} 1. Fetch thành công ≥ ${pct(FETCH_MIN_SUCCESS)}: ${pct(f.rate)} (${f.ok}/${f.total} lượt)`,
  ];
  if (f.bySource.length) {
    out.push(
      f.bySource.map((s) => ({
        nguồn: s.source,
        lượt: s.total,
        "thành công": s.ok,
        "tỉ lệ": pct(s.rate),
        đạt: mark(s.pass),
      })),
    );
  }
  const weak = f.bySource.filter((s) => !s.pass).map((s) => s.source);
  if (weak.length) out.push(`   Nguồn dưới ${pct(FETCH_MIN_SUCCESS)}: ${weak.join(", ")}`);
  if (f.errors.length) {
    out.push("   Lượt hỏng, gộp theo lỗi:");
    out.push(
      f.errors.map((e) => ({
        nguồn: e.source,
        status: e.status,
        lần: e.n,
        "gần nhất": vnTime(e.lastAt),
        lỗi: e.error || "(đang chạy hoặc bị bỏ dở)",
      })),
    );
  }
  return out;
}

const STATUS_VI: Record<DigestDay["status"], string> = {
  sent: "đã gửi",
  sending: "đang gửi",
  failed: "lỗi",
  missing: "không có",
};

function digestBlocks(d: DigestReport): Block[] {
  return [
    `${mark(d.pass)} 2. Digest đúng giờ (tin mở đầu lệch < ${DIGEST_MAX_DELAY_MIN} phút sau 07:00): ${d.onTime}/${d.expected}`,
    d.days.map((x) => ({
      ngày: x.date,
      "trạng thái": STATUS_VI[x.status],
      "tin mở đầu lúc": x.sentAt ? vnTime(x.sentAt) : "",
      "lệch (phút)": x.delayMin === null ? "" : dec(x.delayMin, 1),
      tin: x.items,
      "đúng giờ": mark(x.onTime),
      "ghi chú": x.headerFallback ? "chưa có tin mở đầu, dùng digests.sent_at" : "",
    })),
  ];
}

function feedbackBlocks(f: FeedbackReport): Block[] {
  return [
    // D6, chốt 13/10/2026: chỉ tiêu chí tỉ lệ này; KHÔNG có dòng đạt/không đạt theo số lượt tuyệt đối.
    `${mark(f.pass)} 3. ≥ ${Math.round(FEEDBACK_MIN_RATED * 100)}% tin sự kiện có ít nhất một 👍 hoặc 👎: ${pct(f.rate)} (${f.rated}/${f.deliveries} tin)`,
    `   Theo lượt bấm mới nhất: ${f.likes} thích, ${f.dislikes} không thích (không tính tin thử)`,
  ];
}

function costBlocks(c: CostReport): Block[] {
  const tasks = c.tasks.map((t) => t.task);
  const out: Block[] = [
    `${mark(c.pass)} 4. Chi phí model < $${dec(COST_MAX_USD_PER_DAY, 2)}/ngày: tổng ${usd(c.total)} trong ${c.days.length} ngày`,
  ];
  if (c.days.length) {
    out.push(
      c.days.map((d) => ({
        ngày: d.day,
        // Việc không gọi trong ngày để trống, cho bảng dễ đọc.
        ...Object.fromEntries(tasks.map((t) => [t, d.byTask[t] ? usd(d.byTask[t]) : ""])),
        tổng: usd(d.usd),
        "dưới trần": mark(!d.over),
      })),
    );
  }
  const over = c.days.filter((d) => d.over).map((d) => d.day);
  if (over.length) out.push(`   Ngày vượt trần: ${over.join(", ")}`);
  return out;
}

function metricsBlocks(r: Report): Block[] {
  const m = r.metrics;
  const out: Block[] = ["5. Số liệu đầu tiên", "   Tài liệu mỗi ngày theo nguồn, và sự kiện mới:"];
  out.push(
    m.docsPerDay.map((d, i) => ({
      ngày: d.day,
      ...d.bySource,
      "tổng tài liệu": d.total,
      "sự kiện mới": m.eventsPerDay[i]?.n ?? 0,
    })),
  );
  const n = Math.max(1, m.docsPerDay.length);
  const avg = m.sources.map(
    (s) => `${s} ${dec(m.docsPerDay.reduce((a, d) => a + (d.bySource[s] ?? 0), 0) / n, 1)}`,
  );
  if (avg.length) out.push(`   Trung bình tài liệu/ngày: ${avg.join(", ")}`);
  out.push("   Sự kiện qua cổng chủ đề mỗi digest:");
  out.push(
    r.digests.days.map((d) => ({
      ngày: d.date,
      "ứng viên": d.candidates ?? "",
      "qua cổng": d.passedGate ?? "",
      "tỉ lệ lọc":
        d.candidates !== null && d.passedGate !== null
          ? pct(ratio(d.passedGate, d.candidates))
          : "",
      "đã gửi": d.items,
    })),
  );
  out.push(`   Tỉ lệ thích trong các tin đã bấm: ${pct(r.feedback.likeShare)}`);
  return out;
}

/** Báo cáo ở dạng in ra terminal: chữ thường (✓ / ✗), bảng cho console.table. */
export function formatReport(r: Report): Block[] {
  const w = r.window;
  const passed = [r.fetch.pass, r.digests.pass, r.feedback.pass, r.cost.pass].filter(
    Boolean,
  ).length;
  return [
    `Nghiệm thu: ${vnTime(w.start)} → ${vnTime(w.end)} giờ VN (${w.slots.length} khung digest); ngày lịch ${w.days[0] ?? "—"} → ${w.days.at(-1) ?? "—"}`,
    "",
    ...fetchBlocks(r.fetch),
    "",
    ...digestBlocks(r.digests),
    "",
    ...feedbackBlocks(r.feedback),
    "",
    ...costBlocks(r.cost),
    "",
    ...metricsBlocks(r),
    "",
    `${mark(r.pass)} Tổng: đạt ${passed}/4 tiêu chí${r.pass ? "" : " (chưa đạt nghiệm thu)"}`,
  ];
}
