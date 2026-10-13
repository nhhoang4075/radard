/**
 * Job `repo_stats`: radard tự chụp số sao của các repo GitHub đang theo dõi, mỗi ngày một lần
 * (github-theo-doi.html tab 05–06), để có sao tăng trong 24 giờ và tăng tốc, thay vì chỉ có
 * "tổng sao / tuổi" (repo mới) hay số GitHub tự báo (Trending).
 *
 *   tăng_24h(repo) = sao(lần đo mới nhất) − sao(lần đo gần nhất cách nó ≥ 20 giờ)
 *   tăng_tốc       = tăng_24h hôm nay − tăng_24h hôm qua (tính như trên, mốc là lần đo tham chiếu)
 *
 * Mọi lần đo đều tính, dù là radard tự chụp (`github_stars`) hay đọc từ trang Trending
 * (`trending_daily`, job fetch ghi): cùng một con số sao. Luật ≥ 20 giờ làm hai lần đo sát nhau
 * (Trending 06:10, tự chụp 06:20, chạy tay thêm một lần) không bao giờ thành một "ngày".
 *
 * Tập theo dõi: repo có tài liệu trong 30 ngày qua từ nguồn `github_new_repos`, `github_trending`,
 * hoặc tài liệu của nguồn khác (bài HN…) có `url_canonical` là đúng trang repo. Repo có một tài liệu
 * bị đánh dấu `meta.suspicious` (sao bị bơm) thì không chụp.
 */
import { createLogger, type HttpClient, type Signals } from "@radard/core";
import { type Database, documents, repoStats, sources } from "@radard/db";
import { and, desc, eq, gte, inArray, like, or } from "drizzle-orm";
import { fetchStarCounts } from "../sources/github-repos.ts";
import type { DocRef } from "./signals.ts";

const log = createLogger("repo_stats");

const HOUR = 3_600_000;
const TRACK_DAYS = 30;
/** Lần đo tham chiếu phải cách lần mới nhất ít nhất chừng này giờ. */
export const MIN_GAP_HOURS = 20;
/** Đã tự chụp trong chừng này giờ thì lượt sau (chạy tay, pg-boss thử lại) bỏ qua repo đó. */
const RESNAP_HOURS = 12;
/** Tín hiệu và số liệu chỉ dùng lần đo mới nhất còn trong chừng này giờ: cũ hơn là đã thôi theo dõi. */
const FRESH_HOURS = 36;
/** Đọc lần đo trong chừng này ngày: đủ cho tăng_24h và tăng_tốc kể cả khi lỡ vài ngày. */
const LOOKBACK_DAYS = 7;

const REPO_KINDS = ["github_new_repos", "github_trending"];
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const REPO_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/;
/** Trang của chính GitHub có dạng `github.com/x/y` nhưng không phải repo. */
const NOT_OWNERS = new Set([
  "orgs",
  "topics",
  "features",
  "collections",
  "sponsors",
  "marketplace",
  "settings",
  "apps",
  "trending",
  "enterprise",
  "about",
]);

/** `owner/repo` viết thường mà tài liệu này nói tới, hoặc `null` nếu không phải một repo. */
export function repoOfDoc(d: Pick<DocRef, "kind" | "externalId" | "urlCanonical">): string | null {
  if (REPO_KINDS.includes(d.kind)) {
    return REPO_NAME.test(d.externalId) ? d.externalId.toLowerCase() : null;
  }
  const name = REPO_URL.exec(d.urlCanonical)?.[1]?.toLowerCase();
  if (!name || NOT_OWNERS.has(name.split("/")[0] ?? "")) return null;
  return name;
}

export interface TrackedRepo {
  /** Ngày tạo repo (Search API), để có "sao / tuổi" khi chưa đủ hai lần đo. */
  createdAt: string | null;
}

/** Tập repo đang theo dõi, khoá là `owner/repo` viết thường. */
export async function trackedRepos(db: Database, now: Date): Promise<Map<string, TrackedRepo>> {
  const rows = await db
    .select({
      kind: sources.kind,
      externalId: documents.externalId,
      urlCanonical: documents.urlCanonical,
      meta: documents.meta,
    })
    .from(documents)
    .innerJoin(sources, eq(sources.id, documents.sourceId))
    .where(
      and(
        gte(documents.fetchedAt, new Date(now.getTime() - TRACK_DAYS * 24 * HOUR)),
        or(inArray(sources.kind, REPO_KINDS), like(documents.urlCanonical, "https://github.com/%")),
      ),
    );
  const out = new Map<string, TrackedRepo>();
  const bad = new Set<string>();
  for (const r of rows) {
    const repo = repoOfDoc(r);
    if (!repo) continue;
    const meta = r.meta as { suspicious?: boolean; createdAt?: string };
    if (meta.suspicious === true) bad.add(repo);
    const prev = out.get(repo);
    out.set(repo, { createdAt: prev?.createdAt ?? meta.createdAt ?? null });
  }
  for (const repo of bad) out.delete(repo);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tính tăng

export interface Observation {
  at: Date;
  stars: number;
  forks: number | null;
  source: string;
  reportedGain: number | null;
}

export interface Growth {
  /** `null`: chưa có lần đo nào cách lần mới nhất ≥ 20 giờ. */
  gain24h: number | null;
  /** `null`: chưa đủ ba lần đo cách nhau ≥ 20 giờ. */
  accel: number | null;
}

/** Lần đo đầu tiên (danh sách mới trước) cách `from` ít nhất `MIN_GAP_HOURS`. */
function referenceOf(obs: Observation[], from: Observation): Observation | undefined {
  const limit = from.at.getTime() - MIN_GAP_HOURS * HOUR;
  return obs.find((o) => o.at.getTime() <= limit);
}

/** Tăng 24 giờ và tăng tốc từ các lần đo của MỘT repo, theo thứ tự bất kỳ. */
export function growthOf(observations: Observation[]): Growth {
  const obs = [...observations].sort((a, b) => b.at.getTime() - a.at.getTime());
  const latest = obs[0];
  const ref = latest && referenceOf(obs, latest);
  if (!latest || !ref) return { gain24h: null, accel: null };
  const gain24h = latest.stars - ref.stars;
  const prev = referenceOf(obs, ref);
  return { gain24h, accel: prev ? gain24h - (ref.stars - prev.stars) : null };
}

/** Lần đo trong `LOOKBACK_DAYS` ngày của các repo này, mới trước. */
async function loadObservations(
  db: Database,
  repos: string[],
  now: Date,
): Promise<Map<string, Observation[]>> {
  const out = new Map<string, Observation[]>();
  if (repos.length === 0) return out;
  const rows = await db
    .select()
    .from(repoStats)
    .where(
      and(
        inArray(repoStats.repo, repos),
        gte(repoStats.observedAt, new Date(now.getTime() - LOOKBACK_DAYS * 24 * HOUR)),
      ),
    )
    .orderBy(desc(repoStats.observedAt));
  for (const r of rows) {
    const list = out.get(r.repo) ?? [];
    list.push({
      at: r.observedAt,
      stars: r.stars,
      forks: r.forks,
      source: r.source,
      reportedGain: r.reportedGain,
    });
    out.set(r.repo, list);
  }
  return out;
}

const isFresh = (o: Observation | undefined, now: Date): o is Observation =>
  o !== undefined && now.getTime() - o.at.getTime() <= FRESH_HOURS * HOUR;

// ---------------------------------------------------------------------------------------------
// Job

export interface RepoStatsDeps {
  db: Database;
  http: HttpClient;
  now?: () => Date;
  /** Số repo mỗi request GraphQL (test đặt nhỏ để thấy chia lô). */
  batchSize?: number;
}

export interface RepoStatsOutcome {
  tracked: number;
  /** Đã tự chụp trong `RESNAP_HOURS` giờ qua, lượt này bỏ qua. */
  fresh: number;
  observed: number;
  /** GitHub không trả (repo bị xoá, đổi tên, chuyển riêng tư). */
  missing: number;
  skipped?: string;
}

export async function runRepoStats(deps: RepoStatsDeps): Promise<RepoStatsOutcome> {
  const { db, http } = deps;
  const now = deps.now?.() ?? new Date();
  const tracked = [...(await trackedRepos(db, now)).keys()].sort();
  const out: RepoStatsOutcome = { tracked: tracked.length, fresh: 0, observed: 0, missing: 0 };
  if (!process.env.GITHUB_TOKEN) {
    // GraphQL không cho gọi ẩn danh: thiếu token thì mọi request đều 401, thử lại cũng vô ích.
    log.warn("bỏ qua: chưa đặt GITHUB_TOKEN", { tracked: tracked.length });
    return { ...out, skipped: "chưa đặt GITHUB_TOKEN" };
  }
  // Idempotent theo thời gian: chạy lại ngay (CLI, pg-boss thử lại sau lỗi giữa chừng) chỉ chụp
  // repo chưa được chụp gần đây, không ghi thêm lần đo trùng.
  const recent = new Set(
    tracked.length === 0
      ? []
      : (
          await db
            .selectDistinct({ repo: repoStats.repo })
            .from(repoStats)
            .where(
              and(
                eq(repoStats.source, "github_stars"),
                inArray(repoStats.repo, tracked),
                gte(repoStats.observedAt, new Date(now.getTime() - RESNAP_HOURS * HOUR)),
              ),
            )
        ).map((r) => r.repo),
  );
  const todo = tracked.filter((r) => !recent.has(r));
  out.fresh = recent.size;
  const counts = await fetchStarCounts(todo, http, deps.batchSize);
  const rows = [...counts].map(([repo, c]) => ({
    repo,
    observedAt: now,
    stars: c.stars,
    forks: c.forks,
    source: "github_stars" as const,
    reportedGain: null,
  }));
  for (let i = 0; i < rows.length; i += 1000) {
    await db.insert(repoStats).values(rows.slice(i, i + 1000));
  }
  out.observed = rows.length;
  out.missing = todo.length - rows.length;
  log.info("chụp số sao", { ...out });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Dùng số đo

/**
 * Tín hiệu tính tại chỗ cho job signals (xem `LocalSignals` trong signals.ts): tài liệu nào nói tới
 * một repo đã có ≥ 2 lần đo cách nhau ≥ 20 giờ thì có `gh_gain_24h`, và `gh_accel_24h` khi đủ ba lần.
 * Không có thì vắng mặt: `engagement` của adapter tự dùng cách tạm (sao/tuổi, "N stars today").
 */
export async function repoStatsSignals(
  db: Database,
  docs: DocRef[],
  now: Date,
): Promise<Map<number, Signals>> {
  const repoOf = new Map<number, string>();
  for (const d of docs) {
    const repo = repoOfDoc(d);
    if (repo) repoOf.set(d.id, repo);
  }
  const obs = await loadObservations(db, [...new Set(repoOf.values())], now);
  const out = new Map<number, Signals>();
  for (const [docId, repo] of repoOf) {
    const list = obs.get(repo) ?? [];
    if (!isFresh(list[0], now)) continue;
    const g = growthOf(list);
    if (g.gain24h === null) continue;
    out.set(docId, {
      gh_gain_24h: g.gain24h,
      ...(g.accel === null ? {} : { gh_accel_24h: g.accel }),
    });
  }
  return out;
}

export interface RepoRow {
  repo: string;
  stars: number | null;
  forks: number | null;
  observedAt: Date | null;
  /** Số sao tăng mỗi ngày đã dùng, theo `basis`. */
  gain24h: number | null;
  accel: number | null;
  /** measured: tự đo · reported: GitHub báo ("N stars today") · age: tổng sao / tuổi */
  basis: "measured" | "reported" | "age" | null;
}

/**
 * Tăng 24 giờ của một repo, có cách tạm khi chưa đủ hai lần đo: repo trên Trending dùng số GitHub
 * báo ở lần đọc trang gần nhất, repo mới dùng tổng sao chia tuổi.
 */
export function withFallback(
  obs: Observation[],
  createdAt: string | null,
  now: Date,
): Pick<RepoRow, "gain24h" | "accel" | "basis"> {
  const g = growthOf(obs);
  if (g.gain24h !== null) return { ...g, basis: "measured" };
  const latest = [...obs].sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  const reported = obs.find((o) => o.source === "trending_daily" && isFresh(o, now));
  if (reported?.reportedGain != null) {
    return { gain24h: reported.reportedGain, accel: null, basis: "reported" };
  }
  if (latest && createdAt) {
    const days = Math.max(1, (now.getTime() - new Date(createdAt).getTime()) / (24 * HOUR));
    return { gain24h: Math.round(latest.stars / days), accel: null, basis: "age" };
  }
  return { gain24h: null, accel: null, basis: null };
}

/** Repo đang theo dõi kèm số đo mới nhất, tăng nhiều trước (cho CLI `repos`). */
export async function listRepos(db: Database, now = new Date()): Promise<RepoRow[]> {
  const tracked = await trackedRepos(db, now);
  const obs = await loadObservations(db, [...tracked.keys()], now);
  const rows = [...tracked].map(([repo, t]): RepoRow => {
    const list = obs.get(repo) ?? [];
    const latest = list[0];
    return {
      repo,
      stars: latest?.stars ?? null,
      forks: list.find((o) => o.forks !== null)?.forks ?? null,
      observedAt: latest?.at ?? null,
      ...withFallback(list, t.createdAt, now),
    };
  });
  return rows.sort(
    (a, b) => (b.gain24h ?? -Infinity) - (a.gain24h ?? -Infinity) || a.repo.localeCompare(b.repo),
  );
}
