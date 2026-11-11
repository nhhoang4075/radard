/**
 * The user's topics: choose from the library, add your own, enable/disable, embed.
 *
 * Every operation can be run many times without creating duplicates (choosing again = re-enabling the old row,
 * re-seeding = updating the library), because they are called from both the CLI and the Telegram bot.
 */
import { createLogger, type EmbeddingProvider, type LlmProvider, nfc } from "@radard/core";
import { type Database, docTopicScores, profileTopics, topicExamples, topics } from "@radard/db";
import { and, asc, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { TOPIC_RECIPE, topicQueryText } from "../topics/instruct.ts";
import { TOPIC_LIBRARY, TOPIC_SUCCESSORS } from "../topics/library.ts";

const log = createLogger("topics");

/**
 * Puts the library in the code into the `topics` table: adds new topics, updates existing ones by `key`.
 * A topic with a new description sentence has its embedding deleted so the process run embeds it again (old scores removed along with it); changing
 * `labelGuide` does not (it is not embedded). Finally moves selections from withdrawn topics to the topic replacing them (`carrySelections`).
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
  // Withdraws from the library the topics no longer in the code; those who selected them keep their selection.
  const keys = TOPIC_LIBRARY.map((t) => t.key);
  await db
    .update(topics)
    .set({ active: false })
    .where(and(eq(topics.origin, "library"), notInArray(topics.key, keys)));
  const carried = await carrySelections(db);
  return { topics: TOPIC_LIBRARY.length, refreshed, carried };
}

/**
 * Moves selections via `TOPIC_SUCCESSORS`: for each profile, the new topic is selected and enabled if the profile
 * has at least one enabled old topic pointing to it (an already-enabled new topic is left as is); if there is no
 * `profile_topics` row yet, one is added. Then turns off the selections of the withdrawn old topics. Disabled selections are not
 * moved. Running again changes nothing: the old topics are all off. Returns the number of old-topic selections just turned off.
 */
export async function carrySelections(db: Database): Promise<number> {
  const libraryKeys = new Set(TOPIC_LIBRARY.map((t) => t.key));
  // Only move from withdrawn topics: a key still in the library lets the user choose it directly.
  const pairs = Object.entries(TOPIC_SUCCESSORS).filter(
    ([from, to]) => !libraryKeys.has(from) && libraryKeys.has(to),
  );
  if (pairs.length === 0) return 0;
  const map = sql.join(
    pairs.map(([from, to]) => sql`(${from}, ${to})`),
    sql`, `,
  );
  return db.transaction(async (tx) => {
    // A profile may have several old topics enabled that point to the same new topic: merge them into one row.
    // If an old topic was "interested", the new topic is "interested" too ('include' > 'exclude').
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
  /** The user has selected and enabled it. */
  chosen: boolean;
}

/** The library with the selected state, in display order. */
export async function listLibrary(db: Database, profileId: number): Promise<LibraryEntry[]> {
  return db
    .select({
      id: topics.id,
      // Library topics always have a key and group (topics_source_ck).
      key: sql<string>`${topics.key}`,
      groupName: sql<string>`coalesce(${topics.groupName}, '')`,
      name: topics.name,
      chosen: sql<boolean>`coalesce(${profileTopics.active}, false)`,
    })
    .from(topics)
    .leftJoin(
      profileTopics,
      and(eq(profileTopics.topicId, topics.id), eq(profileTopics.profileId, profileId)),
    )
    .where(and(eq(topics.origin, "library"), eq(topics.active, true)))
    .orderBy(asc(topics.position));
}

/** Selects topics from the library by `key`. If already selected, re-enables it. Returns the number of topics enabled. */
export async function pickTopics(db: Database, profileId: number, keys: string[]): Promise<number> {
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
      .values({ profileId: profileId, topicId: t.id })
      .onConflictDoUpdate({
        target: [profileTopics.profileId, profileTopics.topicId],
        set: { active: true, updatedAt: new Date() },
      });
  }
  return found.length;
}

/** Enables or disables a topic by the id of `profile_topics`. Does not delete: old scores and embeddings are kept. */
export async function setTopicActive(
  db: Database,
  profileId: number,
  id: number,
  active: boolean,
): Promise<boolean> {
  const rows = await db
    .update(profileTopics)
    .set({ active, updatedAt: new Date() })
    .where(and(eq(profileTopics.id, id), eq(profileTopics.profileId, profileId)))
    .returning({ id: profileTopics.id });
  return rows.length > 0;
}

/** Enables or disables a library topic by the id of `topics` (the Telegram buttons carry this id). */
export async function toggleLibraryTopic(
  db: Database,
  profileId: number,
  topicId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: profileTopics.id, active: profileTopics.active })
    .from(profileTopics)
    .where(and(eq(profileTopics.topicId, topicId), eq(profileTopics.profileId, profileId)));
  if (row) {
    await setTopicActive(db, profileId, row.id, !row.active);
    return !row.active;
  }
  const [t] = await db
    .select({ key: topics.key })
    .from(topics)
    .where(and(eq(topics.id, topicId), eq(topics.origin, "library")));
  if (!t?.key) throw new Error(`không có chủ đề ${topicId} trong thư viện`);
  await pickTopics(db, profileId, [t.key]);
  return true;
}

/**
 * Enables (selects, or re-enables the old row) or disables several library topics by id of `topics`, in one
 * transaction. Ids not in the library in use are ignored. Returns the number of topics newly enabled.
 */
export async function setLibraryTopics(
  db: Database,
  profileId: number,
  on: number[],
  off: number[],
): Promise<number> {
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
        .values(found.map((t) => ({ profileId: profileId, topicId: t.id })))
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
            eq(profileTopics.profileId, profileId),
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

/** One LLM call: the user's wording (Vietnamese or English) → English description sentence for embedding. */
export async function describeTopic(
  llm: LlmProvider,
  label: string,
  text: string,
): Promise<string> {
  const reply = await llm.generateText({
    task: "topic_describe",
    system: DESCRIBE_SYSTEM,
    prompt: `Topic name given by the reader: ${label}\nThe reader's own description: ${text}`,
    // The model has hidden thinking tokens counted toward this cap (measured 11/10/2026): keep it generous.
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
 * Saves a self-added topic: one `topics` row of the profile, then selects it (enabled right away). A name clash
 * (case-insensitive) with a library topic or an already self-added topic is an error. Returns the id of the `profile_topics` row.
 */
export async function addCustomTopic(
  db: Database,
  profileId: number,
  input: CustomTopicInput,
): Promise<number> {
  const label = nfc(input.label).trim();
  const [dup] = await db
    .select({ id: topics.id })
    .from(topics)
    .where(
      and(
        or(eq(topics.origin, "library"), eq(topics.ownerProfileId, profileId)),
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
        ownerProfileId: profileId,
      })
      .returning({ id: topics.id });
    if (!topic) throw new Error("không ghi được chủ đề");
    const [row] = await tx
      .insert(profileTopics)
      .values({ profileId: profileId, topicId: topic.id, kind: input.kind ?? "include" })
      .returning({ id: profileTopics.id });
    if (!row) throw new Error("không ghi được chủ đề");
    return row.id;
  });
}

/**
 * Embeds every topic that has no vector for the current model yet, in one request: library topics and
 * selected topics (including self-added topics and topics withdrawn from the library), enabled or disabled. Called at the start
 * of each process run, and right after the user selects or adds a topic.
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
    // A new vector (description changed, or the model changed): the topic's old scores are no longer valid.
    await db.delete(docTopicScores).where(eq(docTopicScores.topicId, p.id));
    // A new description (no vector yet): fake items written from the old description are no longer valid.
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

/** The user's topics, for the CLI and bot to display. */
export async function listProfileTopics(db: Database, profileId: number) {
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
    .where(eq(profileTopics.profileId, profileId))
    .orderBy(asc(profileTopics.id));
}
