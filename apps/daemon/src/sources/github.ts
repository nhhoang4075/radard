/**
 * GitHub releases của một danh sách repo, qua REST API.
 *
 * Mỗi repo một request, có `If-None-Match` theo ETag lần trước: repo không có gì mới thì
 * GitHub trả 304 rỗng. Có `GITHUB_TOKEN` thì 304 không bị trừ quota (và quota là 5.000
 * thay vì 60 request/giờ); không có token vẫn chạy được với vài chục repo mỗi giờ.
 */
import { type HttpClient, HttpError, type RawItem, type SourceAdapter } from "@radard/core";

export interface GithubConfig {
  /** Dạng `owner/repo`. */
  repos: string[];
  /** Số release mới nhất đọc mỗi repo; release cũ hơn đã có từ lần trước. */
  perRepo?: number;
}

export interface GithubState {
  /** ETag lần trước của từng repo. */
  etags: Record<string, string>;
  /** Repo trả 404 ở lượt gần nhất (đổi tên, xoá): hiện ra để bạn sửa danh sách. */
  missingRepos?: string[];
}

interface Release {
  id: number;
  tag_name: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  html_url: string;
  author?: { login: string } | null;
  body?: string | null;
}

export function releaseToItem(repo: string, r: Release): RawItem {
  return {
    externalId: String(r.id),
    url: r.html_url,
    // `name` hay để trống; khi đó tag chính là tên phiên bản.
    title: `${repo} ${r.name?.trim() || r.tag_name}`,
    publishedAt: r.published_at ? new Date(r.published_at) : undefined,
    body: JSON.stringify(r),
    contentType: "application/json",
    meta: { repo, tag: r.tag_name, prerelease: r.prerelease, author: r.author?.login },
  };
}

type RepoResult =
  | { kind: "changed"; releases: Release[]; etag?: string }
  | { kind: "unchanged" }
  | { kind: "missing" };

/**
 * Một repo, một request. 404 (đổi tên, xoá) trả `missing` để các repo khác vẫn chạy; lỗi
 * khác (mạng, 5xx, hết quota) ném ra để pg-boss thử lại cả lượt.
 */
async function fetchRepo(
  http: HttpClient,
  repo: string,
  etag: string | undefined,
  perRepo: number,
): Promise<RepoResult> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const url = `https://api.github.com/repos/${repo}/releases?per_page=${perRepo}`;
    const res = await http.get(url, { etag, headers });
    if (res.status === 304) return { kind: "unchanged" };
    return { kind: "changed", releases: JSON.parse(res.body) as Release[], etag: res.etag };
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return { kind: "missing" };
    throw err;
  }
}

/** Ghi chú phát hành có thể rất dài (changelog cả nghìn dòng); phần đầu đủ nói nó là gì. */
const RELEASE_NOTES_CHARS = 1500;

export const githubSource: SourceAdapter<GithubConfig, GithubState> = {
  kind: "github",
  toText(body, title) {
    const r = JSON.parse(body) as Release;
    const notes = (r.body ?? "").replace(/\s+/g, " ").trim().slice(0, RELEASE_NOTES_CHARS);
    return [title ?? r.tag_name, notes].filter(Boolean).join("\n");
  },
  async fetch({ config, state, http }) {
    const etags: Record<string, string> = { ...state?.etags };
    const items: RawItem[] = [];
    const missing: string[] = [];
    let changed = 0;

    for (const repo of config.repos) {
      const res = await fetchRepo(http, repo, etags[repo], config.perRepo ?? 10);
      if (res.kind === "missing") missing.push(repo);
      if (res.kind !== "changed") continue;
      changed++;
      if (res.etag) etags[repo] = res.etag;
      for (const r of res.releases) if (!r.draft) items.push(releaseToItem(repo, r));
    }
    return {
      items,
      state: missing.length ? { etags, missingRepos: missing } : { etags },
      notModified: changed === 0 && missing.length === 0,
      httpStatus: changed === 0 ? 304 : 200,
    };
  },
};
