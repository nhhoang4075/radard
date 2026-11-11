/**
 * Topic suggestions from the reader's description (docs/mo-hinh-quyet-dinh.html tab "Topic suggestions"). Reads
 * the DB only; the model calls write `llm_calls`.
 *
 * Two parts, run independently:
 * 1. Library scoring: one decision-model call, with a yes/no question for each library topic in use
 *    ("is this reader interested in news about topic X?"), split into three levels by probability.
 * 2. New topics: one LLM call proposes 0–3 library topics not yet present (the decision model cannot do this,
 *    since it only chooses from a given list). Each proposal goes through the near-duplicate check
 *    (`checkTopicOverlap`): a proposal that fully duplicates an existing topic is dropped; narrower or broader ones are kept with
 *    their relation so the UI can show it to the user.
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

// Level thresholds, tuned 16/10/2026 against 69 pairs the user scored (5 descriptions × 14 topics): with
// 0,85 / 0,58, 63/69 pairs matched the level the user chose and 0 serious errors (ticked what the user did not want,
// or did not suggest what the user wanted to turn on). Old thresholds 0,85 / 0,60: 62/69 and 1 serious error.

/** At or above this threshold: pre-ticked. */
export const PRESELECT_MIN = 0.85;
/** From this threshold up to below `PRESELECT_MIN`: "you may be interested" (not ticked). Below that: not suggested. */
export const MAYBE_MIN = 0.58;
/** Maximum number of new topics the LLM may propose. */
export const MAX_NEW_TOPICS = 3;

/** Yes/no question for one topic, close to the wording measured on 13/10/2026. */
export function suggestInstructions(name: string, embedText: string): string {
  return `Would this reader want news about "${name}" in a daily AI news digest? Topic: ${embedText}`;
}

export interface TopicSuggestion {
  topicId: number;
  key: string;
  label: string;
  /** The model's probability for the answer "yes". */
  probability: number;
}

export interface NewTopicSuggestion {
  name: string;
  /** English description sentence to embed, in the same form as `describeTopic` writes. */
  embedText: string;
  /** Why it is proposed, one Vietnamese sentence. */
  why: string;
  /** `false`: near-duplicate check not done yet (missing embedder or decision model, or the call failed). */
  overlapChecked: boolean;
  /** Always empty once checked: proposals with a relation to an existing topic are all dropped (see `DroppedTopic`). */
  related: OverlapCandidate[];
}

export interface DroppedTopic {
  name: string;
  embedText: string;
  /** Existing topic that the proposal duplicates, is narrower than, or is broader than (the most confident relation). */
  relatedTo: {
    topicId: number;
    label: string;
    relation: OverlapCandidate["relation"];
    probability: number;
  };
}

export interface SuggestResult {
  /** Which parts ran: without the decision model (or on a failed call) library topics are not scored; without an LLM no new topics are proposed. */
  ran: { library: boolean; newTopics: boolean };
  /** Probability ≥ `PRESELECT_MIN`, highest first. */
  preselect: TopicSuggestion[];
  /** `MAYBE_MIN` ≤ probability < `PRESELECT_MIN`, highest first. */
  maybe: TopicSuggestion[];
  /** Probability < `MAYBE_MIN`, highest first. */
  notSuggested: TopicSuggestion[];
  newTopics: NewTopicSuggestion[];
  /** Proposal dropped for duplicating an existing topic (for evaluation, not shown to the user). */
  dropped: DroppedTopic[];
  /** Error of each part, if any. */
  errors: { library?: string; newTopics?: string };
}

export interface SuggestDeps {
  db: Database;
  profileId: number;
  decider: DecisionProvider | null;
  llm: LlmProvider | null;
  /** Needed for the near-duplicate check; without it the new proposals are kept as is, `overlapChecked = false`. */
  embedder: EmbeddingProvider | null;
}

interface LibraryTopic {
  id: number;
  key: string;
  label: string;
  embedText: string;
}

/** Library topics in use (excluding withdrawn topics), in display order. */
async function activeLibrary(db: Database): Promise<LibraryTopic[]> {
  const rows = await db
    .select({
      id: topics.id,
      key: topics.key,
      label: topics.name,
      embedText: topics.embedText,
    })
    .from(topics)
    .where(and(eq(topics.origin, "library"), eq(topics.active, true)))
    .orderBy(asc(topics.position), asc(topics.id));
  return rows.map((r) => ({ ...r, key: r.key ?? "" }));
}

/** Topic suggestions for the description `description` (the reader's own wording about themselves). */
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

/** Splits into three levels by probability, highest first within each level. */
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
 * One call for all library topics (the library has ~14–17 topics, far below Jev's 32k token limit).
 * The profile is stored in English so the state carries it as is; topic names are in English too, the same set of names measured that
 * the topic gate and the duplicate check use (`topicNameEn`).
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
        instructions: suggestInstructions(topicNameEn(t), t.embedText),
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

/** Prompt: the description, then the library, one topic per line as "Vietnamese name | English description sentence". */
export function proposePrompt(
  description: string,
  library: { label: string; embedText: string }[],
): string {
  const lines = library.map((t) => `- ${t.label} | ${t.embedText}`);
  return `Reader's description:\n${description}\n\nTopic library (Vietnamese name | English description):\n${lines.join("\n")}`;
}

export interface ProposedTopic {
  name: string;
  embedText: string;
  why: string;
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * Reads the JSON array in the answer (tolerates a surrounding ```json block and extra text at both ends). Without
 * an array, or with broken JSON, it throws an error (to retry); items missing a field or with the wrong length are dropped individually.
 * Description sentences may be a little wider than the 15–45 word range (10–60), so good proposals are not dropped over a few words.
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
    // The keys on the wire keep their old names (`labelVi`, `descriptionEn`): they are the contract with the LLM prompt.
    const { labelVi, descriptionEn, why } = it;
    if (typeof labelVi !== "string" || typeof descriptionEn !== "string" || typeof why !== "string")
      continue;
    const p = {
      name: nfc(labelVi).trim(),
      embedText: nfc(descriptionEn).trim(),
      why: nfc(why).trim(),
    };
    const words = wordCount(p.embedText);
    if (p.name.length < 2 || p.name.length > 60) continue;
    if (words < 10 || words > 60 || !p.embedText.includes(":")) continue;
    if (p.why.length === 0) continue;
    out.push(p);
  }
  return out.slice(0, MAX_NEW_TOPICS);
}

/** One LLM call, retried exactly once when the answer cannot be read (as with the digest summary). */
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
        // The model has hidden thinking tokens counted toward this cap (measured 11/10/2026): keep it generous.
        maxOutputTokens: 3000,
      });
      // A name that clashes with a library topic cannot be saved (`addCustomTopic`): drop it.
      const labels = new Set(library.map((t) => t.label.toLowerCase()));
      const topics = parseProposals(reply).filter((p) => !labels.has(p.name.toLowerCase()));
      return { ran: true, topics };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      log.warn("đề xuất chủ đề mới hỏng", { attempt, error: error.slice(0, 300) });
    }
  }
  return { ran: false, topics: [], error: error.slice(0, 500) };
}

/** Checks each proposal (in parallel): a duplicate of an existing topic is dropped, the rest are kept with their relation. */
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
          { db: deps.db, profileId: deps.profileId, embedder, decider },
          { label: p.name, embedText: p.embedText },
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
    // Keep only proposals different from every existing topic: on 16/10/2026 the user found exactly 2 "all different" proposals
    // useful and did not want 2 "narrower" ones (0,55 and 0,95). New topics are there to fill gaps in the library.
    // Candidates ranked duplicate > narrower > broader, more confident first.
    const top = candidates[0];
    if (top) {
      dropped.push({
        name: p.name,
        embedText: p.embedText,
        relatedTo: {
          topicId: top.topicId,
          label: top.label,
          relation: top.relation,
          probability: top.probability,
        },
      });
      continue;
    }
    kept.push({ ...p, overlapChecked: ran, related: candidates });
  }
  return { kept, dropped };
}
