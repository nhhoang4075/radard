/**
 * `pages` job: fetches the pages that documents link to (`SourceAdapter.articleUrl`), stores the original HTML in
 * ObjectStore and one `linked_pages` row. The process job waits for this row (up to `PAGE_WAIT_MS`) before
 * embedding, so it embeds the title TOGETHER WITH the page content, not the title alone.
 *
 * Reason (13/10/2026): 91,5% of HN stories have only a title in the raw copy, so embedding guessed the topic from
 * 10–15 words (Janas "streaming experts from SSD" was tagged RAG), and stories with vague titles were missed.
 *
 * Each URL is checked only once, even on error: a paywalled or bot-blocking page stays that way on later runs.
 */
import { createLogger, type ObjectStore, type PageFetcher, rawKey, sha256 } from "@radard/core";
import { type Database, linkedPages, sources } from "@radard/db";
import { sql } from "drizzle-orm";
import { adapterFor } from "../sources/index.ts";

const log = createLogger("pages");

/** The process job waits for pages at most this long from the time the document was fetched, then embeds with the title. */
export const PAGE_WAIT_MS = 30 * 60_000;

/**
 * Each host gets at most this many URLs in one selection pass: a host with a broken robots.txt (deferred URLs have no
 * row, so they are selected again every run) must not take the whole batch and starve older URLs of healthy hosts.
 */
const MAX_PER_HOST = 10;

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
  /** robots.txt could not be read: no row is written, the next run retries. */
  deferred: number;
}

/** Source kind that has its own content page (the adapter declares `articleUrl`). */
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

/** Fetches pages for documents posted since `since` that have no `linked_pages` row yet, newest first. */
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
      select url_canonical, url, external_id, kind, at from (
        select *, row_number() over (partition by split_part(url, '/', 3) order by at desc) as rn
        from (
          select distinct on (d.url_canonical) d.url_canonical, d.url, d.external_id, s.kind,
                 coalesce(d.published_at, d.fetched_at) as at
          from documents d
          join sources s on s.id = d.source_id
          left join linked_pages lp on lp.url_canonical = d.url_canonical
          where s.kind in (${kindList}) and lp.id is null
            and coalesce(d.published_at, d.fetched_at) >= ${opts.since}
          order by d.url_canonical, d.id
        ) x
      ) y
      where rn <= ${MAX_PER_HOST}
      order by at desc
      limit ${opts.limit ?? 300}`)),
  ] as Row[];
  out.considered = rows.length;

  const queue = [...rows];
  /** Hosts that returned `deferred` in this run: their remaining URLs are skipped, not requested again. */
  const deferredHosts = new Set<string>();
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const status = await fetchOne(deps, r, deferredHosts);
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
  deferredHosts: Set<string>,
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

  const host = hostOf(target);
  if (deferredHosts.has(host)) return "deferred";
  const res = await deps.fetcher.fetch(target);
  // Deferred: do not write `linked_pages`, so the query (URL with no row yet) selects it again in a later run.
  if (res.status === "deferred") {
    deferredHosts.add(host);
    return "deferred";
  }
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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
