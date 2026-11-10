/**
 * Job điểm tin (digest) mỗi sáng: chọn tin, nhờ LLM viết lời mở đầu và tóm tắt, gửi qua Notifier.
 *
 * Chạy lại an toàn (tuan-3-thuc-thi.html, bước 6):
 *   1. Mỗi khung giờ (07:00 giờ VN) một dòng `digests`. Đã `sent` thì dừng.
 *   2. Plan (đúng các tin sẽ gửi) lưu vào `digests.meta.plan` TRƯỚC khi gửi tin đầu tiên. Chạy lại
 *      thì đọc plan, không chọn lại: điểm HN đổi thì chọn lại có thể ra danh sách khác.
 *   3. Gửi tin nào ghi `deliveries` tin đó ngay; chạy lại thì bỏ qua vị trí đã có delivery.
 * LLM hỏng thì vẫn gửi bản không tóm tắt (tiêu đề gốc và link). Không có tin nào vượt sàn thì gửi
 * một tin ngắn "hôm nay yên ắng" (D5), để biết radard vẫn chạy.
 */
import {
  createLogger,
  type DecisionProvider,
  type HttpClient,
  type Link,
  type LlmProvider,
  type Message,
  type Notifier,
} from "@radard/core";
import {
  type Database,
  deliveries,
  digests,
  docSignals,
  docText,
  documents,
  eventDocuments,
  profile,
} from "@radard/db";
import { and, eq, inArray } from "drizzle-orm";
import { adapterFor } from "../sources/index.ts";
import { TOPIC_TIE_BREAKS } from "../topics/library.ts";
import { buildTrackingUrl } from "../web/token.ts";
import { recordCandidatePoolSafely } from "./candidate-pool.ts";
import type { GateCounts, GateDecision } from "./gate-decision.ts";
import { type RankResult, rankPeriod } from "./rank.ts";

const log = createLogger("digest");

/** Giờ gửi theo giờ Việt Nam. VN không đổi giờ theo mùa nên lệch UTC cố định +7. */
export const DIGEST_HOUR_VN = 7;
const VN_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

/** Số bài "Bài khác" hiện thành link; phần còn lại thành "+N bài". */
const MAX_RELATED = 3;
/** Số tài liệu mỗi tin đưa cho LLM, và độ dài trích đoạn mỗi tài liệu. */
const LLM_DOCS_PER_ITEM = 4;
const LLM_EXCERPT_CHARS = 500;
/**
 * Trần token ra. Token suy nghĩ ẩn của model tính vào trần này và dao động mạnh: 13/10/2026, cùng
 * một prompt 6 tin (1.613 token vào), ba lần gọi ra 2.127, 2.376 và chạm trần 4.000 (2.788 token
 * suy nghĩ, JSON bị cắt). Trần chỉ là giới hạn: tiền tính theo token dùng thật.
 */
const LLM_MAX_OUTPUT_TOKENS = 8000;

const ACTIONS: Message["actions"] = [
  { id: "like", label: "👍" },
  { id: "dislike", label: "👎" },
];

/** Khung giờ gửi gần nhất không muộn hơn `now`: mốc kết thúc của khoảng 24 giờ. */
export function digestSlot(now: Date, hourVn = DIGEST_HOUR_VN): Date {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  let slot =
    Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate(), hourVn) - VN_OFFSET_MS;
  if (slot > now.getTime()) slot -= DAY_MS;
  return new Date(slot);
}

/** "14/10" theo giờ Việt Nam. */
export function vnDate(d: Date): string {
  const vn = new Date(d.getTime() + VN_OFFSET_MS);
  const dd = String(vn.getUTCDate()).padStart(2, "0");
  const mm = String(vn.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}`;
}

// ---------------------------------------------------------------------------------------------
// Plan: dạng lưu trong digests.meta.plan

export interface PlanItem {
  /** 1…n; tin mở đầu là 0. */
  position: number;
  eventId: number;
  documentIds: number[];
  message: Message;
  /** Vì sao chọn: điểm, các thành phần, chủ đề khớp. */
  score: {
    S: number;
    penalty: number;
    R: number;
    P: number;
    C: number;
    A: number;
    F: number;
    N: number;
  };
  /** Nhãn hiện trong tin: chủ đề LLM chọn khi đọc tin, hoặc chủ đề embedding khớp nhất. */
  topic: string | null;
  /** Chủ đề embedding khớp nhất (cho R), giữ lại để so với lựa chọn của LLM. */
  topicByEmbedding: string | null;
  topicSource: "llm" | "embedding";
}

export interface DigestPlan {
  version: 1;
  builtAt: string;
  period: { start: string; end: string };
  header: Message;
  items: PlanItem[];
  /** `false`: bản không tóm tắt (LLM lỗi hoặc chưa cấu hình). */
  summarized: boolean;
  llm: { model: string; error?: string } | null;
  ranking: {
    candidates: number;
    passedGate: number;
    rejected: Record<string, number>;
    config: Record<string, unknown>;
    baselines: RankResult["baselines"];
    /** Thời gian cả bước xếp hạng, mili giây (vắng ở plan trước 16/10/2026). */
    ms?: number;
    /**
     * Cổng bằng model quyết định cho các sự kiện có R trong vùng xám: số đếm, từng sự kiện đã xét
     * (R, chủ đề, xác suất, qua hay không, có dùng luật cũ không) và thời gian hỏi. Vắng ở plan
     * trước 16/10/2026.
     */
    decision?: {
      model: string | null;
      counts: GateCounts;
      ms: number;
      events: GateDecision[];
    };
  };
}

// ---------------------------------------------------------------------------------------------
// Tài liệu của các tin đã chọn, đủ để dựng link và đưa cho LLM

export interface ItemDoc {
  id: number;
  sourceId: number;
  sourceName: string;
  kind: string;
  externalId: string;
  title: string | null;
  url: string;
  urlCanonical: string;
  excerpt: string;
  signals: Record<string, number>;
  /** Điểm chủ đề của tài liệu với chủ đề cho R cao nhất của tin. */
  topicScore: number;
  engagement: number | null;
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Link của một tin. Bài viết khác nhau = URL khác nhau (5 lượt đăng lại một URL là một bài).
 *   main: bài khớp chủ đề nhất · related: các bài khác, tối đa MAX_RELATED, còn lại "+N bài" ·
 *   discussion: trang thảo luận nhiều người quan tâm nhất, nếu nguồn có (adapter khai báo).
 */
export function buildLinks(docs: readonly ItemDoc[]): { links: Link[]; moreRelated: number } {
  const groups = new Map<string, ItemDoc[]>();
  for (const d of docs) groups.set(d.urlCanonical, [...(groups.get(d.urlCanonical) ?? []), d]);
  const best = (g: ItemDoc[]) => Math.max(...g.map((d) => d.topicScore));
  const ordered = [...groups.values()].sort((a, b) => best(b) - best(a));
  const links: Link[] = [];
  const [main, ...rest] = ordered;
  if (main?.[0]) links.push({ url: main[0].url, label: host(main[0].url), role: "main" });
  for (const g of rest.slice(0, MAX_RELATED)) {
    if (g[0]) links.push({ url: g[0].url, label: host(g[0].url), role: "related" });
  }

  let discussion: { url: string; label: string; weight: number } | null = null;
  for (const d of docs) {
    const url = discussionUrlOf(d);
    if (!url) continue;
    const weight = d.engagement ?? -1;
    if (!discussion || weight > discussion.weight)
      discussion = { url, label: d.sourceName, weight };
  }
  if (discussion) links.push({ url: discussion.url, label: discussion.label, role: "discussion" });
  return { links, moreRelated: Math.max(0, rest.length - MAX_RELATED) };
}

function discussionUrlOf(d: ItemDoc): string | null {
  try {
    return adapterFor(d.kind).discussionUrl?.(d.externalId, d.url) ?? null;
  } catch {
    return null;
  }
}

/** "3 bài từ HN, arXiv" hoặc "HN" khi chỉ một bài. */
function sourcesLine(docs: readonly ItemDoc[]): string {
  const names = [...new Set(docs.map((d) => d.sourceName))].join(", ");
  const n = new Set(docs.map((d) => d.urlCanonical)).size;
  return n > 1 ? `${n} bài từ ${names}` : names;
}

// ---------------------------------------------------------------------------------------------
// LLM: một lời gọi cho cả bản điểm tin

const LANG_NAMES: Record<string, string> = { vi: "Vietnamese", en: "English" };

export interface Summaries {
  intro: string;
  /** `topic`: một nhãn trong danh sách chủ đề của bạn, đúng nguyên văn; vắng nếu model chọn sai. */
  items: Map<number, { title: string; summary: string; topic?: string }>;
}

/** Một chủ đề đang bật, như LLM thấy khi gắn nhãn: tên và phạm vi (chủ đề tự thêm chỉ có tên). */
export interface TopicChoice {
  label: string;
  note?: string;
}

/**
 * `topics`: các chủ đề bạn đang theo dõi, kèm phạm vi. Model chọn nhãn cho từng tin vì nó đọc được
 * cả trích đoạn và hiểu tiêu đề ngắn, còn embedding của tiêu đề 10 chữ hay đoán sai (Janas,
 * "streaming experts from SSD", bị gán RAG; 13/10/2026). Không đưa nhãn embedding vào prompt
 * để model không bám theo nhãn đó. Phạm vi (dòng "Not: …") và hai quy tắc phân xử lấy từ
 * docs/bo-chu-de-moi.html: khoảng 30% tin nằm giữa hai chủ đề, cần luật rõ để nhãn nhất quán.
 */
export function digestSystem(
  context: string,
  lang: string,
  topics: readonly TopicChoice[],
): string {
  const language = LANG_NAMES[lang] ?? lang;
  return [
    "You write a short morning news brief for one reader.",
    `About the reader (use it to explain why each story matters to them): ${context}`,
    `Write in ${language}. Keep product, company, model and library names as they are.`,
    "Use only the facts in the input. Never invent numbers, names, dates or claims.",
    // 13/10/2026: thiếu dòng này, model viết "phần lớn tin chỉ có tiêu đề…" vào lời mở đầu.
    "Never comment on the input itself (how much text you were given, missing details); just leave out what you do not know.",
    "Return ONLY a JSON object, no markdown fences, with this shape:",
    '{"intro": string, "items": [{"n": number, "title": string, "summary": string, "topic": string}]}',
    "- intro: 1-2 sentences on what stands out today as a whole.",
    "- items: exactly one entry per input story, with the same n.",
    "- title: at most 12 words.",
    "- summary: 2-3 sentences: what happened, then why it matters to this reader.",
    "- topic: the reader's topic this story is mostly about. Copy only the quoted label, exactly as written, from this list (the text after a label says what the topic covers):",
    ...topics.map((t) => `  - ${JSON.stringify(t.label)}${t.note ? `: ${t.note}` : ""}`),
    "  When a story fits two topics:",
    ...TOPIC_TIE_BREAKS.map((r) => `  - ${r}`),
    '  - Follow the "Not:" notes. If the topic a note points to is not in the list, choose the best of the listed topics.',
  ].join("\n");
}

export function digestPrompt(stories: readonly { n: number; docs: readonly ItemDoc[] }[]): string {
  return stories
    .map((s) => {
      const docs = [...s.docs]
        .sort((a, b) => b.topicScore - a.topicScore)
        .slice(0, LLM_DOCS_PER_ITEM)
        .map((d) => {
          const signals = Object.entries(d.signals)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ");
          const head = `- [${d.sourceName}${signals ? `, ${signals}` : ""}] ${d.title ?? "(no title)"} (${host(d.url)})`;
          return d.excerpt ? `${head}\n  Excerpt: ${d.excerpt}` : head;
        });
      return [`Story ${s.n}`, "Documents:", ...docs].join("\n");
    })
    .join("\n\n");
}

/** Đọc JSON model trả về; sai cấu trúc thì báo lỗi (để thử lại hoặc chuyển bản không tóm tắt). */
export function parseSummaries(
  reply: string,
  count: number,
  topics: readonly string[] = [],
): Summaries {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("không thấy JSON trong câu trả lời");
  const data = JSON.parse(reply.slice(start, end + 1)) as {
    intro?: unknown;
    items?: unknown;
  };
  if (typeof data.intro !== "string" || data.intro.trim().length === 0) {
    throw new Error("thiếu intro");
  }
  if (!Array.isArray(data.items)) throw new Error("thiếu items");
  const items = new Map<number, { title: string; summary: string; topic?: string }>();
  const known = new Set(topics);
  for (const it of data.items as {
    n?: unknown;
    title?: unknown;
    summary?: unknown;
    topic?: unknown;
  }[]) {
    if (
      typeof it.n !== "number" ||
      typeof it.title !== "string" ||
      typeof it.summary !== "string"
    ) {
      continue;
    }
    const title = it.title.trim();
    const summary = it.summary.trim();
    if (title.length === 0 || title.length > 200 || summary.length < 20) continue;
    // Nhãn sai hoặc thiếu không làm hỏng cả bản: dùng nhãn embedding cho tin đó.
    const topic =
      typeof it.topic === "string" && known.has(it.topic.trim()) ? it.topic.trim() : undefined;
    items.set(it.n, topic ? { title, summary, topic } : { title, summary });
  }
  for (let n = 1; n <= count; n++) {
    if (!items.has(n)) throw new Error(`thiếu tóm tắt cho tin ${n}`);
  }
  return { intro: data.intro.trim(), items };
}

async function summarize(
  llm: LlmProvider,
  system: string,
  prompt: string,
  count: number,
  topics: readonly string[],
): Promise<{ ok: Summaries } | { error: string }> {
  let error = "";
  // Thử lại đúng một lần: model đôi khi trả JSON thiếu mục hoặc bị cắt.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const reply = await llm.generateText({
        task: "digest",
        system,
        prompt,
        maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
      });
      return { ok: parseSummaries(reply, count, topics) };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      log.warn("tóm tắt hỏng", { attempt, error: error.slice(0, 300) });
    }
  }
  return { error: error.slice(0, 500) };
}

// ---------------------------------------------------------------------------------------------
// Dựng plan

export interface DigestDeps {
  db: Database;
  /** Hồ sơ nhận digest: xếp hạng và ghi `profile_id` của digest, tin, phản hồi theo giá trị này. */
  profileId: number;
  http?: HttpClient;
  llm: LlmProvider | null;
  /** Model quyết định cho vùng xám của cổng chủ đề; không có thì dùng luật R ≥ gateR. */
  decider?: DecisionProvider | null;
}

async function loadDocs(db: Database, rank: RankResult): Promise<Map<number, ItemDoc[]>> {
  const out = new Map<number, ItemDoc[]>();
  const eventIds = rank.picked.map((p) => p.event.eventId);
  if (eventIds.length === 0) return out;
  const rows = await db
    .select({
      eventId: eventDocuments.eventId,
      id: documents.id,
      sourceId: documents.sourceId,
      externalId: documents.externalId,
      title: documents.title,
      url: documents.url,
      urlCanonical: documents.urlCanonical,
      text: docText.text,
    })
    .from(eventDocuments)
    .innerJoin(documents, eq(documents.id, eventDocuments.documentId))
    .leftJoin(docText, eq(docText.documentId, documents.id))
    .where(inArray(eventDocuments.eventId, eventIds));
  const ids = rows.map((r) => r.id);
  const signals = new Map<number, Record<string, number>>();
  if (ids.length) {
    for (const s of await db.select().from(docSignals).where(inArray(docSignals.documentId, ids))) {
      signals.set(s.documentId, { ...signals.get(s.documentId), [s.metric]: s.value });
    }
  }
  const picked = new Map(rank.picked.map((p) => [p.event.eventId, p]));
  for (const r of rows) {
    const p = picked.get(r.eventId);
    // Chỉ tài liệu mà bước xếp hạng đã xét (cùng mốc thời gian).
    const rankDoc = p?.event.docs.find((d) => d.documentId === r.id);
    if (!p || !rankDoc) continue;
    const topicId = p.c.topicId;
    const list = out.get(r.eventId) ?? [];
    list.push({
      id: r.id,
      sourceId: r.sourceId,
      sourceName: rank.sourceNames.get(r.sourceId) ?? String(r.sourceId),
      kind: rank.sourceKinds.get(r.sourceId) ?? "",
      externalId: r.externalId,
      title: r.title,
      url: r.url,
      urlCanonical: r.urlCanonical,
      excerpt: excerptOf(r.text, r.title),
      signals: signals.get(r.id) ?? {},
      topicScore: topicId === null ? 0 : (rankDoc.topicScores.get(topicId) ?? 0),
      engagement: rankDoc.engagement,
    });
    out.set(r.eventId, list);
  }
  return out;
}

/** Văn bản đã embed bắt đầu bằng tiêu đề: bỏ phần đó, lấy đoạn đầu phần còn lại. */
function excerptOf(text: string | null, title: string | null): string {
  if (!text) return "";
  let body = text;
  if (title && body.startsWith(title)) body = body.slice(title.length);
  body = body.replace(/\s+/g, " ").trim();
  return body.length > LLM_EXCERPT_CHARS ? `${body.slice(0, LLM_EXCERPT_CHARS)}…` : body;
}

function scoreOfPick(p: RankResult["picked"][number]): PlanItem["score"] {
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    S: r(p.S),
    penalty: r(p.penalty),
    R: r(p.c.R),
    P: r(p.c.P),
    C: r(p.c.C),
    A: r(p.c.A),
    F: r(p.c.F),
    N: r(p.c.N),
  };
}

function rankingInfo(
  rank: RankResult,
  ms: number,
  decider: DecisionProvider | null | undefined,
): DigestPlan["ranking"] {
  const rejected: Record<string, number> = {};
  for (const x of rank.rejected) rejected[x.reason] = (rejected[x.reason] ?? 0) + 1;
  const { priors, ...rest } = rank.config;
  return {
    candidates: rank.candidates,
    passedGate: rank.passedGate,
    rejected,
    config: { ...rest, priors: Object.fromEntries(priors) },
    baselines: rank.baselines,
    ms,
    decision: {
      model: decider?.model ?? null,
      counts: rank.gateCounts,
      ms: rank.gateMs,
      events: rank.gateDecisions.map((d) => ({
        ...d,
        R: Math.round(d.R * 1000) / 1000,
        probability: d.probability === null ? null : Math.round(d.probability * 1000) / 1000,
      })),
    },
  };
}

/**
 * Chọn tin và viết nội dung cho khoảng 24 giờ kết thúc ở `slot`. Tự nó không ghi gì vào DB (CLI
 * `--dry-run` gọi thẳng); `onRanked` cho nơi gọi móc việc ghi vào ngay sau bước xếp hạng.
 */
export async function buildPlan(
  deps: DigestDeps,
  slot: Date,
  onRanked?: (rank: RankResult) => Promise<void>,
): Promise<DigestPlan> {
  const period = { start: new Date(slot.getTime() - DAY_MS), end: slot };
  const rankStarted = Date.now();
  const rank = await rankPeriod(deps.db, period, {
    profileId: deps.profileId,
    http: deps.http,
    decider: deps.decider,
  });
  const rankMs = Date.now() - rankStarted;
  await onRanked?.(rank);
  const [prof] = await deps.db.select().from(profile).where(eq(profile.id, deps.profileId));
  const docsByEvent = await loadDocs(deps.db, rank);
  const date = vnDate(slot);
  const base = {
    version: 1 as const,
    builtAt: new Date().toISOString(),
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    ranking: rankingInfo(rank, rankMs, deps.decider),
  };

  if (rank.picked.length === 0) {
    const header: Message = {
      kind: "digest",
      title: `Điểm tin ${date}`,
      // Câu chữ do bạn chốt 13/10/2026.
      lines: [
        "Hôm nay không có tin tức đáng chú ý.",
        rank.passedGate > 0
          ? `Có ${rank.passedGate.toLocaleString("vi-VN")} sự kiện thuộc các chủ đề bạn quan tâm nhưng chưa đủ mức đáng đọc.`
          : "Không có sự kiện nào thuộc các chủ đề bạn quan tâm trong 24 giờ qua.",
      ],
    };
    return { ...base, header, items: [], summarized: false, llm: null };
  }

  const stories = rank.picked.map((p, i) => ({
    n: i + 1,
    topic: p.c.topicId === null ? null : (rank.topicLabels.get(p.c.topicId) ?? null),
    docs: docsByEvent.get(p.event.eventId) ?? [],
  }));

  let summaries: Summaries | null = null;
  let llmInfo: DigestPlan["llm"] = null;
  if (deps.llm) {
    const topics = [...rank.topicLabels].map(([id, label]): TopicChoice => {
      const note = rank.topicNotes.get(id);
      return note ? { label, note } : { label };
    });
    const result = await summarize(
      deps.llm,
      digestSystem(prof?.promptContext ?? "", prof?.displayLang ?? "vi", topics),
      digestPrompt(stories),
      stories.length,
      topics.map((t) => t.label),
    );
    if ("ok" in result) {
      summaries = result.ok;
      llmInfo = { model: deps.llm.model };
    } else llmInfo = { model: deps.llm.model, error: result.error };
  }

  const items: PlanItem[] = rank.picked.map((p, i) => {
    const story = stories[i] ?? { n: i + 1, topic: null, docs: [] };
    const written = summaries?.items.get(story.n);
    const { links, moreRelated } = buildLinks(story.docs);
    const fallbackTitle =
      [...story.docs].sort((a, b) => b.topicScore - a.topicScore)[0]?.title ?? p.event.title;
    const topic = written?.topic ?? story.topic;
    // N < 1: sự kiện đã gửi trước đó và nay có URL mới, nên là tin tiếp diễn (xep-hang.html, tab N).
    const why = [
      p.c.N < 1 ? "Cập nhật" : null,
      topic ? `Chủ đề: ${topic}` : null,
      sourcesLine(story.docs),
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      position: story.n,
      eventId: p.event.eventId,
      documentIds: story.docs.map((d) => d.id),
      message: {
        kind: "digest",
        title: `${story.n}. ${written?.title ?? fallbackTitle}`,
        lines: [written?.summary, why].filter((l): l is string => Boolean(l)),
        links,
        moreRelated,
        actions: ACTIONS,
      },
      score: scoreOfPick(p),
      topic,
      topicByEmbedding: story.topic,
      topicSource: written?.topic ? "llm" : "embedding",
    };
  });

  const count = `Chọn ${items.length} trong ${rank.passedGate.toLocaleString("vi-VN")} sự kiện thuộc các chủ đề bạn quan tâm trong 24 giờ qua.`;
  const header: Message = {
    kind: "digest",
    title: `Điểm tin ${date}`,
    lines: summaries
      ? [summaries.intro, count]
      : [
          count,
          "Bản không tóm tắt: phần tóm tắt bị lỗi, các tin dưới đây chỉ có tiêu đề gốc và link.",
        ],
  };
  return { ...base, header, items, summarized: summaries !== null, llm: llmInfo };
}

// ---------------------------------------------------------------------------------------------
// Gửi

export interface SendDeps extends DigestDeps {
  notifier: Notifier;
  recipient: string;
  /** Có thì link trong tin gửi đi là link theo dõi `<baseUrl>/o/<token>`; DB vẫn lưu link trực tiếp. */
  tracking?: { baseUrl: string; secret: string };
}

export interface DigestOutcome {
  digestId: number;
  status: "sent" | "already_sent";
  /** Số tin gửi trong lượt này (gồm tin mở đầu). */
  sentNow: number;
  items: number;
  summarized: boolean;
}

function asPlan(meta: Record<string, unknown>): DigestPlan | null {
  const plan = meta.plan as DigestPlan | undefined;
  return plan?.version === 1 ? plan : null;
}

/** Gửi điểm tin của khung giờ `slot` (mặc định: khung gần nhất). Chạy lại an toàn. */
export async function runDigest(
  deps: SendDeps,
  slot = digestSlot(new Date()),
): Promise<DigestOutcome> {
  const channel = deps.notifier.channel;
  const key = and(
    eq(digests.channel, channel),
    eq(digests.recipient, deps.recipient),
    eq(digests.periodEnd, slot),
  );
  await deps.db
    .insert(digests)
    .values({
      profileId: deps.profileId,
      channel,
      recipient: deps.recipient,
      periodStart: new Date(slot.getTime() - DAY_MS),
      periodEnd: slot,
      lang: "vi",
    })
    .onConflictDoNothing();
  const [row] = await deps.db.select().from(digests).where(key);
  if (!row) throw new Error("không tạo được dòng digests");
  if (row.status === "sent") {
    const plan = asPlan(row.meta);
    return {
      digestId: row.id,
      status: "already_sent",
      sentNow: 0,
      items: plan?.items.length ?? 0,
      summarized: plan?.summarized ?? false,
    };
  }

  try {
    let plan = asPlan(row.meta);
    if (!plan) {
      // Ghi bể ứng viên (mọi tin qua cổng, kể cả tin không chọn); lỗi ghi bị nuốt, không chặn gửi.
      plan = await buildPlan(deps, slot, (rank) =>
        recordCandidatePoolSafely(deps.db, deps.profileId, rank),
      );
      const [prof] = await deps.db
        .select({ lang: profile.displayLang })
        .from(profile)
        .where(eq(profile.id, deps.profileId));
      await deps.db
        .update(digests)
        .set({
          meta: { ...row.meta, plan },
          lang: prof?.lang ?? row.lang,
          status: "sending",
          error: null,
        })
        .where(eq(digests.id, row.id));
      log.info("đã lưu plan", {
        digestId: row.id,
        items: plan.items.length,
        summarized: plan.summarized,
      });
    } else if (row.status === "failed") {
      await deps.db
        .update(digests)
        .set({ status: "sending", error: null })
        .where(eq(digests.id, row.id));
    }
    const sentNow = await sendMissing(deps, row.id, plan);
    await deps.db
      .update(digests)
      .set({ status: "sent", sentAt: new Date() })
      .where(eq(digests.id, row.id));
    log.info("đã gửi điểm tin", { digestId: row.id, sentNow, items: plan.items.length });
    return {
      digestId: row.id,
      status: "sent",
      sentNow,
      items: plan.items.length,
      summarized: plan.summarized,
    };
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    await deps.db.update(digests).set({ status: "failed", error }).where(eq(digests.id, row.id));
    log.error("điểm tin lỗi, lượt sau gửi tiếp phần thiếu", { digestId: row.id, error });
    throw err;
  }
}

/**
 * Thay `url` của từng link bằng link theo dõi (chỉ số k = vị trí trong `links`, khớp `deliveries.meta.links`).
 * Không cấu hình theo dõi thì trả nguyên tin. Bản lưu trong DB vẫn là tin gốc.
 */
export function withTrackedLinks(
  message: Message,
  tracking: SendDeps["tracking"],
  digestId: number,
  position: number,
): Message {
  if (!tracking || !message.links?.length) return message;
  return {
    ...message,
    links: message.links.map((l, k) => ({
      ...l,
      url: buildTrackingUrl({ ...tracking, digestId, position, k }),
    })),
  };
}

async function sendMissing(deps: SendDeps, digestId: number, plan: DigestPlan): Promise<number> {
  const done = new Set(
    (
      await deps.db
        .select({ position: deliveries.position })
        .from(deliveries)
        .where(eq(deliveries.digestId, digestId))
    ).map((r) => r.position),
  );
  const queue = [
    { position: 0, kind: "header" as const, eventId: null, documentIds: [], message: plan.header },
    ...plan.items.map((it) => ({ ...it, kind: "event" as const })),
  ];
  let sent = 0;
  for (const q of queue) {
    if (done.has(q.position)) continue;
    const { messageId } = await deps.notifier.send(
      deps.recipient,
      withTrackedLinks(q.message, deps.tracking, digestId, q.position),
    );
    // Ghi ngay sau khi gửi: lỗi ở tin sau thì lượt chạy lại không gửi lại tin này.
    await deps.db.insert(deliveries).values({
      profileId: deps.profileId,
      digestId,
      channel: deps.notifier.channel,
      recipient: deps.recipient,
      messageId,
      kind: q.kind,
      position: q.position,
      eventId: q.eventId,
      documentIds: q.documentIds,
      title: q.message.title,
      body: q.message.lines.join("\n\n"),
      meta: { links: q.message.links ?? [], moreRelated: q.message.moreRelated ?? 0 },
    });
    sent++;
  }
  return sent;
}
