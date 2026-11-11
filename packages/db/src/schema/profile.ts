/**
 * User profile: context and the topics of interest.
 *
 * UNLIKE derived data: this is user data (what they chose, what they wrote) that cannot be recreated, so
 * `reprocess --all` does not delete these tables. Only the derived part (`topics.embedding`) is recomputed
 * when the embedding model changes.
 *
 * Unified term: "topic". `topics` holds every topic (the radard library, pre-written, and user-
 * added topics) with embeddings; `profile_topics` is the user's selection.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  halfvec,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { EMBED_DIMENSIONS } from "./derived.ts";

/**
 * One user in MVP-0 (id = 1).
 *
 * `promptContext` is the user's CONTEXT in English (job, stack, what they are working on), used in the
 * digest prompt to write the line "why this is worth your attention". Not used for filtering: relevance is computed from
 * the enabled topics in `profile_topics` (since 12/10/2026). `description` is what the user wrote
 * about themselves, kept in the language they wrote it in (empty until they write it).
 */
export const profile = pgTable("profile", {
  id: integer("id").primaryKey().default(1),
  promptContext: text("prompt_context").notNull(),
  /** What the user wrote about themselves; not used in the prompt. */
  description: text("description"),
  displayLang: text("display_lang").notNull().default("vi"),
  /**
   * Web login account of the profile (`user.id`). Unique: one user, one profile. Empty until
   * that person logs in for the first time (the bootstrap owner (`BOOTSTRAP_OWNER_EMAILS`) gets the smallest-id profile that has no user yet).
   */
  userId: text("user_id")
    .unique()
    .references(() => user.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

/**
 * All topics, one row each: library topics (written by radard, `topics seed`) and user-
 * added topics (`origin = custom`, belonging to one profile). Embeddings live here, so every document is scored against every
 * topic, regardless of what any user has enabled (D4). What users select lives in `profile_topics`.
 */
export const topics = pgTable(
  "topics",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Stable key in code (`agents`, `llm_apps`…), only library topics have one. */
    key: text("key").unique(),
    /** Display group in the library; user-added topics have none. */
    groupName: text("group_name"),
    /** Display name: the library's pre-written name, or the name the user chose. */
    name: text("name").notNull(),
    /** Text used for embedding: English, with concrete examples (user-added: the LLM writes it from the user's words). */
    embedText: text("embed_text").notNull(),
    /**
     * Topic scope in English (what it includes, what it excludes, which topic a spill-over item belongs to), only
     * given to the LLM when labeling items in the digest; not embedded. The library takes it from code; user-
     * added topics leave it empty (the LLM sees only the name).
     */
    labelGuide: text("label_guide"),
    /** The user's words, kept in the language they wrote; only user-added topics have it. */
    description: text("description"),
    /** library | custom */
    origin: text("origin").notNull().default("library"),
    /** The profile that added this topic; empty for library topics. */
    ownerProfileId: integer("owner_profile_id").references(() => profile.id, {
      onDelete: "cascade",
    }),
    /** Display order in the library. */
    position: integer("position").notNull().default(0),
    /** `false`: removed from the library (not shown to pick); users who already picked it keep it. */
    active: boolean("active").notNull().default(true),
    /** Empty = not embedded yet (just added, description just edited, or model changed): the process job will compute it. */
    embedding: halfvec("embedding", { dimensions: EMBED_DIMENSIONS }),
    embeddingModel: text("embedding_model"),
    /** How the vector is made (task instruction…); if it differs from the current value, the process job re-embeds. */
    embeddingRecipe: text("embedding_recipe"),
  },
  (t) => [
    check("topics_origin_ck", sql`${t.origin} in ('library', 'custom')`),
    // Library: has a key, belongs to no profile. User-added: no key, belongs to one profile, has the user's words.
    check(
      "topics_source_ck",
      sql`(${t.origin} = 'library') = (${t.key} is not null)
        and (${t.origin} = 'library') = (${t.ownerProfileId} is null)
        and (${t.origin} = 'library' or ${t.description} is not null)`,
    ),
    uniqueIndex("topics_custom_label_uq")
      .on(t.ownerProfileId, sql`lower(${t.name})`)
      .where(sql`${t.origin} = 'custom'`),
  ],
);

/**
 * Hypothetical items for a topic (HyDE): a few short items the LLM writes as if they were real items of the topic, embedded like a
 * document. The R score of an item for a topic is the largest cosine among the description vector and these vectors
 * (`scoreTopics`). Derived from `topics.embed_text`: when the description changes, delete and regenerate.
 */
export const topicExamples = pgTable(
  "topic_examples",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    topicId: integer("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    embedding: halfvec("embedding", { dimensions: EMBED_DIMENSIONS }).notNull(),
    embeddingModel: text("embedding_model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("topic_examples_topic_pos_uq").on(t.topicId, t.position)],
);

/**
 * The user's choice: which topics (library or user-added, both in `topics`), enabled or disabled,
 * interested or not interested. Only enabled topics with `kind = include` count toward relevance R.
 */
export const profileTopics = pgTable(
  "profile_topics",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    profileId: integer("profile_id")
      .notNull()
      .default(1)
      .references(() => profile.id, { onDelete: "cascade" }),
    topicId: bigint("topic_id", { mode: "number" })
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    /**
     * include | exclude. `exclude` = "not interested": week 3 only stores it, not yet used when scoring
     * (decision D3, 12/10/2026).
     */
    kind: text("kind").notNull().default("include"),
    /** When off, not counted in R, but not deleted: can be turned back on immediately. */
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Each topic can be selected only once; selecting it again re-enables the old row.
    uniqueIndex("profile_topics_topic_uq").on(t.profileId, t.topicId),
    check("profile_topics_kind_ck", sql`${t.kind} in ('include', 'exclude')`),
  ],
);
