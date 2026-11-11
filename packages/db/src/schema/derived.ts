/**
 * Derived data (MVP-0): normalized text, embeddings, events.
 *
 * Everything here is DERIVED from the collected data (collected.ts): it can be deleted and rebuilt. Each row
 * records the embedding model that produced it, so when the model changes we know what to recompute.
 *
 * Nothing here depends on user profiles (decision D4, 12/10/2026): every document is
 * embedded and merged into events. Per-user topic scores live in `scores.ts`.
 */
import {
  bigint,
  halfvec,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { documents } from "./collected.ts";

/**
 * Dimensions of `alibaba/qwen3-embedding-0.6b`. NOT yet verified through Gateway (needs an API key):
 * the adapter rejects vectors of other dimensions, so a mistake fails early on the first call instead of corrupting data.
 */
export const EMBED_DIMENSIONS = 1024;

export const docText = pgTable("doc_text", {
  documentId: bigint("document_id", { mode: "number" })
    .primaryKey()
    .references(() => documents.id, { onDelete: "cascade" }),
  /** Full text (including the page's text if any), original language, NFC-normalized. The digest is extracted from here. */
  text: text("text").notNull(),
  /** ISO 639-3 code guessed by franc (`eng`, `vie`…); `und` when too short to guess. */
  lang: text("lang").notNull(),
  /**
   * Vector of the source's raw text (title, abstract, release notes): used to MERGE events.
   * The merge threshold 0,9 is tuned on this vector; with page content in the vector, two articles on the same story at
   * two different pages only reach cosine 0,6–0,88 (measured 13/10/2026 on 292 pairs), so merging breaks.
   */
  embedding: halfvec("embedding", { dimensions: EMBED_DIMENSIONS }).notNull(),
  /**
   * Vector of the raw text PLUS the main text of the linked page (`pages` job): used to SCORE
   * topics. Empty when there is no page (arXiv, Ask HN, bot-blocked pages): scored by `embedding`.
   */
  contentEmbedding: halfvec("content_embedding", { dimensions: EMBED_DIMENSIONS }),
  embeddingModel: text("embedding_model").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable(
  "events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Temporarily takes the first document's title; MVP-1 will rewrite it with an LLM, in English. */
    title: text("title").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    /** Number of documents in the event, including merges for the same URL: measures how much it is mentioned, for ranking. */
    nDocs: integer("n_docs").notNull().default(1),
    /**
     * Number of vectors contributed to `centroid` (seed + merged by vector or by the decision model), used as the
     * weight for `runningMean`.
     * Differs from `nDocs`: merging for the same URL adds documents but does not change the centroid.
     */
    nVectors: integer("n_vectors").notNull().default(1),
    centroid: halfvec("centroid", { dimensions: EMBED_DIMENSIONS }).notNull(),
    embeddingModel: text("embedding_model").notNull(),
  },
  (t) => [
    index("events_last_seen_idx").on(t.lastSeenAt),
    index("events_centroid_hnsw").using("hnsw", t.centroid.op("halfvec_cosine_ops")),
  ],
);

export const eventDocuments = pgTable(
  "event_documents",
  {
    eventId: bigint("event_id", { mode: "number" })
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    documentId: bigint("document_id", { mode: "number" })
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** Cosine to the cluster centroid at merge time; 1 if it is the opening document, or merged for the same URL. */
    similarity: real("similarity").notNull(),
    /**
     * `seed` (opens the event) · `url` (same url_canonical) · `vector` (near the centroid) · `decision` (grey
     * zone below the vector threshold, the decision model answers that it is the same story; merged into the centroid like `vector`).
     */
    reason: text("reason").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.documentId] }),
    index("event_documents_event_idx").on(t.eventId),
  ],
);
