/**
 * GitHub releases of a list of repos, via the REST API.
 *
 * One request per repo, sending `If-None-Match` with the last ETag: a repo with nothing new gets an empty
 * 304 from GitHub. With `GITHUB_TOKEN`, a 304 is not charged against the quota (the quota is 5,000
 * instead of 60 requests per hour); without a token it still works for a few dozen repos per hour.
 */
import { type HttpClient, HttpError, type RawItem, type SourceAdapter } from "@radard/core";

export interface GithubConfig {
  /** `owner/repo` form. */
  repos: string[];
  /** Number of latest releases read per repo; older releases were already stored by an earlier run. */
  perRepo?: number;
}

export interface GithubState {
  /** Last ETag of each repo. */
  etags: Record<string, string>;
  /** Repos that returned 404 in the most recent run (renamed or deleted): shown so you can fix the list. */
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
    // `name` is often empty; in that case the tag is the version name.
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
 * One repo, one request. A 404 (renamed, deleted) returns `missing` so the other repos still run; other errors
 * (network, 5xx, quota exhausted) are thrown so pg-boss retries the whole run.
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

/** Release notes can be very long (changelogs of thousands of lines); the first part should say what it is. */
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
