/**
 * Repo GitHub đang nổi (github-theo-doi.html, quyết định 11/10/2026): hai nguồn PHÁT HIỆN repo.
 *
 *   github_new_repos  Search API: repo tạo trong N ngày đã có nhiều sao. Có luật lọc rác (6A).
 *   github_trending   Trang github.com/trending (HTML). robots.txt của GitHub cấm `?since=…`
 *                     (đọc 13/10/2026), nên chỉ đọc `/trending`, tức bảng theo ngày.
 *
 * Mỗi repo là một tài liệu: `external_id` = `owner/repo`, `url` = trang repo. Repo cũng được đăng
 * trên HN thì tự vào cùng sự kiện nhờ trùng URL. README không lấy ở đây: job `pages` tải trang repo
 * (`articleUrl`) như với link của bài HN, job process embed mô tả cùng phần chữ của README.
 *
 * `published_at` để trống: với repo, "mới" là lúc radard thấy nó nổi, không phải ngày tạo repo
 * (repo tạo 5 ngày trước, hôm nay mới đủ sao, vẫn là tin của hôm nay). Lần sau thấy lại cùng repo
 * thì không thêm tài liệu, nên một repo chỉ vào điểm tin một lần.
 */
import type { HttpClient, RawItem, RepoObservation, Signals, SourceAdapter } from "@radard/core";
import { parseHTML } from "linkedom";

const API = "https://api.github.com";
const TRENDING_URL = "https://github.com/trending";

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

export const repoUrl = (fullName: string) => `https://github.com/${fullName}`;

const repoTitle = (fullName: string, description: string | null | undefined) =>
  description?.trim() ? `${fullName}: ${description.trim()}` : fullName;

/**
 * Dấu hiệu rác (github-theo-doi.html tab 04, 11/10/2026: 11/60 repo mới khớp): chỉ có README
 * (dưới 10 KB), không ai fork, mà đã 300 sao trở lên, tức sao bị bơm. Vẫn lưu, nhưng
 * `meta.suspicious` để không vào điểm tin. `size` của GitHub tính bằng KB.
 */
export function isSuspicious(r: { size: number; forks: number; stars: number }): boolean {
  return r.size < 10 && r.forks === 0 && r.stars >= 300;
}

function readmeText(body: string, title: string | null): string {
  const r = JSON.parse(body) as {
    description?: string | null;
    topics?: string[];
    language?: string | null;
  };
  return [title, r.description, r.topics?.join(", "), r.language]
    .filter((x): x is string => Boolean(x?.trim()))
    .join("\n");
}

const ageDays = (createdAt: string, now: number) =>
  Math.max(1, (now - new Date(createdAt).getTime()) / 86_400_000);

// ---------------------------------------------------------------------------------------------
// github_new_repos

export interface NewReposConfig {
  /** Repo tạo trong chừng này ngày. */
  createdDays?: number;
  /** Ít nhất chừng này sao mới tính là "nổi". */
  minStars?: number;
  /** Lấy tối đa chừng này repo nhiều sao nhất mỗi lượt (100 mỗi trang Search API). */
  maxRepos?: number;
}

interface SearchRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  fork: boolean;
  created_at: string;
  size: number;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  topics?: string[];
  archived?: boolean;
}

export function newRepoToItem(r: SearchRepo): RawItem {
  const suspicious = isSuspicious({
    size: r.size,
    forks: r.forks_count,
    stars: r.stargazers_count,
  });
  return {
    externalId: r.full_name,
    url: repoUrl(r.full_name),
    title: repoTitle(r.full_name, r.description),
    body: JSON.stringify(r),
    contentType: "application/json",
    meta: {
      stars: r.stargazers_count,
      forks: r.forks_count,
      sizeKb: r.size,
      language: r.language,
      createdAt: r.created_at,
      ...(suspicious ? { suspicious: true } : {}),
    },
  };
}

/** Số sao mới nhất và tuổi repo, một request mỗi repo (chỉ gọi cho repo đã qua cổng chủ đề). */
async function repoSignals(externalIds: string[], http: HttpClient): Promise<Map<string, Signals>> {
  const out = new Map<string, Signals>();
  const now = Date.now();
  for (const id of externalIds) {
    try {
      const r = JSON.parse(
        (await http.get(`${API}/repos/${id}`, { headers: apiHeaders() })).body,
      ) as {
        stargazers_count: number;
        created_at: string;
      };
      out.set(id, { gh_stars: r.stargazers_count, gh_age_days: ageDays(r.created_at, now) });
    } catch {
      // Repo bị xoá hay đổi tên: vắng mặt, công thức dùng độ nổi trung tính.
    }
  }
  return out;
}

export const githubNewReposSource: SourceAdapter<NewReposConfig, Record<string, never>> = {
  kind: "github_new_repos",
  async fetch({ config, http, now }) {
    const days = config.createdDays ?? 7;
    const max = config.maxRepos ?? 100;
    const since = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
    const q = `created:>${since} stars:>${config.minStars ?? 50} fork:false`;
    const items: RawItem[] = [];
    for (let page = 1; items.length < max; page++) {
      const perPage = Math.min(100, max - items.length);
      const url = `${API}/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}&page=${page}`;
      const res = JSON.parse((await http.get(url, { headers: apiHeaders() })).body) as {
        items: SearchRepo[];
      };
      for (const r of res.items) if (!r.archived) items.push(newRepoToItem(r));
      if (res.items.length < perPage) break;
    }
    return { items, state: {}, httpStatus: 200 };
  },
  toText: readmeText,
  refreshSignals: repoSignals,
  /**
   * Sao tăng trong 24 giờ do radard tự đo (`repo_stats`) nếu đã có; chưa có thì sao mỗi ngày kể từ
   * khi tạo: repo mới nên tổng sao chia tuổi gần đúng tốc độ hiện tại. Hai cách cùng đơn vị sao/ngày.
   */
  engagement(s) {
    const gain = measuredGain(s);
    if (gain !== null) return gain;
    if (s.gh_stars === undefined) return null;
    return s.gh_stars / Math.max(1, s.gh_age_days ?? 1);
  },
  articleUrl: (_id, url) => url,
};

// ---------------------------------------------------------------------------------------------
// github_trending

export interface TrendingRepo {
  fullName: string;
  description: string | null;
  language: string | null;
  stars: number;
  /** `null`: dòng không có link fork (repo chưa ai fork thì GitHub có thể ẩn). */
  forks: number | null;
  starsToday: number;
  /** HTML gốc của dòng trên trang Trending: parser đổi thì đọc lại được. */
  html: string;
}

const num = (text: string | null | undefined) => Number((text ?? "").replace(/[^\d]/g, ""));

/**
 * Đọc trang Trending. Kiểm tra hợp lý mỗi lượt (github-theo-doi.html tab 02: go-trending từng
 * đọc nhầm tổng sao thành "stars today" mà không báo lỗi): có ít nhất một repo, repo nào cũng có
 * "N stars today", và số đó không quá tổng sao. Sai thì ném lỗi, không lưu dữ liệu sai.
 */
export function parseTrending(html: string): TrendingRepo[] {
  const { document } = parseHTML(html);
  const rows = [...document.querySelectorAll("article.Box-row")];
  const repos = rows.map((row) => {
    const href = row.querySelector("h2 a")?.getAttribute("href") ?? "";
    const today = /([\d,]+)\s+stars?\s+today/i.exec(row.textContent ?? "")?.[1];
    const forks = row.querySelector('a[href$="/forks"]')?.textContent;
    return {
      fullName: href.replace(/^\//, "").trim(),
      description: row.querySelector("p")?.textContent?.replace(/\s+/g, " ").trim() || null,
      language: row.querySelector('[itemprop="programmingLanguage"]')?.textContent?.trim() || null,
      stars: num(row.querySelector('a[href$="/stargazers"]')?.textContent),
      forks: forks?.trim() ? num(forks) : null,
      starsToday: today === undefined ? Number.NaN : num(today),
      html: row.outerHTML,
    };
  });
  if (repos.length === 0) throw new Error("trang Trending không có repo nào (HTML đổi?)");
  for (const r of repos) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(r.fullName))
      throw new Error(`Trending: tên repo lạ "${r.fullName}"`);
    if (!Number.isFinite(r.starsToday))
      throw new Error(`Trending: ${r.fullName} thiếu "stars today"`);
    if (r.starsToday > r.stars)
      throw new Error(`Trending: ${r.fullName} tăng ${r.starsToday} > tổng ${r.stars} sao`);
  }
  return repos;
}

export function trendingToItem(r: TrendingRepo): RawItem {
  return {
    externalId: r.fullName,
    url: repoUrl(r.fullName),
    title: repoTitle(r.fullName, r.description),
    body: JSON.stringify({
      full_name: r.fullName,
      description: r.description,
      language: r.language,
      stars: r.stars,
      stars_today: r.starsToday,
      html: r.html,
    }),
    contentType: "application/json",
    meta: { stars: r.stars, starsToday: r.starsToday, language: r.language },
  };
}

async function getTrending(http: HttpClient): Promise<TrendingRepo[]> {
  return parseTrending((await http.get(TRENDING_URL, { headers: { accept: "text/html" } })).body);
}

/**
 * Một lần đo cho mỗi repo trên trang, kể cả repo đã là tài liệu từ trước (fetch không thêm tài liệu
 * cho chúng, nhưng số đo hôm nay vẫn cần). Ghi lúc fetch chứ không ở `refreshSignals`: fetch chạy
 * đúng một lần mỗi ngày theo lịch và thấy cả trang, còn `refreshSignals` chỉ chạy lúc xếp hạng, cho
 * vài tài liệu ứng viên, và không có DB.
 */
export function trendingToStats(r: TrendingRepo): RepoObservation {
  return {
    repo: r.fullName,
    stars: r.stars,
    forks: r.forks,
    source: "trending_daily",
    reportedGain: r.starsToday,
  };
}

export const githubTrendingSource: SourceAdapter<Record<string, never>, Record<string, never>> = {
  kind: "github_trending",
  async fetch({ http }) {
    const repos = await getTrending(http);
    return {
      items: repos.map(trendingToItem),
      repoStats: repos.map(trendingToStats),
      state: {},
      httpStatus: 200,
    };
  },
  toText: readmeText,
  /** Đọc lại trang Trending (1 request): repo còn trên trang thì có số sao tăng hôm nay mới nhất. */
  async refreshSignals(externalIds, http) {
    const wanted = new Set(externalIds);
    const out = new Map<string, Signals>();
    for (const r of await getTrending(http)) {
      if (wanted.has(r.fullName)) out.set(r.fullName, { gh_stars_today: r.starsToday });
    }
    return out;
  },
  /** Sao tăng 24 giờ tự đo nếu đã có, không thì số GitHub báo ("N stars today"). */
  engagement: (s) => measuredGain(s) ?? s.gh_stars_today ?? null,
  articleUrl: (_id, url) => url,
};

// ---------------------------------------------------------------------------------------------
// Chụp số sao (job repo_stats)

/**
 * Tín hiệu `gh_gain_24h` (và `gh_accel_24h`) không do adapter lấy mà do job signals tính từ
 * `repo_stats` (xem `repoStatsSignals` trong jobs/repo-stats.ts): adapter không có DB. Số âm (bị bỏ
 * sao) tính là 0, vì độ nổi phải cộng được và không âm.
 */
function measuredGain(s: Signals): number | null {
  return s.gh_gain_24h === undefined ? null : Math.max(0, s.gh_gain_24h);
}

const GRAPHQL_URL = `${API}/graphql`;
const REPO_NAME = /^([\w.-]+)\/([\w.-]+)$/;

export interface StarCount {
  stars: number;
  forks: number;
}

/**
 * Số sao và fork hiện tại của nhiều repo qua GraphQL API: mỗi request một truy vấn có bí danh
 * (`r0: repository(owner:, name:) {…}`) cho tối đa `batchSize` repo, nên ~1.800 repo chỉ tốn ~18
 * request (github-theo-doi.html tab 06). Cần `GITHUB_TOKEN`: GraphQL không cho gọi ẩn danh.
 *
 * Repo bị xoá hay đổi tên thì GraphQL trả `null` cho bí danh đó kèm một mục trong `errors`: vắng
 * mặt trong kết quả, không làm hỏng cả lô. Lô không có `data` (token sai, truy vấn hỏng) thì ném lỗi.
 */
export async function fetchStarCounts(
  repos: string[],
  http: HttpClient,
  batchSize = 100,
): Promise<Map<string, StarCount>> {
  const out = new Map<string, StarCount>();
  const valid = repos.filter((r) => REPO_NAME.test(r));
  for (let i = 0; i < valid.length; i += batchSize) {
    const batch = valid.slice(i, i + batchSize);
    const fields = batch.map((r, j) => {
      const [, owner, name] = REPO_NAME.exec(r) ?? [];
      // Chuỗi JSON cũng là chuỗi GraphQL hợp lệ, nên JSON.stringify đủ để escape.
      return `r${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { stargazerCount forkCount }`;
    });
    const res = await http.post(GRAPHQL_URL, JSON.stringify({ query: `{ ${fields.join(" ")} }` }), {
      headers: { ...apiHeaders(), "content-type": "application/json" },
    });
    const body = JSON.parse(res.body) as {
      data?: Record<string, { stargazerCount: number; forkCount: number } | null> | null;
      errors?: { message: string }[];
    };
    if (!body.data) {
      throw new Error(
        `GraphQL: ${body.errors?.map((e) => e.message).join("; ") ?? "không có data"}`,
      );
    }
    for (const [j, r] of batch.entries()) {
      const hit = body.data[`r${j}`];
      if (hit) out.set(r, { stars: hit.stargazerCount, forks: hit.forkCount });
    }
  }
  return out;
}
