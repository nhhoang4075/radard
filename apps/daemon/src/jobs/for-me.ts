/**
 * "For me?" (decision 11/11/2026, mo-hinh-de-xuat.html): tap an item and the model says what this item means
 * for the READER themself, based on the real profile (description, context, enabled topics, a few 👍 items).
 * Separated from the shared summary so the summary does not have to guess "why it is notable for you" for every item.
 *
 * Authorization (fail-closed): the event must be in `feed_items` of the SAME profile (filtered by `profile_id`),
 * otherwise return `not_found` and do not call the model. Daily quota per profile (VN); cache hits are not counted.
 * Race protection: two calls for the same (profile, event) at once share ONE model call (in process);
 * `event_for_profile` has a unique key, so two processes racing still keep only one row.
 */
import { createLogger, type LlmProvider, sha256 } from "@radard/core";
import { type Database, eventForProfile, feedItems, profile } from "@radard/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { host, type ItemDoc, loadItemDocs } from "./item-docs.ts";
import { loadProfileTopics } from "./rank.ts";
import { docsForSummary, LANG_NAMES, loadSummariesById } from "./summaries.ts";

const log = createLogger("for-me");

/** Default quota: number of "For me?" answers per profile the model may write per day. Changed via `FOR_ME_DAILY_LIMIT`. */
export const DEFAULT_FOR_ME_DAILY_LIMIT = 100;
/** Number of most recent 👍 items given to the model. */
const LIKED_TITLES = 10;
const FOR_ME_MAX_OUTPUT_TOKENS = 2000;
const VN_OFFSET_MS = 7 * 3_600_000;

export interface ForMeDeps {
  db: Database;
  llm: LlmProvider | null;
  /** Default `DEFAULT_FOR_ME_DAILY_LIMIT`. */
  dailyLimit?: number;
  /** Clock, injected for tests. */
  now?: () => Date;
}

export type ForMeOutcome =
  | { status: "ok"; text: string; cached: boolean }
  /** The event is not in this profile's feed (or the profile does not exist). */
  | { status: "not_found" }
  /** Daily quota exhausted. */
  | { status: "limit" }
  /** Model not configured, or the model failed / returned empty. */
  | { status: "unavailable" };

/** 00:00 Vietnam time of the day containing `now`, as a UTC timestamp. */
export function vnDayStart(now: Date): Date {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - VN_OFFSET_MS);
}

/** Hashes the profile context for the cache; does NOT include liked items (so the cache is stable). */
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

/** Titles of the profile's most recent 👍 items (the newest label of each item is like; 👎 and unselect are dropped). */
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
  // Titles of sent items with a leading numbering ("3. …") are dropped.
  return rows.map((r) => r.title.replace(/^\d+\.\s+/, ""));
}

/** Whether there is quota left today (answers saved since 00:00 VN + the profile's running calls < quota). */
async function withinLimit(deps: ForMeDeps, profileId: number): Promise<boolean> {
  const limit = deps.dailyLimit ?? DEFAULT_FOR_ME_DAILY_LIMIT;
  const since = vnDayStart((deps.now ?? (() => new Date()))());
  const [used] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(eventForProfile)
    .where(and(eq(eventForProfile.profileId, profileId), gte(eventForProfile.createdAt, since)));
  // `inflightByProfile` already includes this call (added right after creating the promise), so subtract 1.
  const active = (inflightByProfile.get(profileId) ?? 1) - 1;
  return (used?.n ?? 0) + active < limit;
}

/** Pending model call for (profile, event, language, context): a second call shares the result. */
const inflight = new Map<string, Promise<ForMeOutcome>>();
/** Number of running calls per profile, added to the used count so the quota is not exceeded on rapid taps. */
const inflightByProfile = new Map<number, number>();

export async function explainForProfile(
  deps: ForMeDeps,
  q: { profileId: number; eventId: number },
): Promise<ForMeOutcome> {
  const { db } = deps;
  // 1. Authorization: the item must belong to the feed of the SAME profile. Nothing else is read before this step.
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

  // 2. Cache hit: no model call, quota not counted.
  const hit = await lookup();
  if (hit) return { status: "ok", text: hit.text, cached: true };

  // 3. Race protection: a call with the same key that is pending in the model shares its result.
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
    // Two processes racing: keep the row already there, drop our own answer.
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
