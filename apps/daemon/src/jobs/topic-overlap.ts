/**
 * Soát chủ đề gần giống, chạy TRƯỚC khi lưu một chủ đề tự thêm (docs/mo-hinh-quyet-dinh.html tab
 * 02 và 06). Chỉ đọc DB; lời gọi model duy nhất ghi `llm_calls` (embed câu mô tả, hỏi quan hệ).
 *
 * So hai câu mô tả bằng cosine không dùng được (câu nào cũng nói về AI: hai chủ đề khác hẳn vẫn
 * 0,84, hai chủ đề trùng thật chỉ 0,79). Nên đo điều người dùng thật sự quan tâm: hai chủ đề bắt
 * chung bao nhiêu tin. "Tỉ lệ trùng tin" = số tin chung trong 300 tin khớp nhất của mỗi bên (30
 * ngày qua) chia 300. Con số đó không nói quan hệ gì (hẹp hơn vẫn có thể trùng 70%), nên khi đủ
 * cao thì hỏi model ra quyết định: trùng, hẹp hơn, rộng hơn hay khác.
 */
import type { DecisionProvider, EmbeddingProvider } from "@radard/core";
import type { Database } from "@radard/db";
import { sql } from "drizzle-orm";
import { PROFILE_ID } from "./topics.ts";

/** Số tin khớp nhất của mỗi chủ đề đem ra so (tab 02: 300 tin của 30 ngày). */
export const OVERLAP_TOP_N = 300;
export const OVERLAP_WINDOW_DAYS = 30;

/**
 * Từ tỉ lệ này trở lên thì HỎI model quan hệ là gì; dưới mức này hai chủ đề rõ ràng khác nhau.
 * Không phải ngưỡng "trùng": hai chủ đề thư viện được soạn để tách riêng vẫn trùng ~0,3–0,37 tin
 * (và "Model mới ra" với "Model mã nguồn mở" từng 0,48), nên con số chỉ quyết định có hỏi không.
 */
export const OVERLAP_ASK_RATIO = 0.3;
/** Tối đa bao nhiêu chủ đề gần nhất được báo (và hỏi model) cho một chủ đề mới. */
export const OVERLAP_MAX_CANDIDATES = 3;
const EXAMPLES = 3;

/** Bốn quan hệ, đúng câu chữ đã thử trên 6 model ngày 13/10/2026 (tab 05). */
export const RELATION_CRITERIA = {
  same: "The new topic covers essentially the same news as the existing topic",
  narrower: "The new topic is a narrower part of the existing topic",
  broader: "The new topic is broader than the existing topic and includes it",
  different: "The topics are about different news, with only small overlap",
} as const;
export type TopicRelation = keyof typeof RELATION_CRITERIA;

const RELATION_INSTRUCTIONS =
  "How does the new topic relate to the existing topic, in terms of which news articles each would match?";

export interface TopicDraft {
  label: string;
  /** Câu mô tả tiếng Anh dùng để embed (cùng dạng `describeTopic` viết). */
  descriptionEn: string;
}

export interface OverlapCandidate {
  topicId: number;
  label: string;
  origin: "library" | "custom";
  /** Người dùng đã chọn và đang bật chủ đề này. */
  enabled: boolean;
  /** Tỉ lệ trùng tin, 0..1. */
  ratio: number;
  /** `null` khi không có model quyết định (chưa có khoá) hoặc lời gọi lỗi. */
  relation: TopicRelation | null;
  /** Xác suất model cho quan hệ đã chọn. */
  probability: number | null;
  /** Tiêu đề tin cả hai cùng bắt, khớp chủ đề mới nhất trước. */
  shared: string[];
  /** Tiêu đề tin chỉ chủ đề mới bắt, khớp chủ đề mới nhất trước. */
  onlyNew: string[];
}

export interface OverlapCheck {
  candidates: OverlapCandidate[];
  /** Số tin trong tập so của chủ đề mới (bằng `OVERLAP_TOP_N` khi đủ dữ liệu). */
  docs: number;
  /** Model đã trả lời quan hệ; `null` khi không hỏi. */
  model: string | null;
}

interface NewDoc {
  id: number;
  title: string;
}

type TopicRow = {
  id: number;
  label: string;
  origin: "library" | "custom";
  descriptionEn: string;
  enabled: boolean;
  /** Đã có điểm trong `doc_topic_scores`. */
  scored: boolean;
};

export interface OverlapDeps {
  db: Database;
  embedder: EmbeddingProvider;
  decider: DecisionProvider | null;
}

/**
 * Đo tỉ lệ trùng tin của bản nháp với mọi chủ đề có embedding (thư viện đang dùng và chủ đề tự
 * thêm của hồ sơ, bật hay tắt), giữ tối đa 3 chủ đề từ `OVERLAP_ASK_RATIO` trở lên, rồi hỏi quan hệ
 * trong một lời gọi model quyết định. Không ghi gì ngoài `llm_calls`.
 */
export async function checkTopicOverlap(
  deps: OverlapDeps,
  draft: TopicDraft,
  opts: { topN?: number; now?: Date } = {},
): Promise<OverlapCheck> {
  const topN = opts.topN ?? OVERLAP_TOP_N;
  const since = new Date((opts.now ?? new Date()).getTime() - OVERLAP_WINDOW_DAYS * 86_400_000);
  const model = deps.embedder.model;
  const [vector] = await deps.embedder.embed([draft.descriptionEn], "embed_topic_draft");
  if (!vector) throw new Error("embedder không trả vector");

  const newTop = await topDocsForVector(deps.db, vector, model, since, topN);
  if (newTop.length === 0) return { candidates: [], docs: 0, model: null };
  const ids = newTop.map((d) => d.id);
  const topics = await existingTopics(deps.db, model);
  const sharedByTopic = await sharedDocs(deps.db, topics, ids, since, topN);

  const candidates = topics
    .map((t) => ({ t, shared: sharedByTopic.get(t.id) ?? new Set<number>() }))
    .map((x) => ({ ...x, ratio: x.shared.size / newTop.length }))
    .filter((x) => x.ratio >= OVERLAP_ASK_RATIO)
    .sort((a, b) => b.ratio - a.ratio || a.t.id - b.t.id)
    .slice(0, OVERLAP_MAX_CANDIDATES)
    .map(({ t, shared, ratio }) => toCandidate(t, ratio, shared, newTop));
  if (candidates.length === 0 || !deps.decider) {
    return { candidates, docs: newTop.length, model: null };
  }
  const byId = new Map(topics.map((t) => [t.id, t]));
  const asked = await askRelations(deps.decider, draft, candidates, byId);
  return { candidates, docs: newTop.length, model: asked };
}

function toCandidate(
  t: TopicRow,
  ratio: number,
  shared: Set<number>,
  newTop: NewDoc[],
): OverlapCandidate {
  // newTop đã xếp theo độ khớp với chủ đề mới, cao trước.
  const pick = (inShared: boolean) =>
    newTop
      .filter((d) => shared.has(d.id) === inShared)
      .slice(0, EXAMPLES)
      .map((d) => d.title);
  return {
    topicId: t.id,
    label: t.label,
    origin: t.origin,
    enabled: t.enabled,
    ratio,
    relation: null,
    probability: null,
    shared: pick(true),
    onlyNew: pick(false),
  };
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
    select t.id::int as id, t.label_vi as label, t.origin, t.description_en as "descriptionEn",
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
    label: String(r.label),
    origin: r.origin === "custom" ? "custom" : "library",
    descriptionEn: String(r.descriptionEn),
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
  const idArray = sql`${`{${ids.join(",")}}`}::bigint[]`;
  const scored = topics.filter((t) => t.scored).map((t) => t.id);
  const unscored = topics.filter((t) => !t.scored).map((t) => t.id);
  const out = new Map<number, Set<number>>();
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
export function englishName(descriptionEn: string, fallback: string): string {
  const head = descriptionEn.split(":")[0]?.trim() ?? "";
  return head.length > 0 && head.length <= 80 && head !== descriptionEn.trim() ? head : fallback;
}

/**
 * Một lời gọi, mỗi chủ đề gần một câu `choice`. Một chủ đề: trạng thái và câu hỏi đúng như đã thử
 * (tab 05). Nhiều chủ đề thì mọi câu hỏi chung một trạng thái, nên các chủ đề có sẵn nằm trong
 * `existing_topics` theo khoá của câu hỏi, và câu hỏi nêu khoá đó. Ghi kết quả vào `candidates`;
 * lỗi thì để quan hệ trống (vẫn báo tỉ lệ). Trả về id model đã trả lời.
 */
async function askRelations(
  decider: DecisionProvider,
  draft: TopicDraft,
  candidates: OverlapCandidate[],
  topics: Map<number, TopicRow>,
): Promise<string | null> {
  const describe = (t: TopicRow) => ({
    name: englishName(t.descriptionEn, t.label),
    description: t.descriptionEn,
  });
  const newTopic = {
    name: englishName(draft.descriptionEn, draft.label),
    description: draft.descriptionEn,
  };
  const keyOf = (c: OverlapCandidate) => `topic_${c.topicId}`;
  const single = candidates.length === 1;
  const existing = Object.fromEntries(
    candidates.map((c) => [keyOf(c), describe(topics.get(c.topicId) as TopicRow)]),
  );
  const state = single
    ? { new_topic: newTopic, existing_topic: Object.values(existing)[0] }
    : { new_topic: newTopic, existing_topics: existing };
  const questions = Object.fromEntries(
    candidates.map((c) => [
      keyOf(c),
      {
        type: "choice" as const,
        instructions: single
          ? RELATION_INSTRUCTIONS
          : RELATION_INSTRUCTIONS.replace("the existing topic", `the existing topic ${keyOf(c)}`),
        criteria: RELATION_CRITERIA,
      },
    ]),
  );
  try {
    const res = await decider.decide({ task: "topic_overlap", state, questions });
    for (const c of candidates) {
      const a = res.answers[keyOf(c)];
      if (!a) continue;
      c.relation = a.choice as TopicRelation;
      c.probability = a.probabilities[a.choice] ?? null;
    }
    return res.model;
  } catch {
    // Lỗi đã ghi vào llm_calls; vẫn báo tỉ lệ trùng tin, để người dùng tự xem.
    return null;
  }
}
