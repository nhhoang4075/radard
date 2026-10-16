/**
 * Gợi ý chủ đề từ lời mô tả của người đọc (docs/mo-hinh-quyet-dinh.html tab "Gợi ý chủ đề"). Chỉ
 * đọc DB; các lời gọi model ghi `llm_calls`.
 *
 * Hai phần, chạy độc lập:
 * 1. Chấm thư viện: một lời gọi model ra quyết định, mỗi chủ đề thư viện đang dùng một câu có/không
 *    ("người đọc này có muốn nhận tin về chủ đề X không?"), chia ba mức theo xác suất.
 * 2. Chủ đề mới: một lời gọi LLM đề xuất 0–3 chủ đề thư viện chưa có (model ra quyết định không làm
 *    được việc này, vì nó chỉ chọn trong danh sách cho trước). Mỗi đề xuất qua bước soát chủ đề gần
 *    giống (`checkTopicOverlap`): trùng hẳn một chủ đề có sẵn thì bỏ, hẹp hơn/rộng hơn thì giữ kèm
 *    quan hệ để giao diện hiện cho người dùng.
 */
import {
  createLogger,
  type DecisionProvider,
  type EmbeddingProvider,
  type LlmProvider,
  nfc,
} from "@radard/core";
import { type Database, topics } from "@radard/db";
import { and, asc, eq } from "drizzle-orm";
import { checkTopicOverlap, type OverlapCandidate, topicNameEn } from "./topic-overlap.ts";

const log = createLogger("topic-suggest");

// Ngưỡng chia mức, TẠM: đo 13/10/2026 trên lời mô tả thật của người dùng, Jev cho 15/17 chủ đề
// 0,69–0,95 và 2 chủ đề ít liên quan nhất 0,45–0,50. Sẽ chỉnh lại sau khi người dùng chấm gợi ý
// cho các lời mô tả mẫu (tab "Gợi ý chủ đề", bước đánh giá).

/** Từ ngưỡng này trở lên: tích sẵn. */
export const PRESELECT_MIN = 0.85;
/** Từ ngưỡng này tới dưới `PRESELECT_MIN`: "có thể bạn quan tâm" (chưa tích). Dưới nữa: không gợi ý. */
export const MAYBE_MIN = 0.6;
/** Số chủ đề mới tối đa LLM được đề xuất. */
export const MAX_NEW_TOPICS = 3;

/** Câu hỏi có/không cho một chủ đề, sát câu chữ đã đo ngày 13/10/2026. */
export function suggestInstructions(name: string, descriptionEn: string): string {
  return `Would this reader want news about "${name}" in a daily AI news digest? Topic: ${descriptionEn}`;
}

export interface TopicSuggestion {
  topicId: number;
  key: string;
  label: string;
  /** Xác suất model cho câu trả lời "có". */
  probability: number;
}

export interface NewTopicSuggestion {
  labelVi: string;
  /** Câu mô tả tiếng Anh để embed, cùng dạng `describeTopic` viết. */
  descriptionEn: string;
  /** Vì sao đề xuất, một câu tiếng Việt. */
  why: string;
  /** `false`: chưa soát chủ đề gần giống (thiếu embedder hay model quyết định, hoặc lời gọi lỗi). */
  overlapChecked: boolean;
  /** Chủ đề có sẵn mà đề xuất hẹp hơn hoặc rộng hơn (không có "trùng": đề xuất trùng đã bị bỏ). */
  related: OverlapCandidate[];
}

export interface DroppedTopic {
  labelVi: string;
  descriptionEn: string;
  /** Chủ đề có sẵn bị trùng. */
  sameAs: { topicId: number; label: string; probability: number };
}

export interface SuggestResult {
  /** Phần nào đã chạy: thiếu model quyết định (hoặc lời gọi lỗi) thì không chấm thư viện; thiếu LLM thì không đề xuất chủ đề mới. */
  ran: { library: boolean; newTopics: boolean };
  /** Xác suất ≥ `PRESELECT_MIN`, cao trước. */
  preselect: TopicSuggestion[];
  /** `MAYBE_MIN` ≤ xác suất < `PRESELECT_MIN`, cao trước. */
  maybe: TopicSuggestion[];
  /** Xác suất < `MAYBE_MIN`, cao trước. */
  notSuggested: TopicSuggestion[];
  newTopics: NewTopicSuggestion[];
  /** Đề xuất bị bỏ vì trùng một chủ đề có sẵn (để đánh giá, không hiện cho người dùng). */
  dropped: DroppedTopic[];
  /** Lỗi của từng phần, nếu có. */
  errors: { library?: string; newTopics?: string };
}

export interface SuggestDeps {
  db: Database;
  decider: DecisionProvider | null;
  llm: LlmProvider | null;
  /** Cần cho bước soát chủ đề gần giống; thiếu thì đề xuất mới giữ nguyên, `overlapChecked = false`. */
  embedder: EmbeddingProvider | null;
}

interface LibraryTopic {
  id: number;
  key: string;
  label: string;
  descriptionEn: string;
}

/** Chủ đề thư viện đang dùng (không gồm chủ đề đã rút), theo thứ tự hiển thị. */
async function activeLibrary(db: Database): Promise<LibraryTopic[]> {
  const rows = await db
    .select({
      id: topics.id,
      key: topics.key,
      label: topics.labelVi,
      descriptionEn: topics.descriptionEn,
    })
    .from(topics)
    .where(and(eq(topics.origin, "library"), eq(topics.active, true)))
    .orderBy(asc(topics.position), asc(topics.id));
  return rows.map((r) => ({ ...r, key: r.key ?? "" }));
}

/** Gợi ý chủ đề cho lời mô tả `description` (lời người đọc tự viết về mình). */
export async function suggestTopics(
  deps: SuggestDeps,
  description: string,
): Promise<SuggestResult> {
  const text = nfc(description).trim();
  if (text.length === 0) throw new Error("lời mô tả trống");
  const library = await activeLibrary(deps.db);
  const [rated, proposed] = await Promise.all([
    rateLibrary(deps.decider, text, library),
    proposeNewTopics(deps.llm, text, library),
  ]);
  const checked = await checkProposals(deps, proposed.topics);
  const errors: SuggestResult["errors"] = {};
  if (rated.error) errors.library = rated.error;
  if (proposed.error) errors.newTopics = proposed.error;
  return {
    ran: { library: rated.ran, newTopics: proposed.ran },
    ...tier(rated.suggestions),
    newTopics: checked.kept,
    dropped: checked.dropped,
    errors,
  };
}

/** Chia ba mức theo xác suất, cao trước trong mỗi mức. */
export function tier(
  suggestions: TopicSuggestion[],
): Pick<SuggestResult, "preselect" | "maybe" | "notSuggested"> {
  const sorted = [...suggestions].sort((a, b) => b.probability - a.probability);
  return {
    preselect: sorted.filter((s) => s.probability >= PRESELECT_MIN),
    maybe: sorted.filter((s) => s.probability >= MAYBE_MIN && s.probability < PRESELECT_MIN),
    notSuggested: sorted.filter((s) => s.probability < MAYBE_MIN),
  };
}

const keyOf = (t: LibraryTopic) => `topic_${t.id}`;

/**
 * Một lời gọi cho mọi chủ đề thư viện (thư viện ~14–17 chủ đề, dưới xa giới hạn 32k token của Jev).
 * Hồ sơ lưu bằng tiếng Anh nên trạng thái đưa nguyên văn; tên chủ đề cũng tiếng Anh, cùng bộ tên đã đo mà
 * cổng chủ đề và kiểm trùng dùng (`topicNameEn`).
 */
async function rateLibrary(
  decider: DecisionProvider | null,
  description: string,
  library: LibraryTopic[],
): Promise<{ ran: boolean; suggestions: TopicSuggestion[]; error?: string }> {
  if (!decider) return { ran: false, suggestions: [] };
  if (library.length === 0) return { ran: true, suggestions: [] };
  const questions = Object.fromEntries(
    library.map((t) => [
      keyOf(t),
      {
        type: "boolean" as const,
        instructions: suggestInstructions(topicNameEn(t), t.descriptionEn),
      },
    ]),
  );
  try {
    const res = await decider.decide({
      task: "suggest_topics",
      state: { reader: description },
      questions,
    });
    const suggestions = library.map((t) => ({
      topicId: t.id,
      key: t.key,
      label: t.label,
      probability: res.answers[keyOf(t)]?.probability ?? 0,
    }));
    return { ran: true, suggestions };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn("chấm thư viện lỗi", { error: error.slice(0, 300) });
    return { ran: false, suggestions: [], error: error.slice(0, 500) };
  }
}

const PROPOSE_SYSTEM = `You help a reader of a daily AI/ML news digest choose news topics.
You get the reader's description of themselves and the topic library the digest already offers.
Propose 0 to ${MAX_NEW_TOPICS} NEW topics that this reader clearly wants and that NO library topic already covers, not even as a part of a broader topic.
Most readers are fully covered by the library: then reply with an empty array [].
Do not propose a topic that only renames, merges or slightly narrows a library topic.
Reply with a JSON array only, no other text. Each element:
{"labelVi": short Vietnamese topic name (2 to 6 words, same style as the library names),
 "descriptionEn": "<short English topic name>: <comma-separated concrete subtopics, techniques, products or organisations>", 15 to 45 words in English, naming concrete things; avoid vague words that match almost every AI headline such as "AI models", "LLMs" or "AI news",
 "why": one short Vietnamese sentence saying which part of the reader's description this topic serves}`;

/** Lời nhắc: lời mô tả rồi thư viện, mỗi chủ đề một dòng "tên tiếng Việt | câu mô tả tiếng Anh". */
export function proposePrompt(
  description: string,
  library: { label: string; descriptionEn: string }[],
): string {
  const lines = library.map((t) => `- ${t.label} | ${t.descriptionEn}`);
  return `Reader's description:\n${description}\n\nTopic library (Vietnamese name | English description):\n${lines.join("\n")}`;
}

export interface ProposedTopic {
  labelVi: string;
  descriptionEn: string;
  why: string;
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * Đọc mảng JSON trong câu trả lời (chịu được khối ```json bao quanh và chữ thừa hai đầu). Không
 * thấy mảng hay JSON hỏng thì lỗi (để thử lại); mục thiếu trường hay sai độ dài thì bỏ riêng mục đó.
 * Câu mô tả cho rộng hơn khung 15–45 từ một chút (10–60) để không bỏ đề xuất tốt chỉ vì lệch vài từ.
 */
export function parseProposals(reply: string): ProposedTopic[] {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("không thấy mảng JSON trong câu trả lời");
  const data = JSON.parse(reply.slice(start, end + 1)) as unknown;
  if (!Array.isArray(data)) throw new Error("câu trả lời không phải mảng");
  const out: ProposedTopic[] = [];
  for (const it of data as Record<string, unknown>[]) {
    if (!it || typeof it !== "object") continue;
    const { labelVi, descriptionEn, why } = it;
    if (typeof labelVi !== "string" || typeof descriptionEn !== "string" || typeof why !== "string")
      continue;
    const p = {
      labelVi: nfc(labelVi).trim(),
      descriptionEn: nfc(descriptionEn).trim(),
      why: nfc(why).trim(),
    };
    const words = wordCount(p.descriptionEn);
    if (p.labelVi.length < 2 || p.labelVi.length > 60) continue;
    if (words < 10 || words > 60 || !p.descriptionEn.includes(":")) continue;
    if (p.why.length === 0) continue;
    out.push(p);
  }
  return out.slice(0, MAX_NEW_TOPICS);
}

/** Một lời gọi LLM, thử lại đúng một lần khi câu trả lời không đọc được (như tóm tắt digest). */
async function proposeNewTopics(
  llm: LlmProvider | null,
  description: string,
  library: LibraryTopic[],
): Promise<{ ran: boolean; topics: ProposedTopic[]; error?: string }> {
  if (!llm) return { ran: false, topics: [] };
  const prompt = proposePrompt(description, library);
  let error = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const reply = await llm.generateText({
        task: "suggest_new_topics",
        system: PROPOSE_SYSTEM,
        prompt,
        // Model có token suy nghĩ ẩn tính vào trần này (đo 11/10/2026): để rộng.
        maxOutputTokens: 3000,
      });
      // Tên trùng chủ đề thư viện thì không lưu được (`addCustomTopic`): bỏ luôn.
      const labels = new Set(library.map((t) => t.label.toLowerCase()));
      const topics = parseProposals(reply).filter((p) => !labels.has(p.labelVi.toLowerCase()));
      return { ran: true, topics };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      log.warn("đề xuất chủ đề mới hỏng", { attempt, error: error.slice(0, 300) });
    }
  }
  return { ran: false, topics: [], error: error.slice(0, 500) };
}

/** Soát từng đề xuất (song song): trùng một chủ đề có sẵn thì bỏ, còn lại giữ kèm quan hệ. */
async function checkProposals(
  deps: SuggestDeps,
  proposed: ProposedTopic[],
): Promise<{ kept: NewTopicSuggestion[]; dropped: DroppedTopic[] }> {
  const { embedder, decider } = deps;
  const results = await Promise.all(
    proposed.map(async (p) => {
      if (!embedder || !decider) return { p, ran: false, candidates: [] as OverlapCandidate[] };
      try {
        const res = await checkTopicOverlap(
          { db: deps.db, embedder, decider },
          { label: p.labelVi, descriptionEn: p.descriptionEn },
        );
        return { p, ran: res.ran, candidates: res.candidates };
      } catch (err) {
        log.warn("soát đề xuất lỗi", { error: String(err).slice(0, 300) });
        return { p, ran: false, candidates: [] as OverlapCandidate[] };
      }
    }),
  );
  const kept: NewTopicSuggestion[] = [];
  const dropped: DroppedTopic[] = [];
  for (const { p, ran, candidates } of results) {
    // Ứng viên đã xếp "trùng" trước, chắc hơn trước.
    const same = candidates.find((c) => c.relation === "same");
    if (same) {
      dropped.push({
        labelVi: p.labelVi,
        descriptionEn: p.descriptionEn,
        sameAs: { topicId: same.topicId, label: same.label, probability: same.probability },
      });
      continue;
    }
    kept.push({ ...p, overlapChecked: ran, related: candidates });
  }
  return { kept, dropped };
}
