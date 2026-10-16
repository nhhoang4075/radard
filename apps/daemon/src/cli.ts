#!/usr/bin/env bun
/**
 * CLI của radard. Lệnh duy nhất gọi model là `process` (embedding, rất rẻ); `run` chỉ gọi
 * API của nguồn.
 *
 * Mỗi lệnh là một hàm trong bảng `COMMANDS`, khoá theo "lệnh" hoặc "lệnh lệnh-con".
 */
import { pushFsToR2 } from "@radard/adapters/object-store-r2";
import {
  deliveries,
  digests,
  docText,
  docTopicScores,
  documents,
  eventDocuments,
  events,
  feedback,
  fetchRuns,
  llmCalls,
  profile,
  runMigrations,
  sourceState,
  sources,
  topics,
} from "@radard/db";
import { desc, eq, gte, sql } from "drizzle-orm";
import { env } from "./env.ts";
import { runBaselines } from "./jobs/baselines.ts";
import { buildPlan, type DigestPlan, digestSlot, runDigest } from "./jobs/digest.ts";
import { type FetchDeps, runFetch } from "./jobs/fetch.ts";
import { fetchPages } from "./jobs/pages.ts";
import { rebuildEvents, runProcess } from "./jobs/process.ts";
import { periodEndingAt, rankPeriod } from "./jobs/rank.ts";
import { listRepos, runRepoStats } from "./jobs/repo-stats.ts";
import { buildReport, formatReport, reportWindow } from "./jobs/report.ts";
import { refreshSince } from "./jobs/signals.ts";
import { type CloseRelation, checkTopicOverlap, type OverlapCheck } from "./jobs/topic-overlap.ts";
import {
  MAYBE_MIN,
  PRESELECT_MIN,
  type SuggestResult,
  suggestTopics,
} from "./jobs/topic-suggest.ts";
import {
  addCustomTopic,
  describeTopic,
  embedPendingTopics,
  listLibrary,
  listProfileTopics,
  pickTopics,
  seedLibrary,
  setTopicActive,
} from "./jobs/topics.ts";
import {
  createDecider,
  createDeps,
  createDigestDeps,
  createEmbedder,
  createLlm,
  createNotifier,
  createPagesDeps,
  createProcessDeps,
} from "./runtime.ts";
import { DEFAULT_PROFILE, DEFAULT_SOURCES } from "./sources/index.ts";

const USAGE = `
radard — CLI

  db migrate                 Dựng hoặc cập nhật schema
  sources                    Liệt kê nguồn, trạng thái và số tài liệu
  sources seed               Thêm nguồn mặc định còn thiếu (không ghi đè nguồn đã có)
  run <id|tên>               Chạy fetch một nguồn ngay, không qua hàng đợi
  runs [--limit=20]          Các lượt fetch gần nhất
  docs [--since=24h] [--limit=20]   Tài liệu mới nhất

  profile                    Xem bối cảnh của bạn (dùng trong prompt digest, không để lọc)
  profile set "<bối cảnh>"   Đặt bối cảnh: nghề, stack, đang làm gì
  profile seed               Đặt bối cảnh mặc định TẠM nếu chưa có
  process                    Chạy phần xử lý ngay: embed, chấm điểm theo chủ đề, gộp sự kiện
  events [--since=24h] [--limit=20]  Sự kiện hoạt động gần nhất, nhiều tài liệu trước
  events rebuild [--decide]  Xoá sự kiện, gộp lại theo ngưỡng mới; giữ embedding (không tốn tiền).
                             Mặc định KHÔNG hỏi model quyết định cho vùng xám 0,85–0,9 (cả lịch sử
                             là ~1.700 lời gọi); --decide để hỏi
  reprocess --pages          Xoá embedding và điểm chủ đề của tài liệu đã có trang được link tới
                             (job pages), để embed lại cùng nội dung trang; rồi chạy events rebuild
  reprocess --all            Xoá toàn bộ dữ liệu dẫn xuất (doc_text, events) để tính lại;
                             dữ liệu thu thập giữ nguyên
  costs [--since=24h]        Chi phí gọi model theo việc
  report [--since=7d]        Chấm các tiêu chí nghiệm thu 7 ngày (fetch, digest đúng giờ, phản hồi,
                             chi phí) cho các khung 07:00 tới khung gần nhất; chỉ đọc DB
  store check                Ghi, đọc lại rồi kiểm một key thử trên kho bản thô (đĩa hoặc R2)
  store push [--limit=N]     Chép bản thô từ DATA_DIR lên R2 (cần biến R2_*); key đã có thì bỏ qua

  topics                     Thư viện chủ đề (✓ = đã chọn) và chủ đề của bạn
  topics seed                Nạp/cập nhật thư viện chủ đề từ code
  topics pick <key,key…>     Chọn chủ đề từ thư viện, rồi embed (1 request)
  topics add "<tên>" "<mô tả>" [--exclude]
                             Tự thêm chủ đề: LLM viết câu mô tả tiếng Anh, rồi embed
  topics on|off <id>         Bật / tắt một chủ đề của bạn (không xoá)
  topics check "<tên>" "<English description>"
                             Soát chủ đề gần giống trước khi thêm: model quyết định cho biết quan hệ
                             với mọi chủ đề có sẵn; chủ đề gần kèm tỉ lệ trùng tin và tin ví dụ.
                             Không lưu gì
  topics suggest [--text="<mô tả>"] [--json]
                             Gợi ý chủ đề từ lời mô tả (mặc định: bối cảnh đã lưu): model quyết định
                             chấm thư viện thành ba mức, LLM đề xuất chủ đề mới (đã soát gần giống).
                             Không lưu gì

  signals refresh [--since=30d]  Lấy lại điểm, bình luận mới nhất (HN) cho tài liệu từ mốc đó
  baselines                  Tính lại mặt bằng (trung vị, mốc 0,1%) ngay và in ra
  notify test                Gửi một tin thử có nút 👍/👎 tới chat của bạn (ghi vào deliveries)
  feedback [--limit=20]      Các phản hồi gần nhất

  rank [--at=<ISO>] [--refresh]  Chọn tin cho 24 giờ kết thúc ở --at (mặc định: bây giờ);
                             --refresh lấy lại điểm HN cho sự kiện qua cổng trước khi chấm

  repos [--limit=20]         Repo GitHub đang theo dõi: sao, tăng 24 giờ, tăng tốc (đo từ repo_stats;
                             chưa đủ hai lần đo thì số GitHub báo hoặc sao / tuổi, xem cột "cách tính")
  repos snapshot             Chụp số sao ngay (job repo_stats, cần GITHUB_TOKEN); repo đã chụp trong
                             12 giờ qua thì bỏ qua

  pages [--since=24h]        Trang được link tới (bài HN → blog, GitHub…): đếm theo trạng thái
  pages fetch [--since=30d]  Tải trang cho tài liệu từ mốc đó tới khi hết (lấy bù)

  digest                     Các bản điểm tin gần nhất (trạng thái, số tin, có tóm tắt không)
  digest --dry-run [--at=<ISO>]  In đúng bản điểm tin sẽ gửi cho khung 07:00 gần nhất (hoặc
                             khung chứa --at); gọi LLM và model quyết định thật (cổng vùng xám),
                             không gửi, không lưu plan
  digest --now               Gửi ngay bản của khung 07:00 gần nhất (đã gửi thì thôi; gửi dở thì
                             gửi tiếp phần thiếu)
`;

function flag(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

/** `24h` → 24, `7d` → 168. */
function parseHours(v: string): number {
  const m = /^(\d+)([hd])$/.exec(v);
  if (!m) throw new Error(`--since phải dạng 24h hoặc 7d, nhận "${v}"`);
  return Number(m[1]) * (m[2] === "d" ? 24 : 1);
}

function parseSince(v: string): Date {
  return new Date(Date.now() - parseHours(v) * 3600_000);
}

const since = () => parseSince(flag("since", "24h"));
const limit = () => Number(flag("limit", "20"));

/** In một plan ở dạng gần với tin trên điện thoại. */
function printPlan(plan: DigestPlan): void {
  const r = plan.ranking;
  console.log(
    `${plan.period.start} → ${plan.period.end}: ${r.candidates} ứng viên, ${r.passedGate} qua cổng, bị loại ${JSON.stringify(r.rejected)}`,
  );
  printGate(plan);
  console.log(
    `tóm tắt: ${plan.summarized ? "có" : "không"}${plan.llm?.error ? ` (lỗi: ${plan.llm.error})` : ""}\n`,
  );
  for (const [i, m] of [plan.header, ...plan.items.map((it) => it.message)].entries()) {
    const it = plan.items[i - 1];
    console.log(
      `── ${m.title}${it ? `   [S ${it.score.S}, R ${it.score.R}, P ${it.score.P}]` : ""}`,
    );
    for (const line of m.lines) console.log(`   ${line}`);
    for (const l of m.links ?? []) console.log(`   ${l.role}: ${l.label}  ${l.url}`);
    if (m.moreRelated) console.log(`   +${m.moreRelated} bài`);
    console.log();
  }
}

/** Cổng bằng model quyết định: bao nhiêu sự kiện vùng xám, hỏi được bao nhiêu, qua/loại. */
function printGate(plan: DigestPlan): void {
  const d = plan.ranking.decision;
  if (!d) return;
  const c = d.counts;
  console.log(
    `cổng vùng xám (model ${d.model ?? "không có"}): ${c.inBand} sự kiện, hỏi ${c.asked}, qua ${c.passed}, loại ${c.rejected}, dùng luật cũ ${c.fallback}; hỏi ${d.ms} ms, cả bước xếp hạng ${plan.ranking.ms ?? "?"} ms`,
  );
  for (const e of d.events) {
    const p = e.probability === null ? "—" : e.probability.toFixed(2);
    const verdict = `${e.pass ? "qua" : "loại"}${e.fallback ? " (luật cũ)" : ""}`;
    console.log(
      `   R ${e.R.toFixed(2)} · p ${p} · ${verdict} · ${e.topic} · ${e.title.slice(0, 70)}`,
    );
  }
}

type Command = (deps: FetchDeps, arg: string | undefined) => Promise<void>;

const COMMANDS: Record<string, Command> = {
  "sources seed": async ({ db }) => {
    const added = await db
      .insert(sources)
      .values(DEFAULT_SOURCES)
      .onConflictDoNothing()
      .returning();
    console.log(
      added.length ? `đã thêm: ${added.map((s) => s.name).join(", ")}` : "không có nguồn mới",
    );
  },

  sources: async ({ db }) => {
    const rows = await db
      .select({
        id: sources.id,
        name: sources.name,
        kind: sources.kind,
        cadence: sources.cadence,
        enabled: sources.enabled,
        lastOkAt: sourceState.lastOkAt,
        failCount: sourceState.failCount,
        docs: sql<number>`(select count(*)::int from documents d where d.source_id = ${sources.id})`,
      })
      .from(sources)
      .leftJoin(sourceState, eq(sourceState.sourceId, sources.id))
      .orderBy(sources.id);
    console.table(rows);
  },

  run: async (deps, arg) => {
    if (!arg) throw new Error("thiếu nguồn: run <id|tên>");
    const [source] = await deps.db
      .select()
      .from(sources)
      .where(/^\d+$/.test(arg) ? eq(sources.id, Number(arg)) : eq(sources.name, arg));
    if (!source) throw new Error(`không tìm thấy nguồn "${arg}"`);
    console.log(await runFetch(source.id, deps));
  },

  runs: async ({ db }) => {
    const rows = await db
      .select({
        id: fetchRuns.id,
        source: sources.name,
        startedAt: fetchRuns.startedAt,
        status: fetchRuns.status,
        fetched: fetchRuns.nFetched,
        new: fetchRuns.nNew,
        error: fetchRuns.error,
        note: fetchRuns.note,
      })
      .from(fetchRuns)
      .innerJoin(sources, eq(sources.id, fetchRuns.sourceId))
      .orderBy(desc(fetchRuns.id))
      .limit(limit());
    console.table(rows);
  },

  docs: async ({ db }) => {
    const rows = await db
      .select({
        id: documents.id,
        source: sources.name,
        publishedAt: documents.publishedAt,
        title: documents.title,
        url: documents.urlCanonical,
      })
      .from(documents)
      .innerJoin(sources, eq(sources.id, documents.sourceId))
      .where(gte(documents.fetchedAt, since()))
      .orderBy(desc(documents.publishedAt))
      .limit(limit());
    console.table(rows);
  },

  "profile set": async ({ db }) => {
    const description = process.argv[4];
    if (!description) throw new Error('thiếu mô tả: profile set "…"');
    // Chỉ có một hồ sơ: sửa dòng đang có, chưa có thì tạo.
    const updated = await db
      .update(profile)
      .set({ description, updatedAt: new Date() })
      .returning({ id: profile.id });
    if (updated.length === 0) await db.insert(profile).values({ description });
    console.log("đã lưu bối cảnh");
  },

  "profile seed": async ({ db }) => {
    const added = await db
      .insert(profile)
      .values({ description: DEFAULT_PROFILE })
      .onConflictDoNothing()
      .returning();
    console.log(added.length ? "đã đặt mô tả mặc định (TẠM)" : "đã có profile, giữ nguyên");
  },

  profile: async ({ db }) => {
    const [p] = await db.select().from(profile);
    console.log(p ?? "chưa có profile");
  },

  "topics seed": async ({ db }) => {
    console.log(await seedLibrary(db));
  },

  topics: async ({ db }) => {
    let group = "";
    for (const t of await listLibrary(db)) {
      if (t.groupVi !== group) {
        group = t.groupVi;
        console.log(`\n${group}`);
      }
      console.log(`  ${t.chosen ? "✓" : " "} ${t.key.padEnd(14)} ${t.labelVi}`);
    }
    const mine = await listProfileTopics(db);
    console.log("\nChủ đề của bạn");
    if (mine.length === 0) console.log("  (chưa có: topics pick <key,…> hoặc topics add)");
    for (const t of mine) {
      const flags = [t.origin, t.kind, t.active ? "bật" : "tắt", t.embedded ? "" : "chưa embed"];
      console.log(
        `  ${String(t.id).padStart(3)}  ${t.label}  (${flags.filter(Boolean).join(", ")})`,
      );
      console.log(`       ${t.descriptionEn}`);
    }
  },

  "topics pick": async ({ db }) => {
    const keys = (process.argv[4] ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    if (keys.length === 0) throw new Error("thiếu key: topics pick agents,llm_apps");
    console.log(`đã chọn ${await pickTopics(db, keys)} chủ đề`);
    await embedTopicsNow(db);
  },

  "topics add": async ({ db }) => {
    const [label, text] = [process.argv[4], process.argv[5]];
    if (!label || !text) throw new Error('cần tên và mô tả: topics add "<tên>" "<mô tả>"');
    const llm = createLlm(db);
    if (!llm) throw new Error("chưa có AI_GATEWAY_API_KEY: không viết được câu mô tả");
    const descriptionEn = await describeTopic(llm, label, text);
    const kind = process.argv.includes("--exclude") ? "exclude" : "include";
    const id = await addCustomTopic(db, { label, descriptionUser: text, descriptionEn, kind });
    console.log(`đã thêm chủ đề ${id}: ${label}\n  câu dùng để embed: ${descriptionEn}`);
    await embedTopicsNow(db);
  },

  "topics check": async ({ db }) => {
    const [label, descriptionEn] = [process.argv[4], process.argv[5]];
    if (!label || !descriptionEn)
      throw new Error('cần tên và câu mô tả tiếng Anh: topics check "<tên>" "<description>"');
    const embedder = createEmbedder(db);
    if (!embedder) throw new Error("chưa có embedder: không đo được tỉ lệ trùng tin");
    const started = Date.now();
    const res = await checkTopicOverlap(
      { db, embedder, decider: createDecider(db) },
      { label, descriptionEn },
    );
    printOverlap(label, res, Date.now() - started);
  },

  "topics suggest": async ({ db }) => {
    let text = flag("text", "");
    if (!text) {
      const [p] = await db.select({ description: profile.description }).from(profile);
      if (!p) throw new Error('chưa có bối cảnh: profile set "…" hoặc --text="…"');
      text = p.description;
    }
    const started = Date.now();
    const res = await suggestTopics(
      { db, decider: createDecider(db), llm: createLlm(db), embedder: createEmbedder(db) },
      text,
    );
    if (process.argv.includes("--json")) console.log(JSON.stringify(res, null, 2));
    else printSuggest(res, Date.now() - started);
  },

  "topics on": async ({ db }) => {
    if (!(await setTopicActive(db, Number(process.argv[4]), true)))
      throw new Error("không có id đó");
    console.log("đã bật");
    await embedTopicsNow(db);
  },

  "topics off": async ({ db }) => {
    if (!(await setTopicActive(db, Number(process.argv[4]), false)))
      throw new Error("không có id đó");
    console.log("đã tắt");
  },

  "signals refresh": async ({ db, http }) => {
    console.log(await refreshSince(db, http, parseSince(flag("since", "30d"))));
  },

  baselines: async ({ db }) => {
    const rows = await runBaselines(db);
    const names = new Map(
      (await db.select({ id: sources.id, name: sources.name }).from(sources)).map((s) => [
        s.id,
        s.name,
      ]),
    );
    const topicNames = new Map(
      (await db.select({ id: topics.id, label: topics.labelVi }).from(topics)).map((t) => [
        t.id,
        t.label,
      ]),
    );
    console.table(
      rows.map((r) => ({
        metric: r.metric,
        source: r.sourceId === null ? "(chung)" : names.get(r.sourceId),
        topic: r.topicId === null ? "" : topicNames.get(r.topicId),
        median: Number(r.median.toFixed(3)),
        p999: Number(r.p999.toFixed(3)),
        n: r.n,
      })),
    );
  },

  "notify test": async ({ db }) => {
    const n = createNotifier();
    if (!n) throw new Error("chưa đặt TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID trong .env");
    const msg = {
      kind: "system" as const,
      title: "radard: tin thử <bước 4> & nút bấm",
      lines: [
        "Bấm 👍 hoặc 👎 bên dưới. Bot (vai trò bot trong bun run dev) sẽ ghi vào bảng feedback.",
        "Tiêu đề có < và & để kiểm escape HTML. Link hiện tên miền, bấm vào mở địa chỉ đầy đủ.",
      ],
      links: [
        { url: "https://grammy.dev/guide/", label: "grammy.dev", role: "main" as const },
        {
          url: "https://core.telegram.org/bots/api",
          label: "core.telegram.org",
          role: "related" as const,
        },
        {
          url: "https://github.com/grammyjs/grammY",
          label: "github.com",
          role: "related" as const,
        },
        {
          url: "https://news.ycombinator.com/item?id=1",
          label: "HN · ví dụ",
          role: "discussion" as const,
        },
      ],
      moreRelated: 2,
      actions: [
        { id: "like" as const, label: "👍" },
        { id: "dislike" as const, label: "👎" },
      ],
    };
    const { messageId } = await n.notifier.send(n.recipient, msg);
    // Không có digest: delivery `test` đứng riêng, để lượt bấm vẫn nối được về một tin mà không lẫn
    // vào phản hồi thật (phân tích chỉ lấy `kind = 'event'`).
    await db.insert(deliveries).values({
      channel: n.notifier.channel,
      recipient: n.recipient,
      messageId,
      kind: "test",
      title: msg.title,
      body: msg.lines.join("\n"),
    });
    console.log(`đã gửi tin thử, message_id ${messageId}`);
  },

  feedback: async ({ db }) => {
    const rows = await db
      .select({
        id: feedback.id,
        at: feedback.createdAt,
        kind: feedback.kind,
        delivery: feedback.deliveryId,
        title: sql<string>`left(${deliveries.title}, 60)`,
      })
      .from(feedback)
      .leftJoin(deliveries, eq(deliveries.id, feedback.deliveryId))
      .orderBy(desc(feedback.id))
      .limit(limit());
    console.table(rows);
  },

  rank: async ({ db, http }) => {
    const at = flag("at", "");
    const period = periodEndingAt(at ? new Date(at) : new Date());
    const r = await rankPeriod(db, period, process.argv.includes("--refresh") ? { http } : {});
    const f = (x: number) => Number(x.toFixed(2));
    console.log(
      `${period.start.toISOString()} → ${period.end.toISOString()}: ${r.candidates} sự kiện ứng viên, ${r.passedGate} qua cổng R ≥ ${r.config.gateR}`,
    );
    console.table(
      r.picked.map((p) => ({
        title: p.event.title.slice(0, 60),
        S: f(p.S),
        phạt: f(p.penalty),
        R: f(p.c.R),
        P: f(p.c.P),
        C: f(p.c.C),
        A: f(p.c.A),
        F: f(p.c.F),
        N: f(p.c.N),
        "chủ đề": p.c.topicId === null ? "" : r.topicLabels.get(p.c.topicId),
        nguồn: r.sourceNames.get(p.c.sourceId),
        "giữ chỗ": p.reserved ? "✓" : "",
      })),
    );
    const reasons = new Map<string, number>();
    for (const x of r.rejected) reasons.set(x.reason, (reasons.get(x.reason) ?? 0) + 1);
    console.log("bị loại:", Object.fromEntries(reasons));
    const near = r.rejected
      .filter((x) => x.reason !== "gate")
      .sort((a, b) => b.S - a.S)
      .slice(0, 5)
      .map((x) => ({
        title: x.event.title.slice(0, 60),
        S: f(x.S),
        R: f(x.c.R),
        "lý do": x.reason,
      }));
    if (near.length) console.table(near);
  },

  repos: async ({ db }) => {
    const basis = { measured: "đo", reported: "GitHub báo", age: "sao / tuổi" } as const;
    const rows = (await listRepos(db)).slice(0, limit());
    if (rows.length === 0) return console.log("chưa theo dõi repo nào");
    console.table(
      rows.map((r) => ({
        repo: r.repo,
        sao: r.stars ?? "",
        "tăng 24h": r.gain24h ?? "",
        "tăng tốc": r.accel ?? "",
        "cách tính": r.basis ? basis[r.basis] : "",
        "đo lúc": r.observedAt?.toISOString().slice(0, 16) ?? "",
      })),
    );
  },

  "repos snapshot": async ({ db, http }) => {
    console.log(await runRepoStats({ db, http }));
  },

  pages: async ({ db }) => {
    const rows = await db.execute(sql`
      select status, count(*)::int n, count(distinct split_part(url, '/', 3))::int hosts
      from linked_pages where fetched_at >= ${since()} group by 1 order by 2 desc`);
    console.table([...rows]);
  },

  "pages fetch": async (base) => {
    const deps = createPagesDeps(base);
    const from = parseSince(flag("since", "30d"));
    const total = { considered: 0, ok: 0, blocked: 0, skipped: 0, failed: 0 };
    for (;;) {
      const out = await fetchPages(deps, { since: from, limit: 500, concurrency: 16 });
      if (out.considered === 0) break;
      for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += out[k];
      console.log(new Date().toISOString(), total);
    }
    console.log("xong", total);
  },

  digest: async (base) => {
    const { db, http } = base;
    if (process.argv.includes("--dry-run")) {
      const at = flag("at", "");
      const slot = digestSlot(at ? new Date(at) : new Date());
      const llm = createLlm(db);
      if (!llm) console.log("(chưa có AI_GATEWAY_API_KEY: bản không tóm tắt, cổng dùng luật R)");
      printPlan(await buildPlan({ db, http, llm, decider: createDecider(db) }, slot));
      return;
    }
    if (process.argv.includes("--now")) {
      const deps = createDigestDeps(base);
      if (!deps) throw new Error("chưa đặt TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID trong .env");
      console.log(await runDigest(deps));
      return;
    }
    const rows = await db.select().from(digests).orderBy(desc(digests.periodEnd)).limit(limit());
    console.table(
      rows.map((r) => {
        const plan = (r.meta as { plan?: DigestPlan }).plan;
        return {
          id: r.id,
          "khung (UTC)": r.periodEnd.toISOString().slice(0, 16),
          status: r.status,
          tin: plan?.items.length ?? "",
          "tóm tắt": plan ? (plan.summarized ? "✓" : "không") : "",
          sentAt: r.sentAt?.toISOString().slice(0, 16) ?? "",
          error: r.error?.slice(0, 60) ?? "",
        };
      }),
    );
  },

  process: async (deps) => {
    const pdeps = createProcessDeps(deps);
    if (!pdeps) {
      throw new Error("chưa cấu hình embedder: đặt AI_GATEWAY_API_KEY, hoặc EMBEDDER=fake để thử");
    }
    console.log(await runProcess(pdeps));
  },

  events: async ({ db }) => {
    const rows = await db
      .select({
        id: events.id,
        nDocs: events.nDocs,
        lastSeen: events.lastSeenAt,
        title: sql<string>`left(${events.title}, 70)`,
        // Ghi rõ `events.id`: trong truy vấn con, "id" trần sẽ bị hiểu là id của bảng khác.
        sources: sql<string>`(select string_agg(distinct s.name, ', ') from event_documents ed
          join documents d on d.id = ed.document_id join sources s on s.id = d.source_id
          where ed.event_id = events.id)`,
      })
      .from(events)
      .where(gte(events.lastSeenAt, since()))
      .orderBy(desc(events.nDocs), desc(events.lastSeenAt))
      .limit(limit());
    console.table(rows);
  },

  "events rebuild": async (deps) => {
    // Giữ doc_text (embedding) và điểm chủ đề, chỉ gộp lại sự kiện: không tốn tiền gọi model.
    // Dừng daemon trước: một lượt process chạy song song sẽ gộp trùng tài liệu.
    const pdeps = createProcessDeps(deps);
    if (!pdeps) throw new Error("chưa cấu hình embedder");
    const decide = process.argv.includes("--decide");
    if (decide && !pdeps.decider) throw new Error("--decide cần AI_GATEWAY_API_KEY");
    const started = Date.now();
    const out = await rebuildEvents(pdeps, { decide });
    const seconds = (Date.now() - started) / 1000;
    const clustered = out.joinedByUrl + out.joinedByVector + out.joinedByDecision + out.created;
    console.log({
      ...out,
      seconds,
      msPerDoc: Math.round((seconds * 1000) / Math.max(1, clustered)),
    });
  },

  reprocess: async ({ db }) => {
    if (process.argv.includes("--pages")) {
      // Tài liệu embed trước khi có trang (chỉ tiêu đề) mà nay trang đã tải được.
      const rows = await db.execute<{ n: number }>(sql`
        with target as (
          select d.id from documents d
          join linked_pages lp on lp.url_canonical = d.url_canonical and lp.status = 'ok'
        ), s as (
          delete from doc_topic_scores where document_id in (select id from target)
        ), t as (
          delete from doc_text where document_id in (select id from target) returning 1
        )
        select count(*)::int n from t`);
      console.log(`đã xoá embedding của ${[...rows][0]?.n ?? 0} tài liệu; chạy \`events rebuild\``);
      return;
    }
    // Xoá hàng chục nghìn dòng (tính lại tốn tiền embed): bắt gõ rõ --all.
    if (!process.argv.includes("--all"))
      throw new Error("lệnh này xoá mọi dữ liệu dẫn xuất: gõ reprocess --all");
    await db.execute(sql`truncate ${eventDocuments}, ${events}, ${docTopicScores}, ${docText}`);
    await db.update(topics).set({ embedding: null, embeddingModel: null });
    console.log("đã xoá dữ liệu dẫn xuất; chạy `process` để tính lại");
  },

  "store check": async ({ store }) => {
    // Key nằm ngoài `raw/` để không lẫn với bản thô thật; ghi lại nhiều lần cũng vô hại.
    const key = "check/radard.txt";
    const body = new TextEncoder().encode(`radard ${new Date().toISOString()}`);
    await store.put(key, body, "text/plain");
    const back = await store.get(key);
    const same = back !== null && Buffer.from(back).equals(Buffer.from(body));
    if (!same || !(await store.exists(key))) throw new Error("kho bản thô: đọc lại không khớp");
    console.log(`kho bản thô ${env.objectStore}: ghi, đọc lại và exists đều đúng`);
  },

  "store push": async () => {
    const { endpoint, bucket, accessKeyId, secretAccessKey } = env.r2;
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey)
      throw new Error(
        "store push cần R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY",
      );
    const limit = flag("limit", "");
    const out = await pushFsToR2(
      env.dataDir,
      { endpoint, bucket, accessKeyId, secretAccessKey },
      { limit: limit ? Number(limit) : undefined, onProgress: (n) => console.log(`… ${n}`) },
    );
    console.log(`${out.files} file: đẩy ${out.uploaded}, đã có ${out.skipped}`);
  },

  report: async ({ db }) => {
    const window = reportWindow(new Date(), parseHours(flag("since", "7d")));
    for (const block of formatReport(await buildReport(db, window))) {
      if (typeof block === "string") console.log(block);
      else console.table(block);
    }
  },

  costs: async ({ db }) => {
    const rows = await db
      .select({
        task: llmCalls.task,
        model: llmCalls.model,
        costSource: llmCalls.costSource,
        calls: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) filter (where not ${llmCalls.ok})::int`,
        inputTokens: sql<number>`sum(${llmCalls.inputTokens})::int`,
        usd: sql<string>`round(sum(${llmCalls.costUsd})::numeric, 6)::text`,
      })
      .from(llmCalls)
      .where(gte(llmCalls.at, since()))
      .groupBy(llmCalls.task, llmCalls.model, llmCalls.costSource);
    console.table(rows);
  },
};

/** Embed ngay chủ đề vừa chọn hoặc thêm; chưa có embedder thì để lượt process sau. */
const RELATION_VI: Record<CloseRelation, string> = {
  same: "trùng",
  narrower: "hẹp hơn",
  broader: "rộng hơn",
};

function printOverlap(label: string, res: OverlapCheck, ms: number): void {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (!res.ran) {
    console.log(
      `"${label}": chưa soát được (không có model quyết định hoặc lời gọi lỗi), ${ms} ms`,
    );
    return;
  }
  console.log(
    `"${label}": hỏi ${res.asked} chủ đề, model ${res.model}, so ${res.docs} tin, ${ms} ms`,
  );
  if (res.candidates.length === 0) console.log("  mọi chủ đề có sẵn đều khác");
  for (const c of res.candidates) {
    const state = c.enabled ? "đang bật" : "chưa bật";
    console.log(
      `\n  ${c.label} [${c.origin} ${c.topicId}, ${state}]: ${RELATION_VI[c.relation]} (${c.relation}, ${c.probability.toFixed(2)}), trùng ${pct(c.ratio)} tin`,
    );
    for (const t of c.shared) console.log(`    cả hai: ${t.slice(0, 110)}`);
    for (const t of c.onlyNew) console.log(`    chỉ mới: ${t.slice(0, 110)}`);
  }
}

function printSuggest(res: SuggestResult, ms: number): void {
  const p = (x: number) => x.toFixed(2);
  const tierLines = (title: string, list: SuggestResult["preselect"]) => {
    console.log(`\n${title}`);
    if (list.length === 0) console.log("  (không có)");
    for (const s of list) console.log(`  ${p(s.probability)}  ${s.key.padEnd(14)} ${s.label}`);
  };
  if (res.ran.library) {
    tierLines(`Tích sẵn (≥ ${PRESELECT_MIN})`, res.preselect);
    tierLines(`Có thể bạn quan tâm (≥ ${MAYBE_MIN})`, res.maybe);
    tierLines("Không gợi ý", res.notSuggested);
  } else {
    console.log(
      `chưa chấm thư viện: ${res.errors.library ?? "không có model quyết định (AI_GATEWAY_API_KEY)"}`,
    );
  }
  console.log("\nChủ đề mới (ngoài thư viện)");
  if (!res.ran.newTopics) {
    console.log(`  chưa đề xuất: ${res.errors.newTopics ?? "không có LLM (AI_GATEWAY_API_KEY)"}`);
  } else if (res.newTopics.length === 0) {
    console.log("  (không có: thư viện đã đủ)");
  }
  for (const t of res.newTopics) {
    console.log(`  ${t.labelVi}: ${t.why}`);
    console.log(`    ${t.descriptionEn}`);
    if (!t.overlapChecked) console.log("    chưa soát chủ đề gần giống");
    for (const c of t.related) {
      console.log(`    ${RELATION_VI[c.relation]} "${c.label}" (${p(c.probability)})`);
    }
  }
  for (const d of res.dropped) {
    console.log(`  bỏ "${d.labelVi}": trùng "${d.sameAs.label}" (${p(d.sameAs.probability)})`);
  }
  console.log(`\n${ms} ms`);
}

async function embedTopicsNow(db: FetchDeps["db"]): Promise<void> {
  const embedder = createEmbedder(db);
  if (!embedder) return console.log("chưa có embedder: chủ đề sẽ được embed ở lượt process sau");
  const n = await embedPendingTopics(db, embedder);
  if (n > 0) console.log(`đã embed ${n} chủ đề`);
}

async function main(): Promise<void> {
  const [cmd, sub] = process.argv.slice(2);
  if (cmd === "db" && sub === "migrate") return runMigrations(env.databaseUrl);

  // "lệnh lệnh-con" trước (vd `sources seed`), rồi tới "lệnh" kèm tham số (vd `run 1`).
  const withSub = COMMANDS[`${cmd} ${sub}`];
  const command = withSub ?? (cmd ? COMMANDS[cmd] : undefined);
  if (!command) {
    console.log(USAGE);
    return;
  }
  const deps = createDeps();
  try {
    await command(deps, withSub ? undefined : sub);
  } finally {
    await deps.db.$bun.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
