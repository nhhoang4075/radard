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
 *      (`embedding`, không có nội dung trang: ngưỡng 0,9 được chỉnh trên vector này).
 *
 * Pha A và B KHÔNG đọc hồ sơ người dùng (quyết định D4, 12/10/2026): mọi tài liệu được embed
 * và gộp. Hồ sơ chỉ dùng để chấm điểm (pha S) và để chọn tin ở digest. Trước 12/10, pha B chỉ
 * gộp tài liệu có cosine ≥ 0,58 với một mô tả TẠM, nên pipeline có hai cổng liên quan rời nhau.
 */
import {
  createLogger,
  type EmbeddingProvider,
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
import { embedPendingTopics } from "./topics.ts";

const log = createLogger("process");

/** Embedding model có giới hạn đầu vào; phần đầu văn bản đủ nói tài liệu về gì. */
const MAX_TEXT_CHARS = 4000;
/**
 * Phần chữ của trang được link tới đưa vào embed: cỡ một abstract arXiv (~1.500 ký tự), để tài
 * liệu HN và arXiv được embed từ lượng chữ tương đương.
 */
const PAGE_TEXT_CHARS = 1500;

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
  thresholds: Thresholds;
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
  created: number;
}

export async function runProcess(deps: ProcessDeps): Promise<ProcessOutcome> {
  const out: ProcessOutcome = {
    embedded: 0,
    topicsEmbedded: await embedPendingTopics(deps.db, deps.embedder),
    scored: 0,
    joinedByUrl: 0,
    joinedByVector: 0,
    created: 0,
  };
  // Pha A theo lô cho tới khi hết việc (hoặc hết trần số lô của lượt này).
  for (let batches = 0; batches < (deps.maxBatches ?? Infinity); batches++) {
    const n = await embedBatch(deps, out);
    if (n === 0) break;
  }
  out.scored = await scoreTopics(deps.db, deps.embedder.model);
  await clusterPending(deps, out);
  log.info("xong", { ...out });
  return out;
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
 * Pha S: chấm mọi cặp (tài liệu, chủ đề đang bật) còn thiếu điểm, bằng một câu SQL: cosine trên
 * vector đã có, không gọi model. Chỉ ghép vector cùng model embedding. Trả về số điểm mới ghi.
 */
export async function scoreTopics(db: Database, embeddingModel: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    with ins as (
      insert into doc_topic_scores (document_id, profile_topic_id, score)
      -- Chấm bằng vector có nội dung trang nếu có (xem doc_text.content_embedding).
      select dt.document_id, pt.id, 1 - (coalesce(dt.content_embedding, dt.embedding) <=> pt.embedding)
      from profile_topics pt
      join doc_text dt on dt.embedding_model = pt.embedding_model
      where pt.active and pt.embedding is not null and pt.embedding_model = ${embeddingModel}
        and not exists (
          select 1 from doc_topic_scores s
          where s.document_id = dt.document_id and s.profile_topic_id = pt.id
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

async function clusterPending(deps: ProcessDeps, out: ProcessOutcome): Promise<void> {
  const { db, embedder, thresholds } = deps;
  const pending = await db
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

  for (const doc of pending) {
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
      continue;
    }

    // 2) Sự kiện gần nhất theo vector, trong cửa sổ thời gian quanh tài liệu.
    //    Ngưỡng cao (0,9): vùng 0,8–0,9 trộn lẫn đúng và sai, chờ LLM phân xử ở MVP-1.
    const near = doc.vectorJoin ? await nearestEvent(deps, doc) : undefined;
    const similarity = near ? 1 - Number(near.distance) : -1;
    if (near && similarity >= thresholds.join) {
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
      await attach(db, near.id, doc, similarity, "vector");
      out.joinedByVector++;
      continue;
    }

    // 3) Không khớp gì: mở sự kiện mới.
    const [created] = await db
      .insert(events)
      .values({
        title: doc.title ?? doc.url,
        firstSeenAt: doc.at,
        lastSeenAt: doc.at,
        centroid: doc.embedding,
        embeddingModel: embedder.model,
      })
      .returning({ id: events.id });
    if (created) await attach(db, created.id, doc, 1, "seed");
    out.created++;
  }
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
  reason: "seed" | "url" | "vector",
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
