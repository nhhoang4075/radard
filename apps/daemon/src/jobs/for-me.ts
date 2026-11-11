/**
 * "Với tôi?" (quyết định 11/11/2026, mo-hinh-de-xuat.html): bấm vào một tin thì model nói tin này có
 * ý nghĩa gì với CHÍNH người đọc, dựa trên hồ sơ thật (mô tả, bối cảnh, chủ đề đang bật, vài tin đã 👍).
 * Tách khỏi tóm tắt chung để tóm tắt không phải đoán "vì sao đáng chú ý với bạn" cho mọi tin.
 *
 * Phân quyền (fail-closed): sự kiện phải nằm trong `feed_items` của CHÍNH hồ sơ (lọc theo `profile_id`),
 * không thì trả `not_found` và không gọi model. Hạn mức mỗi hồ sơ mỗi ngày (VN); cache hit không tính.
 * Chống đua: hai lượt cùng (hồ sơ, sự kiện) cùng lúc dùng chung MỘT lời gọi model (trong tiến trình);
 * `event_for_profile` có khoá duy nhất nên hai tiến trình đua nhau vẫn chỉ giữ một dòng.
 */
import { createLogger, type LlmProvider, sha256 } from "@radard/core";
import { type Database, eventForProfile, feedItems, profile } from "@radard/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { host, type ItemDoc, loadItemDocs } from "./item-docs.ts";
import { loadProfileTopics } from "./rank.ts";
import { docsForSummary, LANG_NAMES, loadSummariesById } from "./summaries.ts";

const log = createLogger("for-me");

/** Hạn mức mặc định: số câu "Với tôi?" mỗi hồ sơ được nhờ model viết mỗi ngày. Đổi qua `FOR_ME_DAILY_LIMIT`. */
export const DEFAULT_FOR_ME_DAILY_LIMIT = 100;
/** Số tin đã 👍 gần nhất đưa cho model. */
const LIKED_TITLES = 10;
const FOR_ME_MAX_OUTPUT_TOKENS = 2000;
const VN_OFFSET_MS = 7 * 3_600_000;

export interface ForMeDeps {
  db: Database;
  llm: LlmProvider | null;
  /** Mặc định `DEFAULT_FOR_ME_DAILY_LIMIT`. */
  dailyLimit?: number;
  /** Đồng hồ, tiêm vào để test. */
  now?: () => Date;
}

export type ForMeOutcome =
  | { status: "ok"; text: string; cached: boolean }
  /** Sự kiện không có trong feed của hồ sơ này (hoặc hồ sơ không tồn tại). */
  | { status: "not_found" }
  /** Hết hạn mức ngày. */
  | { status: "limit" }
  /** Chưa cấu hình model, hoặc model lỗi / trả rỗng. */
  | { status: "unavailable" };

/** 00:00 giờ VN của ngày chứa `now`, dạng thời điểm UTC. */
export function vnDayStart(now: Date): Date {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - VN_OFFSET_MS);
}

/** Băm bối cảnh hồ sơ cho cache; KHÔNG gồm tin đã thích (để cache ổn định). */
export function contextHashOf(p: {
  description: string | null;
  promptContext: string;
  topicIds: readonly number[];
}): string {
  const ids = [...p.topicIds].sort((a, b) => a - b).join(",");
  return sha256([p.description ?? "", p.promptContext, ids].join("\u0000"));
}

export function forMeSystem(lang: string): string {
  const language = LANG_NAMES[lang] ?? lang;
  return [
    "You tell one reader what a news story could mean for them, using what you know about them.",
    `Write in ${language}. Keep product, company, model and library names as they are.`,
    "Write 2-4 sentences of plain text: no markdown, no lists, no title.",
    "Use only the facts in the input. Never invent numbers, names, dates, claims, or details about the reader.",
    "If the story has no concrete link to this reader's profile, say so plainly in one sentence instead. Do not stretch a link.",
    "Say clearly that this is your inference from the reader's profile, not something the story reports.",
    "Never comment on the input itself (how much text you were given, missing details); just leave out what you do not know.",
  ].join("\n");
}

export function forMePrompt(i: {
  promptContext: string;
  description: string | null;
  topics: readonly string[];
  liked: readonly string[];
  title: string;
  summary: string | null;
  docs: readonly ItemDoc[];
}): string {
  const docs = i.docs.map((d) => {
    const head = `- [${d.sourceName}] ${d.title ?? "(no title)"} (${host(d.url)})`;
    return d.excerpt ? `${head}\n  Excerpt: ${d.excerpt}` : head;
  });
  return [
    "Reader",
    `About the reader: ${i.promptContext}`,
    ...(i.description ? [`In the reader's own words: ${i.description}`] : []),
    `Topics the reader follows: ${i.topics.length > 0 ? i.topics.join("; ") : "(none)"}`,
    ...(i.liked.length > 0
      ? ["Stories the reader liked recently:", ...i.liked.map((t) => `- ${t}`)]
      : []),
    "",
    "Story",
    `Title: ${i.title}`,
    ...(i.summary ? [`Summary: ${i.summary}`] : []),
    "Documents:",
    ...docs,
  ].join("\n");
}

/** Tiêu đề các tin hồ sơ đã 👍 gần nhất (nhãn mới nhất của mỗi tin là like; bỏ 👎 và bỏ chọn). */
async function recentLikedTitles(db: Database, profileId: number): Promise<string[]> {
  const rows = await db.execute<{ title: string }>(sql`
    select title from (
      select distinct on (k) k, kind, created_at, id, title from (
        select f.id, f.kind, f.created_at,
               coalesce('i:' || f.feed_item_id::text, 'd:' || f.delivery_id::text) as k,
               coalesce(fi.title, d.title) as title
        from feedback f
        left join feed_items fi on fi.id = f.feed_item_id and fi.profile_id = f.profile_id
        left join deliveries d on d.id = f.delivery_id and d.profile_id = f.profile_id
        where f.profile_id = ${profileId} and f.kind in ('like', 'dislike', 'clear')
          and (f.feed_item_id is not null or f.delivery_id is not null)
      ) x
      order by k, created_at desc, id desc
    ) latest
    where kind = 'like' and title is not null
    order by created_at desc, id desc
    limit ${LIKED_TITLES}`);
  // Tiêu đề tin đã gửi có số thứ tự đầu dòng ("3. …"): bỏ.
  return rows.map((r) => r.title.replace(/^\d+\.\s+/, ""));
}

/** Còn hạn mức hôm nay không (số câu đã lưu từ 00:00 VN + số lời gọi đang chạy của hồ sơ < hạn mức). */
async function withinLimit(deps: ForMeDeps, profileId: number): Promise<boolean> {
  const limit = deps.dailyLimit ?? DEFAULT_FOR_ME_DAILY_LIMIT;
  const since = vnDayStart((deps.now ?? (() => new Date()))());
  const [used] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(eventForProfile)
    .where(and(eq(eventForProfile.profileId, profileId), gte(eventForProfile.createdAt, since)));
  // `inflightByProfile` đã gồm cả lượt này (cộng ngay sau khi tạo lời hứa), nên trừ 1.
  const active = (inflightByProfile.get(profileId) ?? 1) - 1;
  return (used?.n ?? 0) + active < limit;
}

/** Đang chờ model theo (hồ sơ, sự kiện, ngôn ngữ, bối cảnh): lượt thứ hai dùng chung kết quả. */
const inflight = new Map<string, Promise<ForMeOutcome>>();
/** Số lời gọi đang chạy của mỗi hồ sơ, cộng vào số đã dùng để hạn mức không bị vượt khi bấm dồn. */
const inflightByProfile = new Map<number, number>();

export async function explainForProfile(
  deps: ForMeDeps,
  q: { profileId: number; eventId: number },
): Promise<ForMeOutcome> {
  const { db } = deps;
  // 1. Phân quyền: tin phải thuộc feed của CHÍNH hồ sơ. Chưa qua bước này thì không đọc gì thêm.
  const [item] = await db
    .select()
    .from(feedItems)
    .where(and(eq(feedItems.profileId, q.profileId), eq(feedItems.eventId, q.eventId)))
    .orderBy(desc(feedItems.id))
    .limit(1);
  if (!item) return { status: "not_found" };
  const [prof] = await db.select().from(profile).where(eq(profile.id, q.profileId));
  if (!prof) return { status: "not_found" };

  const topicRows = await loadProfileTopics(db, q.profileId);
  const contextHash = contextHashOf({
    description: prof.description,
    promptContext: prof.promptContext,
    topicIds: topicRows.map((t) => t.id),
  });
  const lang = prof.displayLang;
  const where = and(
    eq(eventForProfile.profileId, q.profileId),
    eq(eventForProfile.eventId, q.eventId),
    eq(eventForProfile.lang, lang),
    eq(eventForProfile.contextHash, contextHash),
  );
  const lookup = async () => (await db.select().from(eventForProfile).where(where))[0];

  // 2. Cache hit: không gọi model, không tính hạn mức.
  const hit = await lookup();
  if (hit) return { status: "ok", text: hit.text, cached: true };

  // 3. Chống đua: lượt cùng khoá đang chờ model thì dùng chung kết quả.
  const key = `${q.profileId}|${q.eventId}|${lang}|${contextHash}`;
  const running = inflight.get(key);
  if (running) {
    const r = await running;
    return r.status === "ok" ? { ...r, cached: true } : r;
  }
  const work = (async (): Promise<ForMeOutcome> => {
    const again = await lookup();
    if (again) return { status: "ok", text: again.text, cached: true };
    const llm = deps.llm;
    if (!llm) return { status: "unavailable" };

    if (!(await withinLimit(deps, q.profileId))) return { status: "limit" };
    const docs = docsForSummary((await loadItemDocs(db, [item])).get(item.eventId) ?? []);
    const summary = item.summaryId
      ? ((await loadSummariesById(db, [item.summaryId])).get(item.summaryId)?.summary ?? null)
      : null;
    const prompt = forMePrompt({
      promptContext: prof.promptContext,
      description: prof.description,
      topics: topicRows.map((t) => t.label),
      liked: await recentLikedTitles(db, q.profileId),
      title: item.title,
      summary,
      docs,
    });
    let text: string;
    try {
      text = (
        await llm.generateText({
          task: "for_me",
          system: forMeSystem(lang),
          prompt,
          maxOutputTokens: FOR_ME_MAX_OUTPUT_TOKENS,
        })
      ).trim();
    } catch (err) {
      log.warn("Với tôi? lỗi", {
        profileId: q.profileId,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
      return { status: "unavailable" };
    }
    if (text.length === 0) return { status: "unavailable" };
    await db
      .insert(eventForProfile)
      .values({
        profileId: q.profileId,
        eventId: q.eventId,
        lang,
        contextHash,
        text,
        model: llm.model,
      })
      .onConflictDoNothing();
    // Hai tiến trình đua nhau: giữ dòng đã có, bỏ câu của mình.
    return { status: "ok", text: (await lookup())?.text ?? text, cached: false };
  })();
  inflight.set(key, work);
  inflightByProfile.set(q.profileId, (inflightByProfile.get(q.profileId) ?? 0) + 1);
  try {
    return await work;
  } finally {
    inflight.delete(key);
    const left = (inflightByProfile.get(q.profileId) ?? 1) - 1;
    if (left <= 0) inflightByProfile.delete(q.profileId);
    else inflightByProfile.set(q.profileId, left);
  }
}
