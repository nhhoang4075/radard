/**
 * Directory of source adapters by `sources.kind`. To add a source type, write one adapter file
 * and add one line here; the `fetch` job needs no changes.
 */
import type { SourceAdapter } from "@radard/core";
import { arxivSource } from "./arxiv.ts";
import { githubSource } from "./github.ts";
import { githubNewReposSource, githubTrendingSource } from "./github-repos.ts";
import { hnSource } from "./hn.ts";

const registry = new Map<string, SourceAdapter>(
  [hnSource, arxivSource, githubSource, githubNewReposSource, githubTrendingSource].map((a) => [
    a.kind,
    a as SourceAdapter,
  ]),
);

export function adapterFor(kind: string): SourceAdapter {
  const adapter = registry.get(kind);
  if (!adapter) throw new Error(`chưa có adapter cho nguồn kiểu "${kind}"`);
  return adapter;
}

/**
 * Hosts with their own rate limits. arXiv states in its API guide: no more than one request every
 * 3 seconds.
 */
export const HOST_INTERVALS_MS: Record<string, number> = { "export.arxiv.org": 3000 };

/**
 * TEMPORARY per-user context, used only in the digest prompt (the sentence "why it's worth your attention"),
 * not for filtering: filtering uses topics (`topics`). Replace it with `bun run cli profile set "…"`.
 */
export const DEFAULT_PROFILE = [
  "AI engineering news and research: large language models, AI agents and agent frameworks,",
  "Model Context Protocol (MCP), retrieval-augmented generation, embeddings and vector search,",
  "new model releases, LLM evaluation and benchmarks, inference and serving, prompt engineering,",
  "developer tools for building AI applications with TypeScript, Bun, Postgres and pgvector.",
].join(" ");

/**
 * Default sources for MVP-0. `seed` adds only sources that do not exist yet, and does not overwrite configuration you have edited.
 * `trustScore` is the source's credibility (A) in the digest score: HN 0.6, arXiv 0.6, releases 0.8.
 */
export const DEFAULT_SOURCES = [
  {
    kind: "hn",
    name: "Hacker News",
    cadence: "*/15 * * * *",
    config: { backfillHours: 24 },
    defaultRole: "community",
    // Source credibility = component A of the digest score (xep-hang.html tab 02).
    trustScore: 0.6,
  },
  {
    kind: "arxiv",
    name: "arXiv cs.CL/AI/LG/MA",
    // arXiv publishes its new batch around 20:00 New York time (00:00–01:00 UTC), Sunday through Thursday.
    cadence: "30 1 * * *",
    config: {
      categories: ["cs.CL", "cs.AI", "cs.LG", "cs.MA"],
      lookbackDays: 5,
    },
    defaultRole: "technical",
    trustScore: 0.6,
  },
  {
    kind: "github",
    name: "GitHub releases",
    cadence: "0 * * * *",
    // TEMPORARY list based on the current stack; edit it in the `sources` table (config column) to match what you want.
    config: {
      repos: [
        "oven-sh/bun",
        "vercel/ai",
        "drizzle-team/drizzle-orm",
        "timgit/pg-boss",
        "pgvector/pgvector",
        "modelcontextprotocol/typescript-sdk",
        "ollama/ollama",
        "vllm-project/vllm",
        "huggingface/transformers",
        "langchain-ai/langgraph",
      ],
      // Each version is a separate event.
      vectorJoin: false,
    },
    defaultRole: "technical",
    trustScore: 0.8,
  },
  {
    kind: "github_new_repos",
    name: "GitHub repo mới",
    // 06:00 Vietnam time, before the 07:00 digest: leaves time for the pages job (README) and process.
    cadence: "0 23 * * *",
    config: { createdDays: 7, minStars: 50, maxRepos: 100, vectorJoin: false },
    defaultRole: "technical",
    // Lower than HN: both the Search API and repos with fake stars (18% on 11/10/2026) are noisy, even with the spam filter rules.
    trustScore: 0.5,
  },
  {
    kind: "github_trending",
    name: "GitHub Trending",
    cadence: "10 23 * * *",
    // Different repos with nearly identical descriptions are not the same thing: merge only by URL.
    config: { vectorJoin: false },
    defaultRole: "community",
    trustScore: 0.6,
  },
];
