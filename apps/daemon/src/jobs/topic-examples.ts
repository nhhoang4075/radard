/**
 * Tin giả định cho chủ đề (HyDE, Gao và cộng sự 2022): mỗi chủ đề được thêm vài tin ngắn do LLM
 * viết như tin thật, embed như một tài liệu. Một câu mô tả trừu tượng nằm xa tiêu đề cụ thể của
 * tin thật; các tin giả định thì cùng kiểu câu và cùng từ khoá. Điểm R của tin với chủ đề là cosine
 * lớn nhất trong vector mô tả và các vector này (`scoreTopics`).
 *
 * Làm một lần cho mỗi chủ đề (không làm cho từng tin), không có LLM hay lời gọi lỗi thì chủ đề giữ
 * nguyên cách chấm bằng mô tả, và lượt sau thử lại. Đây là thay đổi cách tính R (đề xuất C trong
 * docs/mo-hinh-de-xuat.html, chủ nhân duyệt 10/11/2026).
 */
import { createLogger, type EmbeddingProvider, type LlmProvider } from "@radard/core";
import { type Database, docTopicScores, profileTopics, topicExamples, topics } from "@radard/db";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";

const log = createLogger("topic-examples");

/** Số tin giả định mỗi chủ đề (đề xuất 3–5). */
export const EXAMPLES_PER_TOPIC = 4;
const MIN_WORDS = 4;
const MAX_WORDS = 30;
/** Ít hơn số này thì coi như chưa có; từ số này trở lên là đủ dùng. */
export const MIN_EXAMPLES = 3;
/** Chủ đề vừa lỗi thì chờ chừng này mới thử lại, để không đốt tiền LLM mỗi lượt process. */
const RETRY_AFTER_MS = 3_600_000;
const lastFailure = new Map<number, number>();

/** Cho test: xoá nhớ lần lỗi để thử lại ngay. */
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

/** Đọc mảng JSON các chuỗi; bỏ mục sai độ dài và trùng. Không thấy mảng thì lỗi (để thử lại). */
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
 * Sinh tin giả định cho mọi chủ đề đã có vector mà chưa đủ tin của model hiện tại. Trả về số chủ đề
 * vừa được thêm. Lỗi của một chủ đề không làm hỏng chủ đề khác.
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
        // Cách chấm của chủ đề đổi: điểm cũ (chỉ theo mô tả) không còn đúng, tính lại.
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

/** Một lời gọi LLM, thử lại đúng một lần khi câu trả lời không đọc được hoặc quá ít tin. */
async function writeExamples(llm: LlmProvider, name: string, embedText: string): Promise<string[]> {
  let error = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const reply = await llm.generateText({
        task: "topic_examples",
        system: EXAMPLES_SYSTEM,
        prompt: examplesPrompt(name, embedText),
        // Model có token suy nghĩ ẩn tính vào trần này: để rộng.
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
