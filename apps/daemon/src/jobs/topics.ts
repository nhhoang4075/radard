/**
 * Chủ đề của người dùng: chọn từ thư viện, tự thêm, bật tắt, embed.
 *
 * Mọi thao tác đều chạy được nhiều lần mà không sinh bản trùng (chọn lại = bật lại dòng cũ,
 * seed lại = cập nhật thư viện), vì chúng được gọi từ cả CLI lẫn bot Telegram.
 */
import { createLogger, type EmbeddingProvider, type LlmProvider, nfc } from "@radard/core";
import { type Database, docTopicScores, profileTopics, topics } from "@radard/db";
import { and, asc, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { TOPIC_LIBRARY } from "../topics/library.ts";

const log = createLogger("topics");

const PROFILE_ID = 1;

/**
 * Đưa thư viện trong code vào bảng `topics`: thêm chủ đề mới, cập nhật chủ đề đã có theo `key`.
 * Chủ đề người dùng đã chọn từ thư viện nhận câu mô tả mới và được đánh dấu embed lại.
 */
export async function seedLibrary(db: Database): Promise<{ topics: number; refreshed: number }> {
  for (const [position, t] of TOPIC_LIBRARY.entries()) {
    await db
      .insert(topics)
      .values({ ...t, position })
      .onConflictDoUpdate({
        target: topics.key,
        set: {
          groupVi: t.groupVi,
          labelVi: t.labelVi,
          descriptionEn: t.descriptionEn,
          position,
          active: true,
        },
      });
  }
  // Rút khỏi thư viện những chủ đề không còn trong code; người đã chọn vẫn giữ.
  const keys = TOPIC_LIBRARY.map((t) => t.key);
  await db.update(topics).set({ active: false }).where(notInArray(topics.key, keys));

  const refreshed = await db
    .update(profileTopics)
    .set({
      descriptionEn: sql`${topics.descriptionEn}`,
      label: sql`${topics.labelVi}`,
      embedding: null,
      embeddingModel: null,
      updatedAt: new Date(),
    })
    .from(topics)
    .where(
      and(
        eq(profileTopics.topicId, topics.id),
        or(
          ne(profileTopics.descriptionEn, topics.descriptionEn),
          ne(profileTopics.label, topics.labelVi),
        ),
      ),
    )
    .returning({ id: profileTopics.id });
  return { topics: TOPIC_LIBRARY.length, refreshed: refreshed.length };
}

export interface LibraryEntry {
  id: number;
  key: string;
  groupVi: string;
  labelVi: string;
  /** Người dùng đã chọn và đang bật. */
  chosen: boolean;
}

/** Thư viện kèm trạng thái đã chọn, theo thứ tự hiển thị. */
export async function listLibrary(db: Database): Promise<LibraryEntry[]> {
  return db
    .select({
      id: topics.id,
      key: topics.key,
      groupVi: topics.groupVi,
      labelVi: topics.labelVi,
      chosen: sql<boolean>`coalesce(${profileTopics.active}, false)`,
    })
    .from(topics)
    .leftJoin(
      profileTopics,
      and(eq(profileTopics.topicId, topics.id), eq(profileTopics.profileId, PROFILE_ID)),
    )
    .where(eq(topics.active, true))
    .orderBy(asc(topics.position));
}

/** Chọn chủ đề từ thư viện theo `key`. Đã chọn rồi thì bật lại. Trả về số chủ đề được bật. */
export async function pickTopics(db: Database, keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const found = await db
    .select()
    .from(topics)
    .where(and(inArray(topics.key, keys), eq(topics.active, true)));
  const unknown = keys.filter((k) => !found.some((t) => t.key === k));
  if (unknown.length > 0) throw new Error(`không có trong thư viện: ${unknown.join(", ")}`);
  for (const t of found) {
    await db
      .insert(profileTopics)
      .values({
        profileId: PROFILE_ID,
        topicId: t.id,
        label: t.labelVi,
        descriptionEn: t.descriptionEn,
        origin: "library",
      })
      .onConflictDoUpdate({
        target: [profileTopics.profileId, profileTopics.topicId],
        targetWhere: sql`${profileTopics.topicId} is not null`,
        set: { active: true, updatedAt: new Date() },
      });
  }
  return found.length;
}

/** Bật hoặc tắt chủ đề theo id của `profile_topics`. Không xoá: điểm cũ và embedding giữ lại. */
export async function setTopicActive(db: Database, id: number, active: boolean): Promise<boolean> {
  const rows = await db
    .update(profileTopics)
    .set({ active, updatedAt: new Date() })
    .where(and(eq(profileTopics.id, id), eq(profileTopics.profileId, PROFILE_ID)))
    .returning({ id: profileTopics.id });
  return rows.length > 0;
}

/** Bật tắt chủ đề thư viện theo id của `topics` (nút trên Telegram mang id này). */
export async function toggleLibraryTopic(db: Database, topicId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: profileTopics.id, active: profileTopics.active })
    .from(profileTopics)
    .where(and(eq(profileTopics.topicId, topicId), eq(profileTopics.profileId, PROFILE_ID)));
  if (row) {
    await setTopicActive(db, row.id, !row.active);
    return !row.active;
  }
  const [t] = await db.select({ key: topics.key }).from(topics).where(eq(topics.id, topicId));
  if (!t) throw new Error(`không có chủ đề ${topicId} trong thư viện`);
  await pickTopics(db, [t.key]);
  return true;
}

const DESCRIBE_SYSTEM = `You write the search description for one news interest of a reader of an AI/ML news digest.
The description is embedded and compared with news headlines and paper abstracts, so it must name concrete things.
Format: "<short English topic name>: <comma-separated concrete subtopics, techniques, products or organisations>".
Write 15 to 45 words in English, whatever language the reader used.
Use what the reader said and close synonyms only; do not widen the topic.
Avoid vague words that match almost every AI headline, such as "AI models", "LLMs" or "AI news", unless the reader's topic is exactly that.
Reply with the description only, on one line.`;

/** Một lời gọi LLM: lời của người dùng (tiếng Việt hay tiếng Anh) → câu mô tả tiếng Anh để embed. */
export async function describeTopic(
  llm: LlmProvider,
  label: string,
  text: string,
): Promise<string> {
  const reply = await llm.generateText({
    task: "topic_describe",
    system: DESCRIBE_SYSTEM,
    prompt: `Topic name given by the reader: ${label}\nThe reader's own description: ${text}`,
    // Model có token suy nghĩ ẩn tính vào trần này (đo 11/10/2026): để rộng.
    maxOutputTokens: 1500,
  });
  const line = nfc(reply)
    .split("\n")
    .map((l) => l.trim().replace(/^["“]|["”]$/g, ""))
    .find((l) => l.length > 0);
  if (!line || line.length < 20 || line.length > 500) {
    throw new Error(`model trả câu mô tả không dùng được: ${JSON.stringify(reply.slice(0, 200))}`);
  }
  return line;
}

export interface CustomTopicInput {
  label: string;
  descriptionUser: string;
  descriptionEn: string;
  kind?: "include" | "exclude";
}

/** Lưu chủ đề tự thêm. Trùng tên (không phân biệt hoa thường) với chủ đề đã có thì báo lỗi. */
export async function addCustomTopic(db: Database, input: CustomTopicInput): Promise<number> {
  const label = nfc(input.label).trim();
  const [dup] = await db
    .select({ id: profileTopics.id })
    .from(profileTopics)
    .where(
      and(
        eq(profileTopics.profileId, PROFILE_ID),
        sql`lower(${profileTopics.label}) = lower(${label})`,
      ),
    );
  if (dup) throw new Error(`đã có chủ đề tên "${label}" (id ${dup.id})`);
  const [row] = await db
    .insert(profileTopics)
    .values({
      profileId: PROFILE_ID,
      label,
      descriptionUser: nfc(input.descriptionUser).trim(),
      descriptionEn: input.descriptionEn,
      origin: "custom",
      kind: input.kind ?? "include",
    })
    .returning({ id: profileTopics.id });
  if (!row) throw new Error("không ghi được chủ đề");
  return row.id;
}

/**
 * Embed mọi chủ đề đang bật mà chưa có vector của model hiện tại, trong một request.
 * Gọi ở đầu mỗi lượt process, và ngay sau khi người dùng chọn hoặc thêm chủ đề.
 */
export async function embedPendingTopics(
  db: Database,
  embedder: EmbeddingProvider,
): Promise<number> {
  const pending = await db
    .select({ id: profileTopics.id, descriptionEn: profileTopics.descriptionEn })
    .from(profileTopics)
    .where(
      and(
        eq(profileTopics.active, true),
        or(isNull(profileTopics.embedding), ne(profileTopics.embeddingModel, embedder.model)),
      ),
    );
  if (pending.length === 0) return 0;
  const vectors = await embedder.embed(
    pending.map((p) => p.descriptionEn),
    "embed_topic",
  );
  for (const [i, p] of pending.entries()) {
    // Vector mới (mô tả đổi, hoặc đổi model) thì điểm cũ của chủ đề không còn đúng.
    await db.delete(docTopicScores).where(eq(docTopicScores.profileTopicId, p.id));
    await db
      .update(profileTopics)
      .set({ embedding: vectors[i], embeddingModel: embedder.model, updatedAt: new Date() })
      .where(eq(profileTopics.id, p.id));
  }
  log.info("đã embed chủ đề", { n: pending.length });
  return pending.length;
}

/** Chủ đề của người dùng, để CLI và bot hiển thị. */
export async function listProfileTopics(db: Database) {
  return db
    .select({
      id: profileTopics.id,
      label: profileTopics.label,
      origin: profileTopics.origin,
      kind: profileTopics.kind,
      active: profileTopics.active,
      embedded: sql<boolean>`${profileTopics.embedding} is not null`,
      descriptionEn: profileTopics.descriptionEn,
    })
    .from(profileTopics)
    .where(eq(profileTopics.profileId, PROFILE_ID))
    .orderBy(asc(profileTopics.id));
}
