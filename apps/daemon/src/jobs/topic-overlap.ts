/**
 * Soát chủ đề gần giống, chạy TRƯỚC khi lưu một chủ đề tự thêm (docs/mo-hinh-quyet-dinh.html tab
 * 02 và 06). Chỉ đọc DB; lời gọi model duy nhất ghi `llm_calls` (hỏi quan hệ, embed câu mô tả).
 *
 * Model ra quyết định được hỏi quan hệ của chủ đề mới với MỌI chủ đề có sẵn trong một lời gọi:
 * trùng, hẹp hơn, rộng hơn hay khác. Không lọc trước bằng "tỉ lệ trùng tin": đo trên dữ liệu thật
 * (15/10/2026), các tin chung chung lọt vào top 300 của nhiều chủ đề cùng lúc làm tỉ lệ của mọi cặp
 * lên ~0,3, trong khi chủ đề cha đúng ("Hạ tầng AI" với "Chạy LLM trên máy") chỉ 0,28 nên bị bỏ
 * sót. Hỏi hết thì Jev chọn đúng cả 4 bản nháp thử, 0,6–0,9 giây, ~3.100 token cho 14 chủ đề.
 *
 * "Tỉ lệ trùng tin" (số tin chung trong 300 tin khớp nhất của mỗi bên, 30 ngày qua, chia 300) và
 * tin ví dụ vẫn được tính cho các chủ đề model báo là gần, làm bằng chứng cho người dùng.
 */
import type { DecisionProvider, EmbeddingProvider } from "@radard/core";
import type { Database } from "@radard/db";
import { sql } from "drizzle-orm";
import { topicQueryText } from "../topics/instruct.ts";
import { TOPIC_NAMES_EN } from "../topics/library.ts";
import { PROFILE_ID } from "./topics.ts";

/** Số tin khớp nhất của mỗi chủ đề đem ra so (tab 02: 300 tin của 30 ngày). */
export const OVERLAP_TOP_N = 300;
export const OVERLAP_WINDOW_DAYS = 30;

/**
 * Tin nằm trong top 300 của từ chừng này chủ đề thư viện trở lên là tin "chung chung" (tiêu đề
 * ngắn, mơ hồ như "OpenAI (2015)"): đo 15/10/2026 trên dữ liệu server, 125 tin nằm trong top 300
 * của ≥ 6 trên 14 chủ đề. Không đưa chúng vào tin ví dụ vì chúng không cho thấy hai chủ đề khác
 * nhau ở đâu; tỉ lệ trùng tin thì vẫn tính cả chúng.
 */
export const HUB_MIN_TOPICS = 6;

/**
 * Tối đa số câu hỏi mỗi lời gọi: Jev nhận tối đa 32k token cho trạng thái + câu hỏi; 14 chủ đề
 * tốn ~3.100 token, nên 30 chủ đề vẫn dư nhiều. Nhiều hơn thì chia thành nhiều lời gọi.
 */
export const MAX_QUESTIONS_PER_CALL = 30;
const EXAMPLES = 3;

/** Bốn quan hệ, đúng câu chữ đã thử trên 6 model ngày 13/10/2026 (tab 05). */
export const RELATION_CRITERIA = {
  same: "The new topic covers essentially the same news as the existing topic",
  narrower: "The new topic is a narrower part of the existing topic",
  broader: "The new topic is broader than the existing topic and includes it",
  different: "The topics are about different news, with only small overlap",
} as const;
export type TopicRelation = keyof typeof RELATION_CRITERIA;
/** Quan hệ đáng báo cho người dùng, theo thứ tự hiển thị. */
export type CloseRelation = Exclude<TopicRelation, "different">;
const RELATION_ORDER: Record<CloseRelation, number> = { same: 0, narrower: 1, broader: 2 };

/** Câu hỏi cho chủ đề có khoá `key` trong `existing_topics` của trạng thái. */
export function relationInstructions(key: string): string {
  return `How does the new topic relate to the existing topic ${key}, in terms of which news articles each would match?`;
}

export interface TopicDraft {
  label: string;
  /** Câu mô tả tiếng Anh dùng để embed (cùng dạng `describeTopic` viết). */
  embedText: string;
}

export interface OverlapCandidate {
  topicId: number;
  label: string;
  origin: "library" | "custom";
  /** Người dùng đã chọn và đang bật chủ đề này. */
  enabled: boolean;
  relation: CloseRelation;
  /** Xác suất model cho quan hệ đã chọn. */
  probability: number;
  /** Tỉ lệ trùng tin, 0..1 (gồm cả tin chung chung). */
  ratio: number;
  /** Tiêu đề tin cả hai cùng bắt, khớp chủ đề mới nhất trước, bỏ tin chung chung. */
  shared: string[];
  /** Tiêu đề tin chỉ chủ đề mới bắt, khớp chủ đề mới nhất trước, bỏ tin chung chung. */
  onlyNew: string[];
}

export interface OverlapCheck {
  /** `false`: không có model quyết định hoặc lời gọi lỗi, nên chưa soát được (không có ứng viên). */
  ran: boolean;
  /** Chủ đề model báo là gần: trùng, rồi hẹp hơn, rồi rộng hơn; cùng quan hệ thì chắc hơn trước. */
  candidates: OverlapCandidate[];
  /** Số chủ đề có sẵn đã hỏi. */
  asked: number;
  /** Model đã trả lời; `null` khi không chạy. */
  model: string | null;
  /** Số tin trong tập so của chủ đề mới (bằng `OVERLAP_TOP_N` khi đủ dữ liệu); 0 khi không cần đo. */
  docs: number;
}

interface NewDoc {
  id: number;
  title: string;
}

type TopicRow = {
  id: number;
  /** Khoá thư viện; `null` với chủ đề tự thêm. */
  key: string | null;
  label: string;
  origin: "library" | "custom";
  embedText: string;
  enabled: boolean;
  /** Đã có điểm trong `doc_topic_scores`. */
  scored: boolean;
};

interface Relation {
  topic: TopicRow;
  relation: CloseRelation;
  probability: number;
}

export interface OverlapDeps {
  db: Database;
  embedder: EmbeddingProvider;
  decider: DecisionProvider | null;
}

/**
 * Hỏi quan hệ của bản nháp với mọi chủ đề có embedding (thư viện đang dùng và chủ đề tự thêm của
 * hồ sơ, bật hay tắt), rồi đo tỉ lệ trùng tin và lấy tin ví dụ cho các chủ đề không "khác".
 * Không ghi gì ngoài `llm_calls`.
 */
export async function checkTopicOverlap(
  deps: OverlapDeps,
  draft: TopicDraft,
  opts: { topN?: number; now?: Date; hubMinTopics?: number } = {},
): Promise<OverlapCheck> {
  const topics = await existingTopics(deps.db, deps.embedder.model);
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

/** Tỉ lệ trùng tin và tin ví dụ cho các chủ đề gần, xếp như `close`. */
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
  // Tập top N của chủ đề gần (để tính tỉ lệ) và của mọi chủ đề thư viện (để nhận ra tin chung
  // chung), chỉ cần phần nằm trong tập của chủ đề mới.
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

/** Tin nằm trong top N của ít nhất `min` chủ đề thư viện. */
function hubDocs(topics: TopicRow[], sets: Map<number, Set<number>>, min: number): Set<number> {
  const count = new Map<number, number>();
  for (const t of topics) {
    if (t.origin !== "library") continue;
    for (const id of sets.get(t.id) ?? []) count.set(id, (count.get(id) ?? 0) + 1);
  }
  return new Set([...count].filter(([, n]) => n >= min).map(([id]) => id));
}

/** Top N tài liệu của cửa sổ theo cosine với `vector`, cao trước; chấm như `scoreTopics`. */
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

/** Chủ đề đem ra so: thư viện đang dùng và chủ đề tự thêm của hồ sơ, có embedding cùng model. */
async function existingTopics(db: Database, model: string): Promise<TopicRow[]> {
  const rows = await db.execute(sql`
    select t.id::int as id, t.key, t.name as label, t.origin, t.embed_text as "embedText",
      coalesce(pt.active, false) as enabled,
      exists (select 1 from doc_topic_scores s where s.topic_id = t.id) as scored
    from topics t
    left join profile_topics pt on pt.topic_id = t.id and pt.profile_id = ${PROFILE_ID}
    where t.embedding is not null and t.embedding_model = ${model}
      and ((t.origin = 'library' and t.active)
        or (t.origin = 'custom' and t.owner_profile_id = ${PROFILE_ID}))
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
 * Với mỗi chủ đề: những tài liệu nằm trong cả top N của nó lẫn `ids` (top N của chủ đề mới).
 * Chủ đề đã được chấm (`doc_topic_scores`, job process) thì đọc điểm có sẵn, nhanh hơn ~20 lần
 * (đo 15/10/2026: 14 chủ đề ~50 ms so với ~1,2 giây); chủ đề vừa embed, chưa chấm thì tính cosine.
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
 * Tên tiếng Anh ngắn của chủ đề: phần trước dấu hai chấm của câu mô tả ("AI agents: …"). Model
 * quyết định chỉ được hãng bảo đảm với tiếng Anh, nên không đưa tên tiếng Việt khi tránh được.
 */
export function englishName(embedText: string, fallback: string): string {
  const head = embedText.split(":")[0]?.trim() ?? "";
  return head.length > 0 && head.length <= 80 && head !== embedText.trim() ? head : fallback;
}

/**
 * Tên tiếng Anh đưa cho model quyết định: chủ đề thư viện dùng tên soạn sẵn (`TOPIC_NAMES_EN`,
 * đúng tên đã đo); chủ đề tự thêm dùng phần "Tên:" của câu mô tả, không có thì nhãn.
 */
export function topicNameEn(t: { key: string | null; label: string; embedText: string }) {
  return (t.key ? TOPIC_NAMES_EN[t.key] : undefined) ?? englishName(t.embedText, t.label);
}

const keyOf = (t: TopicRow) => `topic_${t.id}`;

/**
 * Mỗi chủ đề có sẵn một câu `choice`, chung một trạng thái: chủ đề mới và các chủ đề có sẵn theo
 * khoá câu hỏi (`existing_topics.topic_<id>`). Quá `MAX_QUESTIONS_PER_CALL` chủ đề thì chia lô,
 * các lô gọi song song. Lô nào lỗi thì `null` (lỗi đã ghi vào `llm_calls`): soát nửa vời dễ bỏ
 * sót, nên coi như chưa soát.
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
