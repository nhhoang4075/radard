/**
 * Job `pages`: tải trang mà tài liệu link tới (`SourceAdapter.articleUrl`), lưu HTML gốc vào
 * ObjectStore và một dòng `linked_pages`. Job process đợi dòng này (tối đa `PAGE_WAIT_MS`) rồi mới
 * embed, để embed tiêu đề CÙNG nội dung trang thay vì chỉ tiêu đề.
 *
 * Lý do (13/10/2026): 91,5% bài HN chỉ có tiêu đề trong bản thô, nên embedding đoán chủ đề từ
 * 10–15 chữ (Janas "streaming experts from SSD" bị gán RAG), và tin có tiêu đề mơ hồ bị bỏ sót.
 *
 * Mỗi URL chỉ xét một lần, kể cả khi lỗi: trang trả phí hay chặn bot thì lần sau vẫn vậy.
 */
import { createLogger, type ObjectStore, type PageFetcher, rawKey, sha256 } from "@radard/core";
import { type Database, linkedPages, sources } from "@radard/db";
import { sql } from "drizzle-orm";
import { adapterFor } from "../sources/index.ts";

const log = createLogger("pages");

/** Job process đợi trang tối đa chừng này kể từ lúc lấy tài liệu, rồi embed bằng tiêu đề. */
export const PAGE_WAIT_MS = 30 * 60_000;

export interface PagesDeps {
  db: Database;
  store: ObjectStore;
  fetcher: PageFetcher;
}

export interface PagesOutcome {
  considered: number;
  ok: number;
  blocked: number;
  skipped: number;
  failed: number;
  /** robots.txt không đọc được: không ghi dòng nào, lần chạy sau thử lại. */
  deferred: number;
}

/** Kiểu nguồn có trang nội dung riêng (adapter khai báo `articleUrl`). */
export async function articleKinds(db: Database): Promise<string[]> {
  const kinds = new Set((await db.select({ kind: sources.kind }).from(sources)).map((s) => s.kind));
  return [...kinds].filter((k) => {
    try {
      return Boolean(adapterFor(k).articleUrl);
    } catch {
      return false;
    }
  });
}

/** Tải trang cho các tài liệu đăng từ `since` chưa có dòng `linked_pages`, mới trước cũ sau. */
export async function fetchPages(
  deps: PagesDeps,
  opts: { since: Date; limit?: number; concurrency?: number },
): Promise<PagesOutcome> {
  const out: PagesOutcome = {
    considered: 0,
    ok: 0,
    blocked: 0,
    skipped: 0,
    failed: 0,
    deferred: 0,
  };
  const kinds = await articleKinds(deps.db);
  if (kinds.length === 0) return out;
  const kindList = sql.join(
    kinds.map((k) => sql`${k}`),
    sql`, `,
  );
  type Row = { url_canonical: string; url: string; external_id: string; kind: string };
  const rows = [
    ...(await deps.db.execute<{
      url_canonical: string;
      url: string;
      external_id: string;
      kind: string;
    }>(sql`
      select * from (
        select distinct on (d.url_canonical) d.url_canonical, d.url, d.external_id, s.kind,
               coalesce(d.published_at, d.fetched_at) as at
        from documents d
        join sources s on s.id = d.source_id
        left join linked_pages lp on lp.url_canonical = d.url_canonical
        where s.kind in (${kindList}) and lp.id is null
          and coalesce(d.published_at, d.fetched_at) >= ${opts.since}
        order by d.url_canonical, d.id
      ) x
      order by at desc
      limit ${opts.limit ?? 300}`)),
  ] as Row[];
  out.considered = rows.length;

  const queue = [...rows];
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const status = await fetchOne(deps, r);
      out[status]++;
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 8 }, worker));
  if (out.considered)
    log.info("tải trang xong", { ...out, robotsCache: deps.fetcher.robotsCacheSize?.() });
  return out;
}

async function fetchOne(
  deps: PagesDeps,
  r: { url_canonical: string; url: string; external_id: string; kind: string },
): Promise<"ok" | "blocked" | "skipped" | "failed" | "deferred"> {
  let target: string | null = null;
  try {
    target = adapterFor(r.kind).articleUrl?.(r.external_id, r.url) ?? null;
  } catch {
    target = null;
  }
  if (!target) {
    await deps.db
      .insert(linkedPages)
      .values({
        urlCanonical: r.url_canonical,
        url: r.url,
        status: "skipped",
        error: "không có trang ngoài",
      })
      .onConflictDoNothing();
    return "skipped";
  }

  const res = await deps.fetcher.fetch(target);
  // Hoãn: không ghi `linked_pages` để câu truy vấn (URL chưa có dòng) chọn lại ở lần chạy sau.
  if (res.status === "deferred") return "deferred";
  let key: string | null = null;
  let sha: string | null = null;
  if (res.status === "ok" && res.html !== undefined) {
    const bytes = new TextEncoder().encode(res.html.normalize("NFC"));
    sha = sha256(bytes);
    key = rawKey(sha);
    await deps.store.put(key, bytes, res.contentType || "text/html");
  }
  await deps.db
    .insert(linkedPages)
    .values({
      urlCanonical: r.url_canonical,
      url: target,
      finalUrl: res.finalUrl ?? null,
      status: key ? "ok" : res.status === "ok" ? "failed" : res.status,
      httpStatus: res.httpStatus ?? null,
      contentType: res.contentType ?? null,
      contentSha256: sha,
      rawKey: key,
      error: res.error?.slice(0, 500) ?? null,
    })
    .onConflictDoNothing();
  return key ? "ok" : res.status === "ok" ? "failed" : res.status;
}
