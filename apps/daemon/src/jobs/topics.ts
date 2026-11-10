/**
 * Chủ đề của người dùng: chọn từ thư viện, tự thêm, bật tắt, embed.
 *
 * Mọi thao tác đều chạy được nhiều lần mà không sinh bản trùng (chọn lại = bật lại dòng cũ,
 * seed lại = cập nhật thư viện), vì chúng được gọi từ cả CLI lẫn bot Telegram.
 */
import { createLogger, type EmbeddingProvider, type LlmProvider, nfc } from "@radard/core";
import { type Database, docTopicScores, profileTopics, topicExamples, topics } from "@radard/db";
import { and, asc, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { TOPIC_RECIPE, topicQueryText } from "../topics/instruct.ts";
import { TOPIC_LIBRARY, TOPIC_SUCCESSORS } from "../topics/library.ts";

const log = createLogger("topics");

export const PROFILE_ID = 1;

/**
 * Đưa thư viện trong code vào bảng `topics`: thêm chủ đề mới, cập nhật chủ đề đã có theo `key`.
 * Chủ đề có câu mô tả mới thì xoá embedding để lượt process embed lại (điểm cũ xoá theo); đổi
 * `labelGuide` thì không (nó không được embed). Cuối cùng chuyển lựa chọn từ chủ đề đã rút sang chủ
 * đề thay nó (`carrySelections`).
 */
export async function seedLibrary(
  db: Database,
): Promise<{ topics: number; refreshed: number; carried: number }> {
  const before = new Map(
    (
      await db
        .select({ key: topics.key, embedText: topics.embedText })
        .from(topics)
        .where(eq(topics.origin, "library"))
    ).map((t) => [t.key, t.embedText]),
  );
  let refreshed = 0;
  for (const [position, t] of TOPIC_LIBRARY.entries()) {
    const changed = before.has(t.key) && before.get(t.key) !== t.embedText;
    if (changed) refreshed++;
    await db
      .insert(topics)
      .values({ ...t, position, origin: "library" })
      .onConflictDoUpdate({
        target: topics.key,
        set: {
          groupName: t.groupName,
          name: t.name,
          embedText: t.embedText,
          labelGuide: t.labelGuide,
          position,
          active: true,
          ...(changed ? { embedding: null, embeddingModel: null } : {}),
        },
      });
  }
  // Rút khỏi thư viện những chủ đề không còn trong code; người đã chọn vẫn giữ.
  const keys = TOPIC_LIBRARY.map((t) => t.key);
  await db
    .update(topics)
    .set({ active: false })
    .where(and(eq(topics.origin, "library"), notInArray(topics.key, keys)));
  const carried = await carrySelections(db);
  return { topics: TOPIC_LIBRARY.length, refreshed, carried };
}

/**
 * Chuyển lựa chọn theo `TOPIC_SUCCESSORS`: với mỗi hồ sơ, chủ đề mới được chọn và bật nếu hồ sơ
 * đang bật ít nhất một chủ đề cũ trỏ tới nó (chủ đề mới đã bật sẵn thì giữ nguyên); chưa có dòng
 * `profile_topics` thì thêm. Sau đó tắt lựa chọn các chủ đề cũ đã rút. Lựa chọn đang tắt không
 * được chuyển. Chạy lại không đổi gì: chủ đề cũ đã tắt hết. Trả về số lựa chọn chủ đề cũ vừa tắt.
 */
export async function carrySelections(db: Database): Promise<number> {
  const libraryKeys = new Set(TOPIC_LIBRARY.map((t) => t.key));
  // Chỉ chuyển từ chủ đề đã rút: khoá còn trong thư viện thì người dùng vẫn chọn được chính nó.
  const pairs = Object.entries(TOPIC_SUCCESSORS).filter(
    ([from, to]) => !libraryKeys.has(from) && libraryKeys.has(to),
  );
  if (pairs.length === 0) return 0;
  const map = sql.join(
    pairs.map(([from, to]) => sql`(${from}, ${to})`),
    sql`, `,
  );
  return db.transaction(async (tx) => {
    // Một hồ sơ có thể bật nhiều chủ đề cũ cùng trỏ tới một chủ đề mới: gom lại thành một dòng.
    // Có chủ đề cũ "quan tâm" thì chủ đề mới là "quan tâm" ('include' > 'exclude').
    await tx.execute(sql`
      insert into ${profileTopics} (profile_id, topic_id, kind, active)
      select pt.profile_id, dst.id, max(pt.kind), true
      from ${profileTopics} pt
      join ${topics} src on src.id = pt.topic_id and src.origin = 'library' and not src.active
      join (values ${map}) as m(src_key, dst_key) on m.src_key = src.key
      join ${topics} dst on dst.key = m.dst_key and dst.origin = 'library'
      where pt.active
      group by pt.profile_id, dst.id
      on conflict (profile_id, topic_id) do update set active = true, updated_at = now()
        where not ${profileTopics}.active`);
    const off = await tx
      .update(profileTopics)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(profileTopics.active, true),
          inArray(
            profileTopics.topicId,
            tx
              .select({ id: topics.id })
              .from(topics)
              .where(
                and(
                  eq(topics.origin, "library"),
                  eq(topics.active, false),
                  inArray(
                    topics.key,
                    pairs.map(([from]) => from),
                  ),
                ),
              ),
          ),
        ),
      )
      .returning({ id: profileTopics.id });
    if (off.length > 0) log.info("đã chuyển lựa chọn sang chủ đề mới", { n: off.length });
    return off.length;
  });
}

export interface LibraryEntry {
  id: number;
  key: string;
  groupName: string;
  name: string;
  /** Người dùng đã chọn và đang bật. */
  chosen: boolean;
}

/** Thư viện kèm trạng thái đã chọn, theo thứ tự hiển thị. */
export async function listLibrary(db: Database): Promise<LibraryEntry[]> {
  return db
    .select({
      id: topics.id,
      // Chủ đề thư viện luôn có khoá và nhóm (topics_source_ck).
      key: sql<string>`${topics.key}`,
      groupName: sql<string>`coalesce(${topics.groupName}, '')`,
      name: topics.name,
      chosen: sql<boolean>`coalesce(${profileTopics.active}, false)`,
    })
    .from(topics)
    .leftJoin(
      profileTopics,
      and(eq(profileTopics.topicId, topics.id), eq(profileTopics.profileId, PROFILE_ID)),
    )
    .where(and(eq(topics.origin, "library"), eq(topics.active, true)))
    .orderBy(asc(topics.position));
}

/** Chọn chủ đề từ thư viện theo `key`. Đã chọn rồi thì bật lại. Trả về số chủ đề được bật. */
export async function pickTopics(db: Database, keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const found = await db
    .select()
    .from(topics)
    .where(and(eq(topics.origin, "library"), inArray(topics.key, keys), eq(topics.active, true)));
  const unknown = keys.filter((k) => !found.some((t) => t.key === k));
  if (unknown.length > 0) throw new Error(`không có trong thư viện: ${unknown.join(", ")}`);
  for (const t of found) {
    await db
      .insert(profileTopics)
      .values({ profileId: PROFILE_ID, topicId: t.id })
      .onConflictDoUpdate({
        target: [profileTopics.profileId, profileTopics.topicId],
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
  const [t] = await db
    .select({ key: topics.key })
    .from(topics)
    .where(and(eq(topics.id, topicId), eq(topics.origin, "library")));
  if (!t?.key) throw new Error(`không có chủ đề ${topicId} trong thư viện`);
  await pickTopics(db, [t.key]);
  return true;
}

/**
 * Bật (chọn, hoặc bật lại dòng cũ) hoặc tắt nhiều chủ đề thư viện theo id của `topics`, trong một
 * giao dịch. Id không thuộc thư viện đang dùng thì bỏ qua. Trả về số chủ đề được bật mới.
 */
export async function setLibraryTopics(db: Database, on: number[], off: number[]): Promise<number> {
  return db.transaction(async (tx) => {
    let enabled = 0;
    const found =
      on.length === 0
        ? []
        : await tx
            .select({ id: topics.id })
            .from(topics)
            .where(
              and(eq(topics.origin, "library"), eq(topics.active, true), inArray(topics.id, on)),
            );
    if (found.length > 0) {
      const rows = await tx
        .insert(profileTopics)
        .values(found.map((t) => ({ profileId: PROFILE_ID, topicId: t.id })))
        .onConflictDoUpdate({
          target: [profileTopics.profileId, profileTopics.topicId],
          set: { active: true, updatedAt: new Date() },
          setWhere: eq(profileTopics.active, false),
        })
        .returning({ id: profileTopics.id });
      enabled = rows.length;
    }
    if (off.length > 0) {
      await tx
        .update(profileTopics)
        .set({ active: false, updatedAt: new Date() })
        .where(
          and(
            eq(profileTopics.profileId, PROFILE_ID),
            eq(profileTopics.active, true),
            inArray(profileTopics.topicId, off),
          ),
        );
    }
    return enabled;
  });
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
  description: string;
  embedText: string;
  kind?: "include" | "exclude";
}

/**
 * Lưu chủ đề tự thêm: một dòng `topics` của hồ sơ, rồi chọn nó (bật ngay). Trùng tên (không phân biệt
 * hoa thường) với chủ đề thư viện hay chủ đề đã tự thêm thì báo lỗi. Trả về id của `profile_topics`.
 */
export async function addCustomTopic(db: Database, input: CustomTopicInput): Promise<number> {
  const label = nfc(input.label).trim();
  const [dup] = await db
    .select({ id: topics.id })
    .from(topics)
    .where(
      and(
        or(eq(topics.origin, "library"), eq(topics.ownerProfileId, PROFILE_ID)),
        sql`lower(${topics.name}) = lower(${label})`,
      ),
    );
  if (dup) throw new Error(`đã có chủ đề tên "${label}"`);
  return db.transaction(async (tx) => {
    const [topic] = await tx
      .insert(topics)
      .values({
        name: label,
        description: nfc(input.description).trim(),
        embedText: input.embedText,
        origin: "custom",
        ownerProfileId: PROFILE_ID,
      })
      .returning({ id: topics.id });
    if (!topic) throw new Error("không ghi được chủ đề");
    const [row] = await tx
      .insert(profileTopics)
      .values({ profileId: PROFILE_ID, topicId: topic.id, kind: input.kind ?? "include" })
      .returning({ id: profileTopics.id });
    if (!row) throw new Error("không ghi được chủ đề");
    return row.id;
  });
}

/**
 * Embed mọi chủ đề chưa có vector của model hiện tại, trong một request: chủ đề trong thư viện và
 * chủ đề đã được chọn (kể cả chủ đề tự thêm, chủ đề đã rút khỏi thư viện), bật hay tắt. Gọi ở đầu
 * mỗi lượt process, và ngay sau khi người dùng chọn hoặc thêm chủ đề.
 */
export async function embedPendingTopics(
  db: Database,
  embedder: EmbeddingProvider,
): Promise<number> {
  const picked = db.select({ id: profileTopics.topicId }).from(profileTopics);
  const pending = await db
    .select({ id: topics.id, embedText: topics.embedText, fresh: isNull(topics.embedding) })
    .from(topics)
    .where(
      and(
        or(and(eq(topics.origin, "library"), eq(topics.active, true)), inArray(topics.id, picked)),
        or(
          isNull(topics.embedding),
          ne(topics.embeddingModel, embedder.model),
          or(isNull(topics.embeddingRecipe), ne(topics.embeddingRecipe, TOPIC_RECIPE)),
        ),
      ),
    );
  if (pending.length === 0) return 0;
  const vectors = await embedder.embed(
    pending.map((p) => topicQueryText(p.embedText)),
    "embed_topic",
  );
  for (const [i, p] of pending.entries()) {
    // Vector mới (mô tả đổi, hoặc đổi model) thì điểm cũ của chủ đề không còn đúng.
    await db.delete(docTopicScores).where(eq(docTopicScores.topicId, p.id));
    // Mô tả mới (chưa có vector) thì tin giả định viết từ mô tả cũ không còn đúng.
    if (p.fresh) await db.delete(topicExamples).where(eq(topicExamples.topicId, p.id));
    await db
      .update(topics)
      .set({
        embedding: vectors[i],
        embeddingModel: embedder.model,
        embeddingRecipe: TOPIC_RECIPE,
      })
      .where(eq(topics.id, p.id));
  }
  log.info("đã embed chủ đề", { n: pending.length });
  return pending.length;
}

/** Chủ đề của người dùng, để CLI và bot hiển thị. */
export async function listProfileTopics(db: Database) {
  return db
    .select({
      id: profileTopics.id,
      topicId: profileTopics.topicId,
      label: topics.name,
      origin: topics.origin,
      kind: profileTopics.kind,
      active: profileTopics.active,
      embedded: sql<boolean>`${topics.embedding} is not null`,
      embedText: topics.embedText,
    })
    .from(profileTopics)
    .innerJoin(topics, eq(topics.id, profileTopics.topicId))
    .where(eq(profileTopics.profileId, PROFILE_ID))
    .orderBy(asc(profileTopics.id));
}
