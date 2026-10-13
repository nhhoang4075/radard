/**
 * Danh bạ adapter nguồn theo `sources.kind`. Thêm một kiểu nguồn = viết một file adapter
 * và thêm một dòng ở đây; job `fetch` không cần sửa.
 */
import type { SourceAdapter } from "@radard/core";
import { arxivSource } from "./arxiv.ts";
import { githubSource } from "./github.ts";
import { hnSource } from "./hn.ts";

const registry = new Map<string, SourceAdapter>(
  [hnSource, arxivSource, githubSource].map((a) => [a.kind, a as SourceAdapter]),
);

export function adapterFor(kind: string): SourceAdapter {
  const adapter = registry.get(kind);
  if (!adapter) throw new Error(`chưa có adapter cho nguồn kiểu "${kind}"`);
  return adapter;
}

/**
 * Host có luật tốc độ riêng. arXiv ghi rõ trong hướng dẫn API: không quá một request mỗi
 * 3 giây.
 */
export const HOST_INTERVALS_MS: Record<string, number> = { "export.arxiv.org": 3000 };

/**
 * Bối cảnh TẠM của người dùng, chỉ dùng trong prompt digest (câu "vì sao đáng chú ý với bạn"),
 * không dùng để lọc: lọc theo chủ đề (`topics`). Thay bằng `bun run cli profile set "…"`.
 */
export const DEFAULT_PROFILE = [
  "AI engineering news and research: large language models, AI agents and agent frameworks,",
  "Model Context Protocol (MCP), retrieval-augmented generation, embeddings and vector search,",
  "new model releases, LLM evaluation and benchmarks, inference and serving, prompt engineering,",
  "developer tools for building AI applications with TypeScript, Bun, Postgres and pgvector.",
].join(" ");

/**
 * Nguồn mặc định của MVP-0. `seed` chỉ thêm nguồn chưa có, không ghi đè cấu hình bạn đã sửa.
 * `trustScore` là uy tín nguồn (A) trong điểm digest: HN 0,6, arXiv 0,6, releases 0,8.
 */
export const DEFAULT_SOURCES = [
  {
    kind: "hn",
    name: "Hacker News",
    cadence: "*/15 * * * *",
    config: { backfillHours: 24 },
    defaultRole: "community",
    // Uy tín nguồn = thành phần A của điểm digest (xep-hang.html tab 02).
    trustScore: 0.6,
  },
  {
    kind: "arxiv",
    name: "arXiv cs.CL/AI/LG/MA",
    // arXiv công bố đợt mới khoảng 20:00 giờ New York (00:00–01:00 UTC), Chủ nhật tới thứ Năm.
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
    // Danh sách TẠM theo stack đang dùng; sửa trong bảng `sources` (cột config) cho đúng ý bạn.
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
      // Mỗi phiên bản là một sự kiện riêng.
      vectorJoin: false,
    },
    defaultRole: "technical",
    trustScore: 0.8,
  },
];
