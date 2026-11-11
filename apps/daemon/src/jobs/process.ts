/**
 * Job `process`: the processing part of MVP-0. Three independent phases, each finding its own missing work, so running
 * it again, stopping midway, or changing topics and running again are all safe:
 *
 *   A. Documents without `doc_text` → extract text, detect language, embed. Documents with their own page content
 *      (HN posts linking to a blog, GitHub…) wait for the `pages` job to fetch the page, up to
 *      `PAGE_WAIT_MS`, then embed the title together with the page's main text.
 *   S. Pairs (document, enabled topic) with no score yet → cosine, written to `doc_topic_scores` (pure SQL),
 *      using the page-content vector (`content_embedding`) when available.
 *   B. Documents not yet in any event → merge: same URL first, then by the vector of the raw copy
 *      (`embedding`, no page content: the 0,9 threshold was tuned on this vector). The grey zone
 *      0,85–0,9 asks the decision model "are these the same story?" (`DECISION_JOIN_LOW`).
 *
 * Phases A and B do NOT read the user profiles (decision D4, 12/10/2026): every document is embedded
 * and merged. Profiles are only used for scoring (phase S) and for choosing items in the digest. Before 12/10, phase B only
 * merged documents with cosine ≥ 0,58 against a TEMPORARY description, so the pipeline had two gates that were loosely related.
 */
import {
  createLogger,
  type DecisionProvider,
  type EmbeddingProvider,
  type LlmProvider,
  nfc,
  type ObjectStore,
  type PageExtractor,
  runningMean,
} from "@radard/core";
import {
  type Database,
  docText,
  documents,
  eventDocuments,
  events,
  linkedPages,
  sources,
} from "@radard/db";
import { and, asc, cosineDistance, eq, gte, inArray, isNull, lte, not, sql } from "drizzle-orm";
import { franc } from "franc";
import { adapterFor } from "../sources/index.ts";
import { articleKinds, PAGE_WAIT_MS } from "./pages.ts";
import { ensureTopicExamples } from "./topic-examples.ts";
import { embedPendingTopics } from "./topics.ts";

const log = createLogger("process");

/** The embedding model has an input limit; the start of the text is enough to say what the document is about. */
const MAX_TEXT_CHARS = 4000;
/**
 * The main text of the linked page that goes into the embedding: about one arXiv abstract (~1.500 characters), so that
 * HN and arXiv documents are embedded from a comparable amount of text.
 */
const PAGE_TEXT_CHARS = 1500;

/**
 * Vector-merge grey zone: cosine to the nearest event centroid in [0,85; `thresholds.join`)
 * asks the decision model "do these two items cover the same story?". Measured 13–16/10/2026 on real data:
 * 42% of pairs with cosine 0,85–0,9 are the same story, so both the 0,9 threshold and lowering it are often wrong;
 * in this zone cosine barely separates them (AUC 0,57), while Jev separates nearly all of them (AUC
 * 0,99, matches the reference labels 97% at threshold 0,5; you confirmed 14/14 reference labels).
 */
export const DECISION_JOIN_LOW = 0.85;
/** Minimum "same story" probability to merge (the measured threshold, see `DECISION_JOIN_LOW`). */
export const DECISION_JOIN_MIN_P = 0.5;
/** The question exactly as measured (experiment A, 13–16/10/2026). */
export const SAME_STORY_QUESTION =
  "Do these two items report the same news story or announcement (not merely the same topic)?";
/** Excerpt of each item given to the model: the first 400 characters of the embedded text, as measured. */
const DECISION_EXCERPT_CHARS = 400;

export interface Thresholds {
  /** Minimum cosine to the cluster centroid to merge into an existing event: "the same story". */
  join: number;
  /** Only compared with events active within this many days around the document's time. */
  windowDays: number;
}

export interface ProcessDeps {
  db: Database;
  store: ObjectStore;
  embedder: EmbeddingProvider;
  /** Writes placeholder items for the topic (HyDE). Without it, topics are scored by their description, as before. */
  llm?: LlmProvider | null;
  thresholds: Thresholds;
  /**
   * Decision model for the grey zone of the vector merge. Without it (or on error), merging works as it did before
   * the model existed: below `thresholds.join`, a new event opens. `events rebuild` does not pass it by default.
   */
  decider?: DecisionProvider | null;
  /** Extracts the main text from the HTML of the linked page. Without it, only the source's raw copy is embedded. */
  extractPage?: PageExtractor;
  batchSize?: number;
  /** Cap on embed batches per run; the rest is left for the next run. Unset = run to the end. */
  maxBatches?: number;
  /**
   * Cap on documents merged per run. Each document costs one nearest-centroid query (~85 ms when
   * scanning ~15 thousand events, measured 12/10/2026), so a run after a long downtime must be split to
   * finish before the job's deadline. Unset = run to the end (CLI `events rebuild`).
   */
  maxCluster?: number;
}

export interface ProcessOutcome {
  embedded: number;
  topicsEmbedded: number;
  scored: number;
  joinedByUrl: number;
  joinedByVector: number;
  /** Merged because the decision model answered "same story" (grey zone). */
  joinedByDecision: number;
  /** Number of decision-model calls that returned an answer. */
  decisionsAsked: number;
  /** Number of failed calls (treated as not the same story). */
  decisionsFailed: number;
  /** Number of documents in the grey zone not asked because there is no decision model. */
  decisionsSkipped: number;
  created: number;
}

export async function runProcess(deps: ProcessDeps): Promise<ProcessOutcome> {
  const out: ProcessOutcome = {
    embedded: 0,
    topicsEmbedded: await embedPendingTopics(deps.db, deps.embedder),
    scored: 0,
    joinedByUrl: 0,
    joinedByVector: 0,
    joinedByDecision: 0,
    decisionsAsked: 0,
    decisionsFailed: 0,
    decisionsSkipped: 0,
    created: 0,
  };
  await ensureTopicExamples(deps.db, deps.llm ?? null, deps.embedder);
  // Phase A in batches until there is no work left (or this run's batch cap is reached).
  for (let batches = 0; batches < (deps.maxBatches ?? Infinity); batches++) {
    const n = await embedBatch(deps, out);
    if (n === 0) break;
  }
  out.scored = await scoreTopics(deps.db, deps.embedder.model);
  await clusterPending(deps, out);
  if (out.decisionsSkipped > 0) {
    log.warn("không có model quyết định: tài liệu vùng xám được mở sự kiện mới, không hỏi", {
      n: out.decisionsSkipped,
    });
  }
  log.info("xong", { ...out });
  return out;
}

/**
 * Deletes every event and merges again from scratch; keeps embeddings and topic scores (CLI `events rebuild`). Re-merging
 * the whole history while asking the decision model for every grey-zone document is ~1,700 calls (measured 16/10/2026),
 * so by default it does NOT ask: it only asks when `decide` is set.
 */
export async function rebuildEvents(
  deps: ProcessDeps,
  opts: { decide?: boolean } = {},
): Promise<ProcessOutcome> {
  await deps.db.execute(sql`truncate ${eventDocuments}, ${events}`);
  return runProcess({ ...deps, decider: opts.decide ? deps.decider : null });
}

/**
 * Text to embed: the source adapter extracts it from the raw copy (the title is used if there is none), plus the start
 * of the main text of the linked page if there is one.
 */
export function buildText(
  kind: string,
  body: string,
  title: string | null,
  pageText: string | null = null,
): string {
  let text = title ?? "";
  try {
    text = adapterFor(kind).toText?.(body, title) ?? text;
  } catch {
    // Broken raw copy, or a source kind with no adapter any more: the title is still enough to filter and merge.
  }
  if (pageText) text = `${text}\n\n${pageText.slice(0, PAGE_TEXT_CHARS)}`;
  return nfc(text).slice(0, MAX_TEXT_CHARS);
}

/**
 * Phase S: scores every missing (document, topic with an embedding) pair in one SQL statement: cosine on
 * vectors already stored, no model call. Scores against ALL topics (library and self-added, enabled or not), so scores
 * do not depend on what the user has enabled (D4). Only joins vectors from the same embedding model. Returns the number
 * of new scores written.
 */
export async function scoreTopics(db: Database, embeddingModel: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    with ins as (
      insert into doc_topic_scores (document_id, topic_id, score)
      -- Score with the page-content vector when there is one (see doc_text.content_embedding).
      -- The score is the max cosine between the description vector and the topic's hypothetical items (topic_examples).
      select dt.document_id, t.id,
        greatest(
          1 - (coalesce(dt.content_embedding, dt.embedding) <=> t.embedding),
          coalesce(ex.best, -1)
        )
      from topics t
      join doc_text dt on dt.embedding_model = t.embedding_model
      left join lateral (
        select max(1 - (coalesce(dt.content_embedding, dt.embedding) <=> e.embedding)) as best
        from topic_examples e
        where e.topic_id = t.id and e.embedding_model = t.embedding_model
      ) ex on true
      where t.embedding is not null and t.embedding_model = ${embeddingModel}
        and not exists (
          select 1 from doc_topic_scores s
          where s.document_id = dt.document_id and s.topic_id = t.id
        )
      on conflict do nothing
      returning 1
    )
    select count(*)::int as n from ins`);
  return Number([...rows][0]?.n ?? 0);
}

async function embedBatch(deps: ProcessDeps, out: ProcessOutcome) {
  const { db, store, embedder } = deps;
  const waitKinds = deps.extractPage ? await articleKinds(db) : [];
  // Waiting for the page: the source has a content page, the pages job has not yet checked this URL, and the document is still recent.
  const waiting = waitKinds.length
    ? and(
        inArray(sources.kind, waitKinds),
        isNull(linkedPages.id),
        gte(documents.fetchedAt, new Date(Date.now() - PAGE_WAIT_MS)),
      )
    : undefined;
  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      url: documents.url,
      rawKey: documents.rawKey,
      kind: sources.kind,
      pageKey: linkedPages.rawKey,
    })
    .from(documents)
    .innerJoin(sources, eq(sources.id, documents.sourceId))
    .leftJoin(docText, eq(docText.documentId, documents.id))
    .leftJoin(linkedPages, eq(linkedPages.urlCanonical, documents.urlCanonical))
    .where(waiting ? and(isNull(docText.documentId), not(waiting)) : isNull(docText.documentId))
    .orderBy(asc(documents.id))
    .limit(deps.batchSize ?? 128);
  if (rows.length === 0) return 0;

  // Two texts for each document with a page: the raw copy (for merging events) and raw copy + page (for scoring topics).
  // Embedded in one request.
  const texts: string[] = [];
  const contents: (string | null)[] = [];
  for (const r of rows) {
    const raw = await store.get(r.rawKey);
    const body = raw ? new TextDecoder().decode(raw) : "";
    const page = await pageTextOf(deps, r);
    texts.push(buildText(r.kind, body, r.title) || "(trống)");
    contents.push(page ? buildText(r.kind, body, r.title, page) : null);
  }
  const extra = contents.filter((c): c is string => c !== null);
  const vectors = await embedder.embed([...texts, ...extra], "embed_document");
  let next = texts.length;

  await db
    .insert(docText)
    .values(
      rows.map((r, i) => {
        const content = contents[i] ?? null;
        const full = content ?? texts[i] ?? "";
        return {
          documentId: r.id,
          text: full,
          lang: franc(full, { minLength: 10 }),
          embedding: vectors[i] ?? [],
          contentEmbedding: content === null ? null : (vectors[next++] ?? null),
          embeddingModel: embedder.model,
        };
      }),
    )
    .onConflictDoNothing();
  out.embedded += rows.length;
  return rows.length;
}

async function pageTextOf(
  deps: ProcessDeps,
  r: { pageKey: string | null; url: string },
): Promise<string | null> {
  if (!deps.extractPage || !r.pageKey) return null;
  const raw = await deps.store.get(r.pageKey);
  return raw ? deps.extractPage(new TextDecoder().decode(raw), r.url) : null;
}

/** Documents waiting to merge, enough to find the event and to ask the decision model. */
interface PendingDoc {
  id: number;
  title: string | null;
  url: string;
  at: Date;
  embedding: number[];
  vectorJoin: boolean;
  source: string;
  excerpt: string;
}

async function clusterPending(deps: ProcessDeps, out: ProcessOutcome): Promise<void> {
  const { db, embedder } = deps;
  const pending: PendingDoc[] = await db
    .select({
      id: documents.id,
      title: documents.title,
      url: documents.urlCanonical,
      at: sql<Date>`coalesce(${documents.publishedAt}, ${documents.fetchedAt})`.mapWith(
        (v) => new Date(v),
      ),
      embedding: docText.embedding,
      // `sources.config.vectorJoin = false`: no merging by vector, only by the same URL. Used for
      // GitHub releases: Bun 1.4.1 and 1.4.2 are nearly identical vectors but are two separate releases.
      vectorJoin: sql<boolean>`coalesce((${sources.config}->>'vectorJoin')::boolean, true)`,
      source: sources.name,
      excerpt: sql<string>`left(${docText.text}, ${DECISION_EXCERPT_CHARS})`,
    })
    .from(docText)
    .innerJoin(documents, eq(documents.id, docText.documentId))
    .innerJoin(sources, eq(sources.id, documents.sourceId))
    .leftJoin(eventDocuments, eq(eventDocuments.documentId, docText.documentId))
    .where(
      and(
        isNull(eventDocuments.documentId),
        // Vectors from two different models cannot be compared. When changing the model, run
        // `bun run cli reprocess --all` to recompute all derived data.
        eq(docText.embeddingModel, embedder.model),
      ),
    )
    // Oldest first, newest last: the event is opened by the earliest document.
    .orderBy(sql`coalesce(${documents.publishedAt}, ${documents.fetchedAt})`, asc(documents.id))
    .limit(deps.maxCluster ?? 1_000_000_000);

  for (const doc of pending) await clusterOne(deps, doc, out);
}

/** Merges one document: same URL, then the nearest event by vector (asking in the grey zone), otherwise opens a new one. */
async function clusterOne(deps: ProcessDeps, doc: PendingDoc, out: ProcessOutcome) {
  const { db } = deps;
  // 1) The same article (url_canonical) is already in some event: go to that event.
  const [sameUrl] = await db
    .select({ eventId: eventDocuments.eventId })
    .from(eventDocuments)
    .innerJoin(documents, eq(documents.id, eventDocuments.documentId))
    .where(eq(documents.urlCanonical, doc.url))
    .limit(1);
  if (sameUrl) {
    await attach(db, sameUrl.eventId, doc, 1, "url");
    out.joinedByUrl++;
    return;
  }

  // 2) Nearest event by vector, within the time window around the document. At or above the threshold (0,9) it
  //    merges; the grey zone 0,85–0,9 asks the decision model.
  const near = doc.vectorJoin ? await nearestEvent(deps, doc) : undefined;
  const similarity = near ? 1 - Number(near.distance) : -1;
  const how = near ? await joinReason(deps, doc, near.id, similarity, out) : null;
  if (near && how) {
    await db
      .update(events)
      .set({
        // The weight is the number of vectors in the centroid, not nDocs (see `events.nVectors`).
        centroid: runningMean(near.centroid, near.nVectors, doc.embedding),
        nVectors: near.nVectors + 1,
        nDocs: sql`${events.nDocs} + 1`,
        ...widenSpan(doc.at),
      })
      .where(eq(events.id, near.id));
    await attach(db, near.id, doc, similarity, how);
    if (how === "vector") out.joinedByVector++;
    else out.joinedByDecision++;
    return;
  }

  // 3) No match: open a new event.
  const [created] = await db
    .insert(events)
    .values({
      title: doc.title ?? doc.url,
      firstSeenAt: doc.at,
      lastSeenAt: doc.at,
      centroid: doc.embedding,
      embeddingModel: deps.embedder.model,
    })
    .returning({ id: events.id });
  if (created) await attach(db, created.id, doc, 1, "seed");
  out.created++;
}

/**
 * Whether it merges into the nearest event, and why: `vector` (above the threshold), `decision` (grey zone, the model
 * answered "the same story"), `null` (opens a new event). If the ask fails, treat it as not merged: this never
 * breaks the process run.
 */
async function joinReason(
  deps: ProcessDeps,
  doc: PendingDoc,
  eventId: number,
  similarity: number,
  out: ProcessOutcome,
): Promise<"vector" | "decision" | null> {
  if (similarity >= deps.thresholds.join) return "vector";
  if (similarity < DECISION_JOIN_LOW) return null;
  if (!deps.decider) {
    out.decisionsSkipped++;
    return null;
  }
  try {
    const p = await askSameStory(deps.db, deps.decider, doc, eventId);
    out.decisionsAsked++;
    return p !== null && p >= DECISION_JOIN_MIN_P ? "decision" : null;
  } catch (err) {
    out.decisionsFailed++;
    log.warn("hỏi cùng tin lỗi, mở sự kiện mới", {
      documentId: doc.id,
      eventId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
    return null;
  }
}

/**
 * Asks "are these two items the same story?": `item_a` is the new document, `item_b` is the document of the event
 * most similar to it (by raw-copy vector). Returns the probability of "yes"; `null` when the event has no document left
 * with text.
 */
async function askSameStory(
  db: Database,
  decider: DecisionProvider,
  doc: PendingDoc,
  eventId: number,
): Promise<number | null> {
  const [member] = await db
    .select({
      title: documents.title,
      source: sources.name,
      at: sql<Date>`coalesce(${documents.publishedAt}, ${documents.fetchedAt})`.mapWith(
        (v) => new Date(v),
      ),
      excerpt: sql<string>`left(${docText.text}, ${DECISION_EXCERPT_CHARS})`,
    })
    .from(eventDocuments)
    .innerJoin(documents, eq(documents.id, eventDocuments.documentId))
    .innerJoin(sources, eq(sources.id, documents.sourceId))
    .innerJoin(docText, eq(docText.documentId, documents.id))
    .where(eq(eventDocuments.eventId, eventId))
    .orderBy(cosineDistance(docText.embedding, doc.embedding))
    .limit(1);
  if (!member) return null;
  const item = (x: { title: string | null; source: string; at: Date; excerpt: string }) => ({
    title: x.title ?? "",
    source: x.source,
    date: x.at.toISOString().slice(0, 10),
    excerpt: x.excerpt,
  });
  const res = await decider.decide({
    task: "decide_same_story",
    state: { item_a: item(doc), item_b: item(member) },
    questions: { q: { type: "boolean", instructions: SAME_STORY_QUESTION } },
  });
  return res.answers.q.probability;
}

async function nearestEvent(
  { db, embedder, thresholds }: ProcessDeps,
  doc: { at: Date; embedding: number[] },
) {
  // Two-sided window around the document's time: the event must still be active after `from` and have started
  // before `to`. With only a lower bound, a late-arriving old article (arXiv fetched a few days later) could
  // merge into an event from many weeks later.
  const span = thresholds.windowDays * 86_400_000;
  const from = new Date(doc.at.getTime() - span);
  const to = new Date(doc.at.getTime() + span);
  const distance = cosineDistance(events.centroid, doc.embedding);
  const [near] = await db
    .select({ id: events.id, centroid: events.centroid, nVectors: events.nVectors, distance })
    .from(events)
    .where(
      and(
        gte(events.lastSeenAt, from),
        lte(events.firstSeenAt, to),
        eq(events.embeddingModel, embedder.model),
      ),
    )
    .orderBy(distance)
    .limit(1);
  return near;
}

/**
 * Extends the event's time span to contain `at`. Documents do not arrive in time order
 * (an old article may be fetched late), so both ends must be updated.
 */
function widenSpan(at: Date) {
  return {
    firstSeenAt: sql`least(${events.firstSeenAt}, ${at})`,
    lastSeenAt: sql`greatest(${events.lastSeenAt}, ${at})`,
  };
}

async function attach(
  db: Database,
  eventId: number,
  doc: { id: number; at: Date },
  similarity: number,
  reason: "seed" | "url" | "vector" | "decision",
) {
  await db
    .insert(eventDocuments)
    .values({ eventId, documentId: doc.id, similarity, reason })
    .onConflictDoNothing();
  if (reason === "url") {
    // Merge of the same article: does not change the cluster centroid (same content), so `nVectors` is not increased either;
    // it only counts one more document and extends the time span.
    await db
      .update(events)
      .set({
        nDocs: sql`${events.nDocs} + 1`,
        ...widenSpan(doc.at),
      })
      .where(eq(events.id, eventId));
  }
}
