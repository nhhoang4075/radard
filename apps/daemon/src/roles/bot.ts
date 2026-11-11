/**
 * Bot role: receives 👍/👎 presses and topic-selection commands via chat (Telegram: long polling).
 * Only ONE instance runs per bot token: two instances long-polling together make Telegram return 409.
 */
import {
  type ChatChannel,
  type ChatHandlers,
  createLogger,
  type DecisionProvider,
  type EmbeddingProvider,
  type ForMeEvent,
  type ForMeResult,
  type LlmProvider,
  type ProfileHandlers,
  type SuggestedTopic,
  type TopicHandlers,
  type TopicItem,
} from "@radard/core";
import { type Database, deliveries, profileOf } from "@radard/db";
import { and, eq } from "drizzle-orm";
import { runBaselines } from "../jobs/baselines.ts";
import { recordFeedback } from "../jobs/feedback.ts";
import { explainForProfile } from "../jobs/for-me.ts";
import { scoreTopics } from "../jobs/process.ts";
import { describeReader, readProfile, saveProfile } from "../jobs/profile.ts";
import { suggestTopics } from "../jobs/topic-suggest.ts";
import {
  addCustomTopic,
  describeTopic,
  embedPendingTopics,
  listLibrary,
  listProfileTopics,
  setLibraryTopics,
  setTopicActive,
  toggleLibraryTopic,
} from "../jobs/topics.ts";

const log = createLogger("bot");

export interface BotDeps {
  db: Database;
  /** Profile assigned to feedback that cannot be linked to any item. */
  profileId: number;
  embedder: EmbeddingProvider | null;
  llm: LlmProvider | null;
  /** Decision model: scores library topics when suggesting topics (/profile). Without it, no suggestions. */
  decider: DecisionProvider | null;
  /** "Với tôi?" quota per profile per day (default in `for-me.ts`). */
  forMeDailyLimit?: number;
}

/**
 * After enabling or adding a topic: embed (1 request), score (SQL), recompute baselines, so the next digest
 * can use it right away without waiting for the process run or the 06:30 job. Runs in the background, one at a time.
 */
function refresher({ db, embedder }: BotBase) {
  let chain = Promise.resolve();
  return () => {
    if (!embedder) return;
    chain = chain
      .then(async () => {
        const embedded = await embedPendingTopics(db, embedder);
        if (embedded === 0) return;
        const scored = await scoreTopics(db, embedder.model);
        await runBaselines(db);
        log.info("đã cập nhật chủ đề mới", { embedded, scored });
      })
      .catch((err) => log.error("cập nhật chủ đề lỗi", { err: String(err) }));
  };
}

export function topicHandlers(deps: BotDeps, refresh: () => void = refresher(deps)): TopicHandlers {
  const { db, profileId } = deps;
  return {
    async list(): Promise<TopicItem[]> {
      const library = (await listLibrary(db, profileId)).map((t) => ({
        key: `l:${t.id}`,
        label: t.name,
        chosen: t.chosen,
      }));
      const custom = (await listProfileTopics(db, profileId))
        .filter((t) => t.origin === "custom" && t.kind === "include")
        .map((t) => ({ key: `c:${t.id}`, label: t.label, chosen: t.active }));
      return [...library, ...custom];
    },
    async toggle(key) {
      const [kind, raw] = key.split(":");
      const id = Number(raw);
      let on: boolean;
      if (kind === "l") {
        on = await toggleLibraryTopic(db, profileId, id);
      } else {
        const mine = (await listProfileTopics(db, profileId)).find((t) => t.id === id);
        if (!mine) throw new Error(`không có chủ đề ${key}`);
        on = !mine.active;
        await setTopicActive(db, profileId, id, on);
      }
      if (on) refresh();
      return on;
    },
    async describe(label, text) {
      if (!deps.llm) throw new Error("chưa có AI_GATEWAY_API_KEY: không viết được câu mô tả");
      return describeTopic(deps.llm, label, text);
    },
    async addCustom(draft) {
      await addCustomTopic(db, profileId, draft);
      refresh();
    },
  };
}

/** Number of topics being followed, counted as in the /topics list: enabled library topics + enabled self-added topics. */
async function countFollowed(db: Database, profileId: number): Promise<number> {
  const library = (await listLibrary(db, profileId)).filter((t) => t.chosen).length;
  const custom = (await listProfileTopics(db, profileId)).filter(
    (t) => t.origin === "custom" && t.kind === "include" && t.active,
  ).length;
  return library + custom;
}

/** Key `l:<id>` → library topic id; other keys (self-added topics) are not suggestions, so they are skipped. */
const libraryIds = (keys: string[]) =>
  keys.filter((k) => /^l:\d+$/.test(k)).map((k) => Number(k.slice(2)));

export function profileHandlers(
  deps: BotDeps,
  refresh: () => void = refresher(deps),
): ProfileHandlers {
  const { db, profileId } = deps;
  return {
    get: () => readProfile(db, profileId),
    async saveDescription(text) {
      // Save the user's wording first: if the LLM fails, their wording is still there and the old context stays.
      await saveProfile(db, profileId, text);
      if (!deps.llm) return { rewritten: false };
      try {
        await saveProfile(db, profileId, text, await describeReader(deps.llm, text));
        return { rewritten: true };
      } catch (err) {
        log.warn("viết bối cảnh lỗi", { err: String(err).slice(0, 300) });
        return { rewritten: false };
      }
    },
    async suggest() {
      const { promptContext } = await readProfile(db, profileId);
      if (!promptContext) return null;
      const res = await suggestTopics(
        { db, profileId, decider: deps.decider, llm: deps.llm, embedder: deps.embedder },
        promptContext,
      );
      if (!res.ran.library) return null;
      // An enabled library topic is always pre-ticked, at whatever level: Save must not silently turn it off.
      const followed = (await listLibrary(db, profileId)).filter((t) => t.chosen);
      const chosen = new Set(followed.map((t) => t.id));
      const item =
        (tier: SuggestedTopic["tier"]) =>
        (s: { topicId: number; label: string }): SuggestedTopic => ({
          key: `l:${s.topicId}`,
          label: s.label,
          tier,
          checked: tier === "preselect" || chosen.has(s.topicId),
        });
      const suggested = new Set([...res.preselect, ...res.maybe].map((t) => t.topicId));
      // An enabled library topic that is not suggested still shows (the "being followed" group), so the suggestions
      // show everything the user is following. Self-added topics are managed by /topics.
      const kept = followed
        .filter((t) => !suggested.has(t.id))
        .map((t) => item("followed")({ topicId: t.id, label: t.name }));
      return {
        topics: [...res.preselect.map(item("preselect")), ...res.maybe.map(item("maybe")), ...kept],
        newTopics: res.newTopics.map((t) => ({
          label: t.name,
          why: t.why,
          embedText: t.embedText,
        })),
      };
    },
    async apply(on, off, add) {
      let created = 0;
      for (const p of add) {
        // A self-added topic must have the user's own wording (`topics.description`). A suggestion is not
        // their wording, so use exactly the sentence radard showed them ("name: why") as the description: they read it,
        // ticked it and pressed Save, which counts as agreeing with it. The suggestion's English sentence becomes `embed_text`.
        try {
          await addCustomTopic(db, profileId, {
            label: p.label,
            description: `${p.label}: ${p.why}`,
            embedText: p.embedText,
          });
          created++;
        } catch (err) {
          // Name clash (e.g. just self-added via /topics): skip that topic, still save the rest.
          log.warn("không tạo được chủ đề đề xuất", { label: p.label, err: String(err) });
        }
      }
      const enabled = await setLibraryTopics(db, profileId, libraryIds(on), libraryIds(off));
      if (enabled + created > 0) refresh();
      return countFollowed(db, profileId);
    },
  };
}

/**
 * "Với tôi?" button on a Telegram message. The message must be a radard message sent to THIS profile (look up
 * `deliveries` by channel, recipient, item id AND `profile_id`); the item's event must also be in the profile's
 * feed (re-checked in `explainForProfile`). If not found, return `not_found`, no model call.
 */
export async function forMeFor(deps: BotDeps, ev: ForMeEvent): Promise<ForMeResult> {
  const [d] = await deps.db
    .select({ eventId: deliveries.eventId })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.channel, ev.channel),
        eq(deliveries.recipient, ev.recipient),
        eq(deliveries.messageId, ev.messageId),
        eq(deliveries.profileId, deps.profileId),
      ),
    );
  if (!d || d.eventId === null) return { status: "not_found" };
  const r = await explainForProfile(
    {
      db: deps.db,
      llm: deps.llm,
      ...(deps.forMeDailyLimit === undefined ? {} : { dailyLimit: deps.forMeDailyLimit }),
    },
    { profileId: deps.profileId, eventId: d.eventId },
  );
  return r.status === "ok" ? { status: "ok", text: r.text } : { status: r.status };
}

/** Handler of ONE profile: every query in it uses exactly this `profileId`. */
export function handlersFor(deps: BotDeps, refresh: () => void): ChatHandlers {
  return {
    onFeedback: (ev) => recordFeedback(deps.db, ev, deps.profileId),
    onForMe: (ev) => forMeFor(deps, ev),
    topics: topicHandlers(deps, refresh),
    profile: profileHandlers(deps, refresh),
  };
}

/** Shared bot tooling for all profiles: no `profileId`, each recipient attaches its own profile. */
export type BotBase = Omit<BotDeps, "profileId">;

/**
 * Recipient (chat id) → the handler of their profile via `profile_channels`. If not in the table (or
 * disabled), `null`: the channel ignores the update, and strangers cannot use the bot.
 */
export function chatResolver(base: BotBase, channel: string, refresh: () => void) {
  return async (recipient: string): Promise<{ scope: string; handlers: ChatHandlers } | null> => {
    const profileId = await profileOf(base.db, channel, recipient);
    if (profileId === null) return null;
    return { scope: String(profileId), handlers: handlersFor({ ...base, profileId }, refresh) };
  };
}

export async function startBot(base: BotBase, chat: ChatChannel): Promise<() => Promise<void>> {
  // One shared refresh chain (depends only on db and embedder): enabling topics from /topics and /profile
  // from anyone never runs embeddings concurrently.
  const refresh = refresher(base);
  await chat.start(chatResolver(base, chat.channel, refresh));
  return () => chat.stop();
}
