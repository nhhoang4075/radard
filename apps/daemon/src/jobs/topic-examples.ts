/**
 * Hypothetical items for a topic (HyDE, Gao et al. 2022): each topic gets a few short items written by the LLM
 * as if they were real news, embedded like a document. An abstract description sits far from the specific headlines of
 * real items; hypothetical items share the same sentence style and keywords. The R score of an item for a topic is the max
 * cosine between the item vector and these vectors (`scoreTopics`).
 *
 * Done once per topic (not per item). With no LLM or on a failed call, the topic keeps
 * its description-based scoring, and the next run retries. This changes how R is computed (proposal C in
 * docs/mo-hinh-de-xuat.html, approved by the owner 10/11/2026).
 */
import { createLogger, type EmbeddingProvider, type LlmProvider } from "@radard/core";
import { type Database, docTopicScores, profileTopics, topicExamples, topics } from "@radard/db";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";

const log = createLogger("topic-examples");

/** Number of hypothetical items per topic (proposal 3–5). */
export const EXAMPLES_PER_TOPIC = 4;
const MIN_WORDS = 4;
const MAX_WORDS = 30;
/** Fewer than this many means not ready yet; at or above this it is enough to use. */
export const MIN_EXAMPLES = 3;
/** A topic that just failed waits this long before retrying, so no LLM money is wasted on every process run. */
const RETRY_AFTER_MS = 3_600_000;
const lastFailure = new Map<number, number>();

/** For tests: clears the failure memory so it retries immediately. */
export function resetExampleBackoff(): void {
  lastFailure.clear();
}

export const EXAMPLES_SYSTEM = `You write short, realistic news items for a daily AI/ML news digest, to help match real news to a topic.
You get a topic name and its English description.
Write exactly ${EXAMPLES_PER_TOPIC} DIFFERENT items that a reader of this topic would want. Each one looks like a real headline as seen on Hacker News, arXiv or a GitHub release page: concrete product, project or technique names, a specific claim or number, 8 to 20 words.
Cover different subtopics of the description, not four rewordings of one idea. Do not copy the description's wording.
Reply with a JSON array of ${EXAMPLES_PER_TOPIC} strings only, no other text.`;

export function examplesPrompt(name: string, embedText: string): string {
  return `Topic: ${name}\nDescription: ${embedText}`;
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Reads a JSON array of strings; drops items of the wrong length and duplicates. Without an array, throws an error (to retry). */
export function parseExamples(reply: string): string[] {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("không thấy mảng JSON trong câu trả lời");
  const data = JSON.parse(reply.slice(start, end + 1)) as unknown;
  if (!Array.isArray(data)) throw new Error("câu trả lời không phải mảng");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of data) {
    if (typeof it !== "string") continue;
    const t = it.normalize("NFC").trim();
    const w = wordCount(t);
    if (w < MIN_WORDS || w > MAX_WORDS || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, EXAMPLES_PER_TOPIC);
}

/**
 * Generates hypothetical items for every topic that has a vector but not yet enough items from the current model. Returns the number
 * just added. An error on one topic does not break other topics.
 */
export async function ensureTopicExamples(
  db: Database,
  llm: LlmProvider | null,
  embedder: EmbeddingProvider,
): Promise<number> {
  if (!llm) return 0;
  const picked = db.select({ id: profileTopics.topicId }).from(profileTopics);
  const candidates = await db
    .select({ id: topics.id, name: topics.name, embedText: topics.embedText })
    .from(topics)
    .where(
      and(
        isNotNull(topics.embedding),
        eq(topics.embeddingModel, embedder.model),
        or(and(eq(topics.origin, "library"), eq(topics.active, true)), inArray(topics.id, picked)),
      ),
    );
  if (candidates.length === 0) return 0;
  const have = await db
    .select({ topicId: topicExamples.topicId, n: sql<number>`count(*)::int` })
    .from(topicExamples)
    .where(eq(topicExamples.embeddingModel, embedder.model))
    .groupBy(topicExamples.topicId);
  const done = new Set(have.filter((h) => h.n >= MIN_EXAMPLES).map((h) => h.topicId));
  let added = 0;
  const now = Date.now();
  const todo = candidates.filter(
    (c) => !done.has(c.id) && now - (lastFailure.get(c.id) ?? 0) >= RETRY_AFTER_MS,
  );
  for (const t of todo) {
    try {
      const texts = await writeExamples(llm, t.name, t.embedText);
      const vectors = await embedder.embed(texts, "embed_topic_examples");
      if (vectors.length !== texts.length) throw new Error("embedder trả thiếu vector");
      await db.transaction(async (tx) => {
        await tx.delete(topicExamples).where(eq(topicExamples.topicId, t.id));
        await tx.insert(topicExamples).values(
          texts.map((text, i) => ({
            topicId: t.id,
            position: i,
            text,
            embedding: vectors[i] as number[],
            embeddingModel: embedder.model,
          })),
        );
        // The topic's scoring changed: old scores (description-only) are no longer valid, so recompute.
        await tx.delete(docTopicScores).where(eq(docTopicScores.topicId, t.id));
      });
      lastFailure.delete(t.id);
      added++;
    } catch (err) {
      lastFailure.set(t.id, now);
      log.warn("không sinh được tin giả định cho chủ đề", {
        topicId: t.id,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
    }
  }
  if (added > 0) log.info("đã thêm tin giả định cho chủ đề", { n: added });
  return added;
}

/** One LLM call, retried exactly once when the answer cannot be read or has too few items. */
async function writeExamples(llm: LlmProvider, name: string, embedText: string): Promise<string[]> {
  let error = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const reply = await llm.generateText({
        task: "topic_examples",
        system: EXAMPLES_SYSTEM,
        prompt: examplesPrompt(name, embedText),
        // The model has hidden thinking tokens that count toward this cap: keep it generous.
        maxOutputTokens: 3000,
      });
      const texts = parseExamples(reply);
      if (texts.length >= MIN_EXAMPLES) return texts;
      error = `chỉ đọc được ${texts.length} tin`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(error);
}
