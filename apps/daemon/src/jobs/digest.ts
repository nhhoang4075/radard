/**
 * Daily digest job (the notification layer of the feed, decision 10/11/2026). Items come from the day's feed snapshot
 * (feed.ts: one snapshot per profile per slot, select runs once with cap K); the digest
 * takes only the first ≤ 7 items of the snapshot that pass the notification floor, using the SHARED summary captured in the snapshot
 * (`feed_items.summary_id`, summaries.ts; there is no separate summary model), and an LLM labels the topics and writes
 * the per-profile opening line (one small call that only receives titles), then sends it via the Notifier. Telegram does not affect
 * the feed selection.
 *
 * Safe to re-run (tuan-3-thuc-thi.html, step 6):
 *    1. Each send slot (07:00 VN) has one `digests` row. If it is already `sent`, stop.
 *    2. The plan (exactly the items to send) is saved to `digests.meta.plan` BEFORE the first item is sent. Re-running
 *       reads the plan and does not reselect: if the HN points changed, reselecting could give a different list.
 *    3. Each item sent is recorded in `deliveries` right away; re-running skips positions that already have a delivery.
 * If the LLM fails, a digest without summaries is still sent (original titles and links). If no item passes the floor, a
 * short "quiet day today" message (D5) is sent, so you know radard is still running.
 */
import {
  createLogger,
  type DecisionProvider,
  FOR_ME_LABELS,
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

/** Send time in Vietnam time. Vietnam does not change clocks seasonally, so the offset from UTC is a fixed +7. */
export const DIGEST_HOUR_VN = 7;
const VN_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

/** Number of "Bài khác" items shown as links; the rest become "+N bài". */
const MAX_RELATED = 3;
const ACTIONS: Message["actions"] = [
  { id: "like", label: "👍" },
  { id: "dislike", label: "👎" },
  // Approved wording; every string lives in FOR_ME_LABELS (packages/core/src/copy.ts).
  { id: "for_me", label: FOR_ME_LABELS.button },
];

/** The latest send slot not later than `now`: the end of the 24-hour window. */
export function digestSlot(now: Date, hourVn = DIGEST_HOUR_VN): Date {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  let slot =
    Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate(), hourVn) - VN_OFFSET_MS;
  if (slot > now.getTime()) slot -= DAY_MS;
  return new Date(slot);
}

/** "14/10" in Vietnam time. */
export function vnDate(d: Date): string {
  const vn = new Date(d.getTime() + VN_OFFSET_MS);
  const dd = String(vn.getUTCDate()).padStart(2, "0");
  const mm = String(vn.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}`;
}

// ---------------------------------------------------------------------------------------------
// Plan: the shape stored in digests.meta.plan

export interface PlanItem {
  /** 1…n; the opening line is 0. */
  position: number;
  /** The matching feed item and its position in the snapshot; absent in plans before the feed and in previews. */
  feedItemId?: number;
  feedPosition?: number;
  eventId: number;
  documentIds: number[];
  message: Message;
  /** Why it was chosen: score, components, matched topic. */
  score: {
    S: number;
    penalty: number;
    R: number;
    P: number;
    C: number;
    A: number;
    F: number;
    /** Taste score; absent in plans before U existed (S by the old formula). */
    U?: number;
    N: number;
  };
  /** Label shown in the item: the topic the LLM picked when reading the item, or the best-matching embedding topic. */
  topic: string | null;
  /** Best-matching embedding topic (for R), kept to compare with the LLM's choice. */
  topicByEmbedding: string | null;
  topicSource: "llm" | "embedding";
}

export interface DigestPlan {
  version: 1;
  builtAt: string;
  period: { start: string; end: string };
  header: Message;
  items: PlanItem[];
  /** `false`: the version without summary (LLM failed or not configured). */
  summarized: boolean;
  llm: { model: string; error?: string } | null;
  /** Ranking of the feed snapshot the digest takes items from (the config is the shared one, including the feed cap). */
  ranking: RankingInfo;
}

/**
 * Link of an item. Different articles = different URLs (5 reposts of one URL count as one article).
 *   main: the article that best matches the topic · related: other articles, at most MAX_RELATED, the rest as "+N bài" ·
 *   discussion: the discussion page that the most people follow, if the source provides one (declared by the adapter).
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

/** "3 bài từ HN, arXiv", or "HN" when there is only one article. */
export function sourcesLine(docs: readonly ItemDoc[]): string {
  const names = [...new Set(docs.map((d) => d.sourceName))].join(", ");
  const n = new Set(docs.map((d) => d.urlCanonical)).size;
  return n > 1 ? `${n} bài từ ${names}` : names;
}

// ---------------------------------------------------------------------------------------------
// Per-profile LLM: labels the topics and writes the opening line (one small call, receives titles only)
//
// Each item's summary is the SHARED summary (summaries.ts, decision 11/11/2026); only these two jobs stay
// per profile, because they need the profile's topics and context.

export interface Labels {
  intro: string;
  /** Topic label verbatim from the profile's list, by item number; absent if the model picks wrongly. */
  topics: Map<number, string>;
}

/** An enabled topic, as the LLM sees it when labelling: its name and scope (self-added topics have only a name). */
export interface TopicChoice {
  label: string;
  note?: string;
}

/**
 * `topics`: the topics you are following, with their scope. The model picks the label for each item because it reads
 * Vietnamese and English headlines and understands the topic scope, while an embedding of a 10-word headline often guesses wrong
 * (Janas, "streaming experts from SSD", was tagged RAG; 13/10/2026). The embedding label is not put in the prompt
 * so the model does not anchor on it. The scope (the "Not: …" line) and two arbitration rules come from
 * docs/bo-chu-de-moi.html: about 30% of items sit between two topics, so clear rules are needed for consistent labels.
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

/** Reads the JSON the model returns; a missing opening line is an error (retry or drop). A wrong or missing label drops just that label. */
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
    // A wrong or missing label does not break the whole digest: use the embedding label for that item.
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
  // Retry exactly once: the model sometimes returns JSON that is missing fields or is truncated.
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
// Building the plan

export interface DigestDeps {
  db: Database;
  /** The digest's recipient profile: ranking and `profile_id` of the digest; items and feedback are keyed by this value. */
  profileId: number;
  http?: HttpClient;
  llm: LlmProvider | null;
  /** Decision model for the topic gate's grey zone; without it the rule R ≥ gateR is used. */
  decider?: DecisionProvider | null;
}

/** One item of the notification: a saved feed item (has `id`) or a preview item (not saved). */
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
 * Preview (CLI `--dry-run`, tests): ranks the way the feed snapshot does (same select, cap K), then builds the
 * notification from the notified items, writing NOTHING to the DB. `onRanked` lets the caller hook in its own writes.
 */
export async function buildPlan(
  deps: DigestDeps,
  slot: Date,
  onRanked?: (rank: RankResult) => Promise<void>,
  /** Seed of the Gumbel top-k selection. Absent: deterministic selection (T = 0), as in the CLI preview. */
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
 * The notification from the snapshot's notified items (in notification order): reads documents, asks the LLM for summaries,
 * builds items. Reselects nothing.
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
      // Wording approved by you on 13/10/2026.
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

  // Each item's SHARED summary is pre-captured in the snapshot (`summary_id`). Only preview items (not
  // saved, no `id`) are written here; a snapshot item missing its summary (the model failed when building)
  // keeps its original title and does not call the model again: Telegram has no summary model of its own.
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

  // Per profile: topic label and opening line, one small call that only receives titles.
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
    // N < 1: an event sent earlier that now has new URLs, so it is a continuing story (xep-hang.html, tab N).
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
// Sending

export interface SendDeps extends DigestDeps {
  notifier: Notifier;
  recipient: string;
  /** If set, links in the sent message are tracking links `<baseUrl>/o/<token>`; the DB still stores the direct links. */
  tracking?: { baseUrl: string; secret: string };
  /** Computes the learning data after the snapshot is selected (default `computeSelectionLearning`); only replaced in tests. */
  computeLearning?: (rank: RankResult) => SelectionLearning | null;
}

export interface DigestOutcome {
  digestId: number;
  status: "sent" | "already_sent";
  /** Number of items sent in this run (including the opening line). */
  sentNow: number;
  items: number;
  summarized: boolean;
}

function asPlan(meta: Record<string, unknown>): DigestPlan | null {
  const plan = meta.plan as DigestPlan | undefined;
  return plan?.version === 1 ? plan : null;
}

/** Dependencies of the digest job before a recipient is attached: missing `profileId` and `recipient`. */
export type DigestJobDeps = Omit<SendDeps, "profileId" | "recipient">;

/**
 * Each 07:00 slot: first builds (or reads back) ONE feed snapshot for each profile that has an enabled recipient
 * on a channel with a notifier (`profile_channels`), then sends the notification to each recipient. A channel
 * with nobody on it does nothing. One failing profile or recipient does not block the others; only after all are done does it throw an error (so
 * pg-boss re-runs it; a snapshot already `ready` and a recipient already sent to are not redone the next run).
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
 * Sends the digest of the send slot `slot` (default: the latest slot) to one recipient. Safe to re-run.
 * Items come from the feed snapshot of (profile, slot) (built if missing, reused if present): the items with
 * `notify_position`, in that order. Nothing is reselected here.
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
      // The snapshot is the source of selection: the seed, list and notified items are saved there (feed.ts). If a re-run
      // happens before the plan was saved, it reads back exactly that snapshot and gets the same old items.
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
 * Replaces each link's `url` with a tracking link (index k = position in `links`, matching `deliveries.meta.links`).
 * With no tracking configured the item is returned unchanged. The DB copy remains the original item.
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
    // Written right after sending: if a later item fails, the re-run does not send this item again.
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
