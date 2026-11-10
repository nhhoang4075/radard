/**
 * Job `process`: phần xử lý của MVP-0. Ba pha độc lập, mỗi pha tự tìm việc còn thiếu, nên chạy
 * lại, dừng giữa chừng hay đổi chủ đề rồi chạy lại đều an toàn:
 *
 *   A. Tài liệu chưa có `doc_text` → rút văn bản, đoán ngôn ngữ, embed. Tài liệu có trang nội
 *      dung riêng (bài HN link sang blog, GitHub…) đợi job `pages` tải trang, tối đa
 *      `PAGE_WAIT_MS`, rồi embed tiêu đề cùng phần chữ chính của trang.
 *   S. Cặp (tài liệu, chủ đề đang bật) chưa có điểm → cosine, ghi `doc_topic_scores` (SQL thuần),
 *      bằng vector có nội dung trang (`content_embedding`) nếu có.
 *   B. Tài liệu chưa thuộc sự kiện nào → gộp: cùng URL trước, rồi theo vector của bản thô
 *      (`embedding`, không có nội dung trang: ngưỡng 0,9 được chỉnh trên vector này). Vùng xám
 *      0,85–0,9 thì hỏi model quyết định "có cùng một tin không" (`DECISION_JOIN_LOW`).
 *
 * Pha A và B KHÔNG đọc hồ sơ người dùng (quyết định D4, 12/10/2026): mọi tài liệu được embed
 * và gộp. Hồ sơ chỉ dùng để chấm điểm (pha S) và để chọn tin ở digest. Trước 12/10, pha B chỉ
 * gộp tài liệu có cosine ≥ 0,58 với một mô tả TẠM, nên pipeline có hai cổng liên quan rời nhau.
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

/** Embedding model có giới hạn đầu vào; phần đầu văn bản đủ nói tài liệu về gì. */
const MAX_TEXT_CHARS = 4000;
/**
 * Phần chữ của trang được link tới đưa vào embed: cỡ một abstract arXiv (~1.500 ký tự), để tài
 * liệu HN và arXiv được embed từ lượng chữ tương đương.
 */
const PAGE_TEXT_CHARS = 1500;

/**
 * Vùng xám của gộp theo vector: cosine tới tâm sự kiện gần nhất trong [0,85; `thresholds.join`)
 * thì hỏi model quyết định "hai tin có cùng một chuyện không". Đo 13–16/10/2026 trên dữ liệu thật:
 * 42% cặp có cosine 0,85–0,9 là cùng một tin, nên cả ngưỡng 0,9 lẫn hạ ngưỡng đều sai nhiều;
 * trong vùng này cosine gần như không phân biệt được (AUC 0,57), Jev thì phân biệt gần hết (AUC
 * 0,99, khớp nhãn tham chiếu 97% ở ngưỡng 0,5; bạn xác nhận 14/14 nhãn tham chiếu).
 */
export const DECISION_JOIN_LOW = 0.85;
/** Xác suất "cùng một tin" tối thiểu để gộp (ngưỡng đã đo, xem `DECISION_JOIN_LOW`). */
export const DECISION_JOIN_MIN_P = 0.5;
/** Câu hỏi đúng như lúc đo (thử nghiệm A, 13–16/10/2026). */
export const SAME_STORY_QUESTION =
  "Do these two items report the same news story or announcement (not merely the same topic)?";
/** Trích đoạn mỗi tin đưa cho model: 400 ký tự đầu của văn bản đã embed, như lúc đo. */
const DECISION_EXCERPT_CHARS = 400;

export interface Thresholds {
  /** Cosine tối thiểu tới tâm cụm để gộp vào sự kiện có sẵn: "cùng một chuyện". */
  join: number;
  /** Chỉ so với sự kiện hoạt động trong chừng này ngày quanh thời điểm tài liệu. */
  windowDays: number;
}

export interface ProcessDeps {
  db: Database;
  store: ObjectStore;
  embedder: EmbeddingProvider;
  /** Viết tin giả định cho chủ đề (HyDE). Không có thì chủ đề chấm bằng mô tả như trước. */
  llm?: LlmProvider | null;
  thresholds: Thresholds;
  /**
   * Model quyết định cho vùng xám của gộp theo vector. Không có (hoặc lỗi) thì gộp như trước khi
   * có nó: dưới `thresholds.join` là mở sự kiện mới. `events rebuild` mặc định không truyền vào.
   */
  decider?: DecisionProvider | null;
  /** Rút chữ chính từ HTML của trang được link tới. Không có thì chỉ embed bản thô của nguồn. */
  extractPage?: PageExtractor;
  batchSize?: number;
  /** Trần số lô embed mỗi lượt; phần còn lại để lượt sau. Không đặt thì chạy tới hết. */
  maxBatches?: number;
  /**
   * Trần số tài liệu gộp mỗi lượt. Mỗi tài liệu tốn một truy vấn tìm tâm gần nhất (~85 ms khi
   * quét ~15 nghìn sự kiện, đo 12/10/2026), nên một lượt sau thời gian tắt dài phải chia nhỏ để
   * xong trước hạn của job. Không đặt thì chạy tới hết (CLI `events rebuild`).
   */
  maxCluster?: number;
}

export interface ProcessOutcome {
  embedded: number;
  topicsEmbedded: number;
  scored: number;
  joinedByUrl: number;
  joinedByVector: number;
  /** Gộp vì model quyết định trả lời "cùng một tin" (vùng xám). */
  joinedByDecision: number;
  /** Số lần hỏi model quyết định có câu trả lời. */
  decisionsAsked: number;
  /** Số lần hỏi lỗi (coi như không cùng tin). */
  decisionsFailed: number;
  /** Số tài liệu nằm trong vùng xám mà không hỏi vì không có model quyết định. */
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
  // Pha A theo lô cho tới khi hết việc (hoặc hết trần số lô của lượt này).
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
 * Xoá mọi sự kiện rồi gộp lại từ đầu; giữ embedding và điểm chủ đề (CLI `events rebuild`). Gộp lại
 * cả lịch sử mà hỏi model quyết định cho mọi tài liệu vùng xám là ~1.700 lời gọi (đo 16/10/2026),
 * nên mặc định KHÔNG hỏi: chỉ hỏi khi `decide`.
 */
export async function rebuildEvents(
  deps: ProcessDeps,
  opts: { decide?: boolean } = {},
): Promise<ProcessOutcome> {
  await deps.db.execute(sql`truncate ${eventDocuments}, ${events}`);
  return runProcess({ ...deps, decider: opts.decide ? deps.decider : null });
}

/**
 * Văn bản để embed: adapter nguồn tự rút từ bản thô (không có thì dùng tiêu đề), cộng phần đầu
 * chữ chính của trang được link tới nếu có.
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
    // Bản thô hỏng hay kiểu nguồn không còn adapter: tiêu đề vẫn đủ để lọc và gộp.
  }
  if (pageText) text = `${text}\n\n${pageText.slice(0, PAGE_TEXT_CHARS)}`;
  return nfc(text).slice(0, MAX_TEXT_CHARS);
}

/**
 * Pha S: chấm mọi cặp (tài liệu, chủ đề có embedding) còn thiếu điểm, bằng một câu SQL: cosine trên
 * vector đã có, không gọi model. Chấm với MỌI chủ đề (thư viện và tự thêm, bật hay chưa bật), để điểm
 * không phụ thuộc người dùng đang bật gì (D4). Chỉ ghép vector cùng model embedding. Trả về số điểm
 * mới ghi.
 */
export async function scoreTopics(db: Database, embeddingModel: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    with ins as (
      insert into doc_topic_scores (document_id, topic_id, score)
      -- Chấm bằng vector có nội dung trang nếu có (xem doc_text.content_embedding).
      -- Điểm là cosine lớn nhất trong vector mô tả và các tin giả định của chủ đề (topic_examples).
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
  // Đang đợi trang: nguồn có trang nội dung, job pages chưa xét URL này, tài liệu còn mới.
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

  // Hai văn bản mỗi tài liệu có trang: bản thô (để gộp sự kiện) và bản thô + trang (để chấm chủ
  // đề). Embed chung một request.
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

/** Tài liệu chờ gộp, đủ để tìm sự kiện và để hỏi model quyết định. */
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
      // `sources.config.vectorJoin = false`: không gộp theo vector, chỉ theo cùng URL. Dùng cho
      // GitHub releases: Bun 1.4.1 và 1.4.2 gần như trùng vector nhưng là hai lần phát hành.
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
        // Vector của hai model khác nhau không so được với nhau. Đổi model thì chạy
        // `bun run cli reprocess --all` để tính lại toàn bộ dữ liệu dẫn xuất.
        eq(docText.embeddingModel, embedder.model),
      ),
    )
    // Cũ trước mới sau: sự kiện được mở bởi tài liệu xuất hiện sớm nhất.
    .orderBy(sql`coalesce(${documents.publishedAt}, ${documents.fetchedAt})`, asc(documents.id))
    .limit(deps.maxCluster ?? 1_000_000_000);

  for (const doc of pending) await clusterOne(deps, doc, out);
}

/** Gộp một tài liệu: cùng URL, rồi sự kiện gần nhất theo vector (vùng xám thì hỏi), không thì mở mới. */
async function clusterOne(deps: ProcessDeps, doc: PendingDoc, out: ProcessOutcome) {
  const { db } = deps;
  // 1) Cùng một bài (url_canonical) đã nằm trong sự kiện nào đó: vào đúng sự kiện đó.
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

  // 2) Sự kiện gần nhất theo vector, trong cửa sổ thời gian quanh tài liệu. Từ ngưỡng (0,9) thì
  //    gộp; vùng xám 0,85–0,9 thì hỏi model quyết định.
  const near = doc.vectorJoin ? await nearestEvent(deps, doc) : undefined;
  const similarity = near ? 1 - Number(near.distance) : -1;
  const how = near ? await joinReason(deps, doc, near.id, similarity, out) : null;
  if (near && how) {
    await db
      .update(events)
      .set({
        // Trọng số là số vector trong tâm, không phải nDocs (xem `events.nVectors`).
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

  // 3) Không khớp gì: mở sự kiện mới.
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
 * Có gộp vào sự kiện gần nhất không, và vì sao: `vector` (từ ngưỡng), `decision` (vùng xám, model
 * quyết định trả lời cùng một tin), `null` (mở sự kiện mới). Hỏi lỗi thì coi như không gộp: không
 * bao giờ làm hỏng lượt process.
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
 * Hỏi "hai tin có cùng một chuyện không": `item_a` là tài liệu mới, `item_b` là tài liệu của sự
 * kiện giống nó nhất (theo vector bản thô). Trả xác suất "có"; `null` khi sự kiện không còn tài
 * liệu nào có văn bản.
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
  // Cửa sổ hai phía quanh thời điểm tài liệu: sự kiện phải còn hoạt động sau `from` và đã bắt
  // đầu trước `to`. Chỉ có cận dưới thì một bài cũ đến muộn (arXiv lấy về sau vài ngày) có thể
  // gộp vào sự kiện của nhiều tuần sau.
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
 * Nới khoảng thời gian của sự kiện để chứa `at`. Tài liệu không đến theo thứ tự thời gian
 * (bài cũ có thể được lấy về muộn), nên phải cập nhật cả hai đầu.
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
    // Gộp vì cùng bài: không đổi tâm cụm (cùng nội dung) nên cũng không tăng `nVectors`;
    // chỉ đếm thêm tài liệu và kéo dài thời gian.
    await db
      .update(events)
      .set({
        nDocs: sql`${events.nDocs} + 1`,
        ...widenSpan(doc.at),
      })
      .where(eq(events.id, eventId));
  }
}
