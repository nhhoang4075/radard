/**
 * Overlap check for similar topics, run BEFORE saving a self-added topic (docs/mo-hinh-quyet-dinh.html tab
 * 02 and 06). Reads the DB only; the only model call writes `llm_calls` (asks the relation, embeds the description).
 *
 * The decision model is asked the relation of the new topic to EVERY existing topic in one call:
 * overlapping, narrower, broader, or different. It is not pre-filtered by "item overlap ratio": measured on real data
 * (15/10/2026), generic items fall into the top 300 of many topics at once, pushing every pair's ratio
 * up to ~0,3, while the correct parent topic ("Hạ tầng AI" vs "Chạy LLM trên máy") is only 0,28 and gets missed. Asking all of them,
 * Jev picked the right answer for all 4 trial drafts, 0,6–0,9 seconds, ~3.100 tokens for 14 topics.
 *
 * "Item overlap ratio" (shared items among the top 300 matches of each side, last 30 days, divided by 300) and
 * example items are still computed for the topics the model says are close, as evidence for the user.
 */
import type { DecisionProvider, EmbeddingProvider } from "@radard/core";
import type { Database } from "@radard/db";
import { sql } from "drizzle-orm";
import { topicQueryText } from "../topics/instruct.ts";
import { TOPIC_NAMES_EN } from "../topics/library.ts";

/** Number of best-matching items per topic compared (tab 02: 300 items over 30 days). */
export const OVERLAP_TOP_N = 300;
export const OVERLAP_WINDOW_DAYS = 30;

/**
 * Items within the top 300 of this many or more library topics are "generic" (short, vague headlines
 * like "OpenAI (2015)"): measured 15/10/2026 on server data, 125 items were in the top 300
 * of ≥ 6 of the 14 topics. They are not used as example items, because they do not show where two topics differ;
 * their overlap ratio is still counted.
 */
export const HUB_MIN_TOPICS = 6;

/**
 * Maximum questions per call: Jev takes at most 32k tokens for state + questions; 14 topics
 * cost ~3.100 tokens, so 30 topics still leave plenty of room. More than that is split into several calls.
 */
export const MAX_QUESTIONS_PER_CALL = 30;
const EXAMPLES = 3;

/** The four relations, worded exactly as tried on 6 models on 13/10/2026 (tab 05). */
export const RELATION_CRITERIA = {
  same: "The new topic covers essentially the same news as the existing topic",
  narrower: "The new topic is a narrower part of the existing topic",
  broader: "The new topic is broader than the existing topic and includes it",
  different: "The topics are about different news, with only small overlap",
} as const;
export type TopicRelation = keyof typeof RELATION_CRITERIA;
/** Relations worth reporting to the user, in display order. */
export type CloseRelation = Exclude<TopicRelation, "different">;
const RELATION_ORDER: Record<CloseRelation, number> = { same: 0, narrower: 1, broader: 2 };

/** The question for the topic with key `key` in the state's `existing_topics`. */
export function relationInstructions(key: string): string {
  return `How does the new topic relate to the existing topic ${key}, in terms of which news articles each would match?`;
}

export interface TopicDraft {
  label: string;
  /** English description sentence used for embedding (same form as `describeTopic` writes). */
  embedText: string;
}

export interface OverlapCandidate {
  topicId: number;
  label: string;
  origin: "library" | "custom";
  /** The user has selected and enabled this topic. */
  enabled: boolean;
  relation: CloseRelation;
  /** The model's probability for the chosen relation. */
  probability: number;
  /** Item overlap ratio, 0..1 (including generic items). */
  ratio: number;
  /** Item titles both catch, matched to the newest topic first, generic items dropped. */
  shared: string[];
  /** Item titles only the new topic catches, matched to the newest topic first, generic items dropped. */
  onlyNew: string[];
}

export interface OverlapCheck {
  /** `false`: no decision model or the call failed, so the check could not run (no candidates). */
  ran: boolean;
  /** Close topics the model reports: overlapping, then narrower, then broader; within one relation, the more confident first. */
  candidates: OverlapCandidate[];
  /** Number of existing topics asked. */
  asked: number;
  /** The model answered; `null` when it did not run. */
  model: string | null;
  /** Number of items in the new topic's comparison set (equals `OVERLAP_TOP_N` when there is enough data); 0 when no measurement is needed. */
  docs: number;
}

interface NewDoc {
  id: number;
  title: string;
}

type TopicRow = {
  id: number;
  /** Library key; `null` for self-added topics. */
  key: string | null;
  label: string;
  origin: "library" | "custom";
  embedText: string;
  enabled: boolean;
  /** Already has a score in `doc_topic_scores`. */
  scored: boolean;
};

interface Relation {
  topic: TopicRow;
  relation: CloseRelation;
  probability: number;
}

export interface OverlapDeps {
  db: Database;
  profileId: number;
  embedder: EmbeddingProvider;
  decider: DecisionProvider | null;
}

/**
 * Asks the relation of the draft to every topic with an embedding (library topics and the profile's
 * self-added topics, enabled or disabled), then measures the item overlap ratio and takes example items for topics that are not "different".
 * Writes nothing except `llm_calls`.
 */
export async function checkTopicOverlap(
  deps: OverlapDeps,
  draft: TopicDraft,
  opts: { topN?: number; now?: Date; hubMinTopics?: number } = {},
): Promise<OverlapCheck> {
  const topics = await existingTopics(deps.db, deps.profileId, deps.embedder.model);
  const notRun = { ran: false, candidates: [], asked: topics.length, model: null, docs: 0 };
  if (!deps.decider) return notRun;
  if (topics.length === 0) return { ...notRun, ran: true };
  const asked = await askRelations(deps.decider, draft, topics);
  if (!asked) return notRun;
  const close = asked.relations.sort(
    (a, b) =>
      RELATION_ORDER[a.relation] - RELATION_ORDER[b.relation] || b.probability - a.probability,
  );
  const base = { ran: true, asked: topics.length, model: asked.model };
  if (close.length === 0) return { ...base, candidates: [], docs: 0 };
  const evidence = await measureOverlap(deps, draft, topics, close, opts);
  return { ...base, ...evidence };
}

/** Item overlap ratio and example items for the close topics, ordered as `close`. */
async function measureOverlap(
  deps: OverlapDeps,
  draft: TopicDraft,
  topics: TopicRow[],
  close: Relation[],
  opts: { topN?: number; now?: Date; hubMinTopics?: number },
): Promise<{ candidates: OverlapCandidate[]; docs: number }> {
  const topN = opts.topN ?? OVERLAP_TOP_N;
  const since = new Date((opts.now ?? new Date()).getTime() - OVERLAP_WINDOW_DAYS * 86_400_000);
  const model = deps.embedder.model;
  const [vector] = await deps.embedder.embed(
    [topicQueryText(draft.embedText)],
    "embed_topic_draft",
  );
  if (!vector) throw new Error("embedder không trả vector");
  const newTop = await topDocsForVector(deps.db, vector, model, since, topN);
  // Top N set of each close topic (for the ratio) and of every library topic (to recognize generic
  // items): only the part inside the new topic's set is needed.
  const closeIds = new Set(close.map((c) => c.topic.id));
  const wanted = topics.filter((t) => closeIds.has(t.id) || t.origin === "library");
  const sets = await sharedDocs(
    deps.db,
    wanted,
    newTop.map((d) => d.id),
    since,
    topN,
  );
  const hubs = hubDocs(topics, sets, opts.hubMinTopics ?? HUB_MIN_TOPICS);
  const candidates = close.map((c) => {
    const shared = sets.get(c.topic.id) ?? new Set<number>();
    const examples = (inShared: boolean) =>
      newTop
        .filter((d) => !hubs.has(d.id) && shared.has(d.id) === inShared)
        .slice(0, EXAMPLES)
        .map((d) => d.title);
    return {
      topicId: c.topic.id,
      label: c.topic.label,
      origin: c.topic.origin,
      enabled: c.topic.enabled,
      relation: c.relation,
      probability: c.probability,
      ratio: newTop.length === 0 ? 0 : shared.size / newTop.length,
      shared: examples(true),
      onlyNew: examples(false),
    };
  });
  return { candidates, docs: newTop.length };
}

/** Items within the top N of at least `min` library topics. */
function hubDocs(topics: TopicRow[], sets: Map<number, Set<number>>, min: number): Set<number> {
  const count = new Map<number, number>();
  for (const t of topics) {
    if (t.origin !== "library") continue;
    for (const id of sets.get(t.id) ?? []) count.set(id, (count.get(id) ?? 0) + 1);
  }
  return new Set([...count].filter(([, n]) => n >= min).map(([id]) => id));
}

/** Top N documents of the window by cosine with `vector`, highest first; scored like `scoreTopics`. */
async function topDocsForVector(
  db: Database,
  vector: number[],
  model: string,
  since: Date,
  topN: number,
): Promise<NewDoc[]> {
  const v = sql`${JSON.stringify(vector)}::halfvec`;
  const rows = await db.execute(sql`
    select dt.document_id::int as id, coalesce(d.title, left(dt.text, 120)) as title
    from doc_text dt
    join documents d on d.id = dt.document_id
    where dt.embedding_model = ${model}
      and coalesce(d.published_at, d.fetched_at) >= ${since}
    order by coalesce(dt.content_embedding, dt.embedding) <=> ${v}, dt.document_id
    limit ${topN}`);
  return [...rows].map((r) => ({ id: Number(r.id), title: String(r.title) }));
}

/** Topics to compare: library topics in use and the profile's self-added topics, with an embedding from the same model. */
async function existingTopics(db: Database, profileId: number, model: string): Promise<TopicRow[]> {
  const rows = await db.execute(sql`
    select t.id::int as id, t.key, t.name as label, t.origin, t.embed_text as "embedText",
      coalesce(pt.active, false) as enabled,
      exists (select 1 from doc_topic_scores s where s.topic_id = t.id) as scored
    from topics t
    left join profile_topics pt on pt.topic_id = t.id and pt.profile_id = ${profileId}
    where t.embedding is not null and t.embedding_model = ${model}
      and ((t.origin = 'library' and t.active)
        or (t.origin = 'custom' and t.owner_profile_id = ${profileId}))
    order by t.id`);
  return [...rows].map((r) => ({
    id: Number(r.id),
    key: r.key === null ? null : String(r.key),
    label: String(r.label),
    origin: r.origin === "custom" ? "custom" : "library",
    embedText: String(r.embedText),
    enabled: Boolean(r.enabled),
    scored: Boolean(r.scored),
  }));
}

/**
 * For each topic: the documents that are in both its top N and `ids` (the top N of the new topic).
 * A topic already scored (`doc_topic_scores`, process job) reads the existing scores, ~20 times faster
 * (measured 15/10/2026: 14 topics ~50 ms vs ~1.2 seconds); a topic just embedded and not yet scored uses cosine.
 */
async function sharedDocs(
  db: Database,
  topics: TopicRow[],
  ids: number[],
  since: Date,
  topN: number,
): Promise<Map<number, Set<number>>> {
  const out = new Map<number, Set<number>>();
  if (ids.length === 0) return out;
  const idArray = sql`${`{${ids.join(",")}}`}::bigint[]`;
  const scored = topics.filter((t) => t.scored).map((t) => t.id);
  const unscored = topics.filter((t) => !t.scored).map((t) => t.id);
  const collect = (rows: Iterable<Record<string, unknown>>) => {
    for (const r of rows) {
      const set = out.get(Number(r.topic_id)) ?? new Set<number>();
      set.add(Number(r.document_id));
      out.set(Number(r.topic_id), set);
    }
  };
  if (scored.length > 0) {
    collect(
      await db.execute(sql`
        select t.id as topic_id, x.document_id
        from unnest(${`{${scored.join(",")}}`}::bigint[]) as t(id)
        cross join lateral (
          select s.document_id from doc_topic_scores s
          join documents d on d.id = s.document_id
          where s.topic_id = t.id and coalesce(d.published_at, d.fetched_at) >= ${since}
          order by s.score desc, s.document_id
          limit ${topN}) x
        where x.document_id = any(${idArray})`),
    );
  }
  if (unscored.length > 0) {
    collect(
      await db.execute(sql`
        select t.id as topic_id, x.document_id
        from topics t
        cross join lateral (
          select dt.document_id from doc_text dt
          join documents d on d.id = dt.document_id
          where dt.embedding_model = t.embedding_model
            and coalesce(d.published_at, d.fetched_at) >= ${since}
          order by coalesce(dt.content_embedding, dt.embedding) <=> t.embedding, dt.document_id
          limit ${topN}) x
        where t.id = any(${`{${unscored.join(",")}}`}::bigint[])
          and x.document_id = any(${idArray})`),
    );
  }
  return out;
}

/**
 * The short English name of a topic: the part before the colon of its description sentence ("AI agents: …"). The model
 * decision is only guaranteed in English, so the Vietnamese name is not passed when it can be avoided.
 */
export function englishName(embedText: string, fallback: string): string {
  const head = embedText.split(":")[0]?.trim() ?? "";
  return head.length > 0 && head.length <= 80 && head !== embedText.trim() ? head : fallback;
}

/**
 * English name passed to the decision model: library topics use the built-in name (`TOPIC_NAMES_EN`,
 * exactly the name measured); self-added topics use the "Name:" part of the description sentence, or the label if there is none.
 */
export function topicNameEn(t: { key: string | null; label: string; embedText: string }) {
  return (t.key ? TOPIC_NAMES_EN[t.key] : undefined) ?? englishName(t.embedText, t.label);
}

const keyOf = (t: TopicRow) => `topic_${t.id}`;

/**
 * Each existing topic has one `choice` question, in one shared state: the new topic and the existing topics by
 * question key (`existing_topics.topic_<id>`). Above `MAX_QUESTIONS_PER_CALL` topics, it splits into batches, and
 * the batches are called in parallel. If a batch fails it gives `null` (the error is logged in `llm_calls`): a half-done check easily misses things, so it counts as not checked.
 */
async function askRelations(
  decider: DecisionProvider,
  draft: TopicDraft,
  topics: TopicRow[],
): Promise<{ relations: Relation[]; model: string } | null> {
  const newTopic = {
    name: englishName(draft.embedText, draft.label),
    description: draft.embedText,
  };
  const batches: TopicRow[][] = [];
  for (let i = 0; i < topics.length; i += MAX_QUESTIONS_PER_CALL) {
    batches.push(topics.slice(i, i + MAX_QUESTIONS_PER_CALL));
  }
  try {
    const results = await Promise.all(batches.map((b) => askBatch(decider, newTopic, b)));
    return { relations: results.flatMap((r) => r.relations), model: results[0]?.model ?? "" };
  } catch {
    return null;
  }
}

async function askBatch(
  decider: DecisionProvider,
  newTopic: { name: string; description: string },
  batch: TopicRow[],
): Promise<{ relations: Relation[]; model: string }> {
  const state = {
    new_topic: newTopic,
    existing_topics: Object.fromEntries(
      batch.map((t) => [keyOf(t), { name: topicNameEn(t), description: t.embedText }]),
    ),
  };
  const questions = Object.fromEntries(
    batch.map((t) => [
      keyOf(t),
      {
        type: "choice" as const,
        instructions: relationInstructions(keyOf(t)),
        criteria: RELATION_CRITERIA,
      },
    ]),
  );
  const res = await decider.decide({ task: "topic_overlap", state, questions });
  const relations: Relation[] = [];
  for (const t of batch) {
    const a = res.answers[keyOf(t)];
    if (!a || a.choice === "different") continue;
    relations.push({
      topic: t,
      relation: a.choice as CloseRelation,
      probability: a.probabilities[a.choice] ?? 0,
    });
  }
  return { relations, model: res.model };
}
