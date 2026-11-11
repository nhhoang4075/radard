/**
 * Job điểm tin (digest) mỗi sáng: lớp THÔNG BÁO của feed (quyết định 10/11/2026). Tin lấy từ bản chụp
 * feed của ngày (feed.ts: một bản chụp mỗi hồ sơ mỗi khung, select chạy một lần với trần K); digest
 * chỉ lấy ≤ 7 tin đầu của bản chụp qua sàn thông báo, dùng tóm tắt CHUNG đã chụp trong bản chụp
 * (`feed_items.summary_id`, summaries.ts; không có model tóm tắt riêng), nhờ LLM gán nhãn chủ đề và viết
 * lời mở đầu theo hồ sơ (một lời gọi nhỏ chỉ nhận tiêu đề), gửi qua Notifier. Telegram không ảnh
 * hưởng việc chọn feed.
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
  FOR_ME_COPY,
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
  enabledRecipients,
  type FeedItem,
  profile,
} from "@radard/db";
import { and, eq } from "drizzle-orm";
import { adapterFor } from "../sources/index.ts";
import { TOPIC_TIE_BREAKS } from "../topics/library.ts";
import { buildTrackingUrl } from "../web/token.ts";
import {
  ensureFeedSnapshot,
  type FeedItemDraft,
  feedItemsOf,
  notifiedItems,
  type RankingInfo,
  rankingInfo,
  snapshotLearning,
  snapshotRanking,
} from "./feed.ts";
import { host, type ItemDoc, loadItemDocs } from "./item-docs.ts";
import { loadProfileTopics, type RankResult, rankPeriod } from "./rank.ts";
import type { SelectionLearning } from "./selection-learning.ts";
import {
  ensureSharedSummaries,
  LANG_NAMES,
  LLM_MAX_OUTPUT_TOKENS,
  loadSummariesById,
  type SharedSummary,
} from "./summaries.ts";

export type { ItemDoc } from "./item-docs.ts";

const log = createLogger("digest");

/** Giờ gửi theo giờ Việt Nam. VN không đổi giờ theo mùa nên lệch UTC cố định +7. */
export const DIGEST_HOUR_VN = 7;
const VN_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

/** Số bài "Bài khác" hiện thành link; phần còn lại thành "+N bài". */
const MAX_RELATED = 3;
const ACTIONS: Message["actions"] = [
  { id: "like", label: "👍" },
  { id: "dislike", label: "👎" },
  // Nhãn tạm, chủ dự án duyệt câu chữ: mọi chuỗi mới nằm ở FOR_ME_COPY (packages/core/src/copy.ts).
  { id: "for_me", label: FOR_ME_COPY.button },
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
  /** Tin feed tương ứng và vị trí của nó trong bản chụp; vắng ở plan trước feed và ở bản xem thử. */
  feedItemId?: number;
  feedPosition?: number;
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
    /** Điểm gu; vắng ở plan trước khi có U (S theo công thức cũ). */
    U?: number;
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
  /** Xếp hạng của bản chụp feed mà bản tin lấy tin (cấu hình là cấu hình chung, gồm trần feed). */
  ranking: RankingInfo;
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
// LLM theo hồ sơ: gán nhãn chủ đề và lời mở đầu (một lời gọi nhỏ, chỉ nhận tiêu đề)
//
// Tóm tắt của từng tin là tóm tắt CHUNG (summaries.ts, quyết định 11/11/2026); chỉ hai việc này giữ
// theo hồ sơ vì cần chủ đề và bối cảnh của hồ sơ.

export interface Labels {
  intro: string;
  /** Nhãn chủ đề đúng nguyên văn trong danh sách của hồ sơ, theo số thứ tự tin; vắng nếu model chọn sai. */
  topics: Map<number, string>;
}

/** Một chủ đề đang bật, như LLM thấy khi gắn nhãn: tên và phạm vi (chủ đề tự thêm chỉ có tên). */
export interface TopicChoice {
  label: string;
  note?: string;
}

/**
 * `topics`: các chủ đề bạn đang theo dõi, kèm phạm vi. Model chọn nhãn cho từng tin vì nó đọc được
 * tiêu đề tiếng Việt/Anh và hiểu phạm vi chủ đề, còn embedding của tiêu đề 10 chữ hay đoán sai
 * (Janas, "streaming experts from SSD", bị gán RAG; 13/10/2026). Không đưa nhãn embedding vào prompt
 * để model không bám theo nhãn đó. Phạm vi (dòng "Not: …") và hai quy tắc phân xử lấy từ
 * docs/bo-chu-de-moi.html: khoảng 30% tin nằm giữa hai chủ đề, cần luật rõ để nhãn nhất quán.
 */
export function labelSystem(context: string, lang: string, topics: readonly TopicChoice[]): string {
  const language = LANG_NAMES[lang] ?? lang;
  return [
    "You label the stories of one reader's morning news brief and write its opening line.",
    `About the reader: ${context}`,
    `Write in ${language}. Keep product, company, model and library names as they are.`,
    "Use only the facts in the input. Never invent numbers, names, dates or claims.",
    "Never comment on the input itself (how much text you were given, missing details); just leave out what you do not know.",
    "Return ONLY a JSON object, no markdown fences, with this shape:",
    '{"intro": string, "items": [{"n": number, "topic": string}]}',
    "- intro: 1-2 sentences on what stands out today as a whole.",
    "- items: exactly one entry per input story, with the same n.",
    "- topic: the reader's topic this story is mostly about. Copy only the quoted label, exactly as written, from this list (the text after a label says what the topic covers):",
    ...topics.map((t) => `  - ${JSON.stringify(t.label)}${t.note ? `: ${t.note}` : ""}`),
    "  When a story fits two topics:",
    ...TOPIC_TIE_BREAKS.map((r) => `  - ${r}`),
    '  - Follow the "Not:" notes. If the topic a note points to is not in the list, choose the best of the listed topics.',
  ].join("\n");
}

export function labelPrompt(stories: readonly { n: number; title: string }[]): string {
  return stories.map((s) => `Story ${s.n}: ${s.title}`).join("\n");
}

/** Đọc JSON model trả về; thiếu lời mở đầu thì báo lỗi (để thử lại hoặc bỏ). Nhãn sai/thiếu thì bỏ nhãn đó. */
export function parseLabels(reply: string, topics: readonly string[] = []): Labels {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("không thấy JSON trong câu trả lời");
  const data = JSON.parse(reply.slice(start, end + 1)) as { intro?: unknown; items?: unknown };
  if (typeof data.intro !== "string" || data.intro.trim().length === 0) {
    throw new Error("thiếu intro");
  }
  if (!Array.isArray(data.items)) throw new Error("thiếu items");
  const known = new Set(topics);
  const labelled = new Map<number, string>();
  for (const it of data.items as { n?: unknown; topic?: unknown }[]) {
    // Nhãn sai hoặc thiếu không làm hỏng cả bản: dùng nhãn embedding cho tin đó.
    if (typeof it.n === "number" && typeof it.topic === "string" && known.has(it.topic.trim())) {
      labelled.set(it.n, it.topic.trim());
    }
  }
  return { intro: data.intro.trim(), topics: labelled };
}

async function labelStories(
  llm: LlmProvider,
  system: string,
  prompt: string,
  topics: readonly string[],
): Promise<{ ok: Labels } | { error: string }> {
  let error = "";
  // Thử lại đúng một lần: model đôi khi trả JSON thiếu hoặc bị cắt.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const reply = await llm.generateText({
        task: "digest_labels",
        system,
        prompt,
        maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
      });
      return { ok: parseLabels(reply, topics) };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      log.warn("gán nhãn hỏng", { attempt, error: error.slice(0, 300) });
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

/** Một tin của bản thông báo: tin feed đã lưu (có `id`) hoặc tin của bản xem thử (chưa lưu). */
type NotifySource = (FeedItem | FeedItemDraft) & { id?: number };

function scoreOfItem(it: NotifySource): PlanItem["score"] {
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    S: r(it.score),
    penalty: r(it.penalty),
    R: r(it.r),
    P: r(it.p),
    C: r(it.c),
    A: r(it.a),
    F: r(it.f),
    U: r(it.u ?? 0),
    N: r(it.n),
  };
}

/**
 * Xem thử (CLI `--dry-run`, test): xếp hạng như bản chụp feed (cùng select, trần K) rồi dựng bản
 * thông báo từ các tin được báo, KHÔNG ghi gì vào DB. `onRanked` cho nơi gọi móc việc ghi.
 */
export async function buildPlan(
  deps: DigestDeps,
  slot: Date,
  onRanked?: (rank: RankResult) => Promise<void>,
  /** Hạt giống chọn Gumbel top-k. Vắng: chọn xác định (T = 0), như CLI xem thử. */
  selectSeed?: number,
): Promise<DigestPlan> {
  const period = { start: new Date(slot.getTime() - DAY_MS), end: slot };
  const rankStarted = Date.now();
  const rank = await rankPeriod(deps.db, period, {
    profileId: deps.profileId,
    http: deps.http,
    decider: deps.decider,
    ...(selectSeed === undefined ? {} : { selectSeed }),
  });
  const rankMs = Date.now() - rankStarted;
  await onRanked?.(rank);
  return planFromItems(
    deps,
    slot,
    notifiedItems(feedItemsOf(rank, deps.profileId)),
    rankingInfo(rank, rankMs, deps.decider),
  );
}

/**
 * Bản thông báo từ các tin được báo của bản chụp (theo thứ tự báo): đọc tài liệu, nhờ LLM tóm tắt,
 * dựng tin. Không chọn lại gì.
 */
export async function planFromItems(
  deps: Pick<DigestDeps, "db" | "profileId" | "llm">,
  slot: Date,
  picked: readonly NotifySource[],
  ranking: RankingInfo,
): Promise<DigestPlan> {
  const period = { start: new Date(slot.getTime() - DAY_MS), end: slot };
  const [prof] = await deps.db.select().from(profile).where(eq(profile.id, deps.profileId));
  const topicRows = await loadProfileTopics(deps.db, deps.profileId);
  const topicLabels = new Map(topicRows.map((t) => [t.id, t.label]));
  const docsByEvent = await loadItemDocs(deps.db, picked);
  const date = vnDate(slot);
  const base = {
    version: 1 as const,
    builtAt: new Date().toISOString(),
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    ranking,
  };

  if (picked.length === 0) {
    const header: Message = {
      kind: "digest",
      title: `Điểm tin ${date}`,
      // Câu chữ do bạn chốt 13/10/2026.
      lines: [
        "Hôm nay không có tin tức đáng chú ý.",
        ranking.passedGate > 0
          ? `Có ${ranking.passedGate.toLocaleString("vi-VN")} sự kiện thuộc các chủ đề bạn quan tâm nhưng chưa đủ mức đáng đọc.`
          : "Không có sự kiện nào thuộc các chủ đề bạn quan tâm trong 24 giờ qua.",
      ],
    };
    return { ...base, header, items: [], summarized: false, llm: null };
  }

  const stories = picked.map((p, i) => ({
    n: i + 1,
    topic: p.topicId === null ? null : (topicLabels.get(p.topicId) ?? null),
    docs: docsByEvent.get(p.eventId) ?? [],
  }));

  // Tóm tắt CHUNG của từng tin: bản chụp đã chụp sẵn (`summary_id`). Chỉ tin của bản xem thử (chưa
  // lưu, không có `id`) mới được viết ở đây; tin của bản chụp thiếu tóm tắt (model lỗi lúc dựng)
  // giữ nguyên tiêu đề gốc, không gọi model lại: Telegram không có model tóm tắt riêng.
  const lang = prof?.displayLang ?? "vi";
  const snapshotSummaries = await loadSummariesById(
    deps.db,
    picked.flatMap((p) => (p.summaryId ? [p.summaryId] : [])),
  );
  const preview = picked.filter((p) => p.id === undefined && !p.summaryId);
  const previewSummaries =
    preview.length > 0
      ? (await ensureSharedSummaries({ db: deps.db, llm: deps.llm }, preview, lang)).byEvent
      : new Map<number, SharedSummary>();
  const summaryOf = (p: NotifySource): SharedSummary | undefined =>
    p.summaryId ? snapshotSummaries.get(p.summaryId) : previewSummaries.get(p.eventId);

  // Theo hồ sơ: nhãn chủ đề và lời mở đầu, một lời gọi nhỏ chỉ nhận tiêu đề.
  const titleOf = (p: NotifySource, docs: readonly ItemDoc[]): string =>
    summaryOf(p)?.title ??
    [...docs].sort((a, b) => b.topicScore - a.topicScore)[0]?.title ??
    p.title;
  let labels: Labels | null = null;
  let llmInfo: DigestPlan["llm"] = null;
  if (deps.llm) {
    const topics = topicRows.map(
      (t): TopicChoice => (t.note ? { label: t.label, note: t.note } : { label: t.label }),
    );
    const result = await labelStories(
      deps.llm,
      labelSystem(prof?.promptContext ?? "", lang, topics),
      labelPrompt(picked.map((p, i) => ({ n: i + 1, title: titleOf(p, stories[i]?.docs ?? []) }))),
      topics.map((t) => t.label),
    );
    if ("ok" in result) {
      labels = result.ok;
      llmInfo = { model: deps.llm.model };
    } else llmInfo = { model: deps.llm.model, error: result.error };
  }

  const items: PlanItem[] = picked.map((p, i) => {
    const story = stories[i] ?? { n: i + 1, topic: null, docs: [] };
    const written = summaryOf(p);
    const labelled = labels?.topics.get(story.n);
    const { links, moreRelated } = buildLinks(story.docs);
    const topic = labelled ?? story.topic;
    // N < 1: sự kiện đã gửi trước đó và nay có URL mới, nên là tin tiếp diễn (xep-hang.html, tab N).
    const why = [
      p.n < 1 ? "Cập nhật" : null,
      topic ? `Chủ đề: ${topic}` : null,
      sourcesLine(story.docs),
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      position: story.n,
      ...(p.id === undefined ? {} : { feedItemId: p.id }),
      feedPosition: p.position,
      eventId: p.eventId,
      documentIds: story.docs.map((d) => d.id),
      message: {
        kind: "digest",
        title: `${story.n}. ${titleOf(p, story.docs)}`,
        lines: [written?.summary, why].filter((l): l is string => Boolean(l)),
        links,
        moreRelated,
        actions: ACTIONS,
      },
      score: scoreOfItem(p),
      topic,
      topicByEmbedding: story.topic,
      topicSource: labelled ? "llm" : "embedding",
    };
  });

  const count = `Chọn ${items.length} trong ${ranking.passedGate.toLocaleString("vi-VN")} sự kiện thuộc các chủ đề bạn quan tâm trong 24 giờ qua.`;
  const summarized = picked.some((p) => summaryOf(p) !== undefined);
  const header: Message = {
    kind: "digest",
    title: `Điểm tin ${date}`,
    lines: [
      ...(labels ? [labels.intro] : []),
      count,
      ...(summarized
        ? []
        : ["Bản không tóm tắt: phần tóm tắt bị lỗi, các tin dưới đây chỉ có tiêu đề gốc và link."]),
    ],
  };
  return { ...base, header, items, summarized, llm: llmInfo };
}

// ---------------------------------------------------------------------------------------------
// Gửi

export interface SendDeps extends DigestDeps {
  notifier: Notifier;
  recipient: string;
  /** Có thì link trong tin gửi đi là link theo dõi `<baseUrl>/o/<token>`; DB vẫn lưu link trực tiếp. */
  tracking?: { baseUrl: string; secret: string };
  /** Tính dữ liệu học sau khi chọn bản chụp (mặc định `computeSelectionLearning`); chỉ test thay. */
  computeLearning?: (rank: RankResult) => SelectionLearning | null;
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

/** Phụ thuộc của job digest trước khi gắn người nhận: thiếu `profileId` và `recipient`. */
export type DigestJobDeps = Omit<SendDeps, "profileId" | "recipient">;

/**
 * Mỗi khung 07:00: trước hết dựng (hoặc đọc lại) MỘT bản chụp feed cho mỗi hồ sơ có người nhận đang
 * bật của kênh đang có notifier (`profile_channels`), rồi gửi bản thông báo cho từng người nhận. Kênh
 * chưa có ai thì không làm gì. Một hồ sơ/người lỗi không chặn người khác; xong hết mới ném lỗi (để
 * pg-boss chạy lại; bản chụp đã `ready` và người đã gửi xong thì lượt sau không làm lại).
 */
export async function runDigestAll(
  deps: DigestJobDeps,
  slot = digestSlot(new Date()),
): Promise<DigestOutcome[]> {
  const outcomes: DigestOutcome[] = [];
  const errors: unknown[] = [];
  const recipients = await enabledRecipients(deps.db, deps.notifier.channel);
  const failedProfiles = new Set<number>();
  for (const profileId of [...new Set(recipients.map((r) => r.profileId))]) {
    try {
      await ensureFeedSnapshot({ ...deps, profileId }, slot);
    } catch (err) {
      log.error("bản chụp feed lỗi cho một hồ sơ", {
        profileId,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
      failedProfiles.add(profileId);
      errors.push(err);
    }
  }
  for (const r of recipients) {
    if (failedProfiles.has(r.profileId)) continue;
    try {
      outcomes.push(
        await runDigest({ ...deps, profileId: r.profileId, recipient: r.recipient }, slot),
      );
    } catch (err) {
      log.error("digest lỗi cho một người nhận", {
        profileId: r.profileId,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
      errors.push(err);
    }
  }
  if (errors.length > 0) {
    throw errors.length === 1
      ? errors[0]
      : new AggregateError(errors, `${errors.length} người nhận digest lỗi`);
  }
  return outcomes;
}

/**
 * Gửi điểm tin của khung giờ `slot` (mặc định: khung gần nhất) cho một người nhận. Chạy lại an toàn.
 * Tin lấy từ bản chụp feed của (hồ sơ, khung) (dựng nếu chưa có, dùng lại nếu đã có): các tin có
 * `notify_position`, theo thứ tự đó. Không chọn lại gì ở đây.
 */
export async function runDigest(
  deps: SendDeps,
  slot = digestSlot(new Date()),
): Promise<DigestOutcome> {
  const channel = deps.notifier.channel;
  const key = and(
    eq(digests.profileId, deps.profileId),
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
      // Bản chụp là nguồn chọn: hạt giống, danh sách và tin được báo đã lưu ở đó (feed.ts). Chạy lại
      // khi plan chưa kịp lưu thì đọc lại đúng bản chụp, ra đúng các tin cũ.
      const { snapshot, items } = await ensureFeedSnapshot(deps, slot);
      const ranking = snapshotRanking(snapshot);
      if (!ranking) throw new Error(`bản chụp ${snapshot.id} thiếu thông tin xếp hạng`);
      plan = await planFromItems(deps, slot, notifiedItems(items), ranking);
      const learning = snapshotLearning(snapshot);
      const [prof] = await deps.db
        .select({ lang: profile.displayLang })
        .from(profile)
        .where(eq(profile.id, deps.profileId));
      await deps.db
        .update(digests)
        .set({
          feedSnapshotId: snapshot.id,
          meta: {
            ...row.meta,
            feedSnapshotId: snapshot.id,
            selectSeed: snapshot.selectSeed,
            plan,
            ...(learning ? { learning } : {}),
          },
          lang: prof?.lang ?? row.lang,
          status: "sending",
          error: null,
        })
        .where(eq(digests.id, row.id));
      log.info("đã lưu plan", {
        digestId: row.id,
        snapshotId: snapshot.id,
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
    {
      position: 0,
      kind: "header" as const,
      eventId: null,
      documentIds: [],
      message: plan.header,
      feedItemId: undefined,
    },
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
      feedItemId: q.feedItemId ?? null,
    });
    sent++;
  }
  return sent;
}
