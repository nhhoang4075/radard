/** Fake data for the dev preview page `/_design/feed` (no sign-in needed). Typed like the real API. */
import type { FeedClient } from "../../lib/feed-client.ts";
import { todayVN } from "../../lib/format.ts";
import type { EventDetail, FeedbackState, FeedItem, FeedPage } from "./types.ts";

const T = [
  "Model AI",
  "Lập trình với AI",
  "Xây ứng dụng LLM",
  "Agent AI",
  "Trợ lý và ứng dụng AI",
  "Hạ tầng AI",
  "Truy hồi và xếp hạng",
];
const BASE: [string, string, number, number, string[]][] = [
  [
    "Meta mở trọng số Muse Spark Open, model 816B tham số",
    "Meta phát hành trọng số mở của model 816B tham số, kèm báo cáo huấn luyện.",
    0.69,
    0,
    ["research.meta.ai", "Hacker News"],
  ],
  [
    "Nemotron 3.5 Bolt 74B-A9B chạy agent cục bộ trong 24GB",
    "NVIDIA phát hành model chuyên gia thưa chạy được trên một GPU 24GB.",
    0.67,
    0,
    ["Hugging Face", "Hacker News"],
  ],
  [
    "ruflo: harness điều phối swarm cho Claude Code và Codex",
    "Repo mới giúp điều phối nhiều agent lập trình chạy song song.",
    0.64,
    1,
    ["GitHub"],
  ],
  [
    "Sinh văn bản song song bằng khuếch tán rời rạc",
    "Nghiên cứu sinh nhiều token cùng lúc để tăng tốc suy luận.",
    0.62,
    0,
    ["arXiv"],
  ],
  [
    "Show HN: I built 7 B2B APIs and 5 MCP servers for compliance and trade",
    "Tác giả chia sẻ cách đóng gói API doanh nghiệp thành MCP server.",
    0.6,
    2,
    ["Hacker News"],
  ],
  [
    "PostHog MCP Leaderboard",
    "Bảng xếp hạng các MCP server theo mức dùng thật.",
    0.58,
    3,
    ["Hacker News"],
  ],
  [
    "Visual Nerve, Free workflow visualization and simulation with MCP",
    "Công cụ miễn phí để vẽ và chạy thử quy trình agent.",
    0.56,
    3,
    ["Hacker News"],
  ],
  [
    "OpenTodo, a Todoist killer with MCP integration",
    "Ứng dụng việc cần làm mã nguồn mở, nối thẳng với agent qua MCP.",
    0.54,
    4,
    ["Hacker News"],
  ],
  [
    "bbylw/rea-cn: REA, reverse engineer anything through one MCP server",
    "Một MCP server cho phép agent phân tích ngược nhiều loại tệp.",
    0.53,
    3,
    ["GitHub"],
  ],
  [
    "Chỉ mục vector theo đồ thị giảm 40% bộ nhớ",
    "Cách nén đồ thị HNSW mà vẫn giữ độ chính xác truy hồi.",
    0.51,
    6,
    ["arXiv"],
  ],
  [
    "Gói suy luận lượng tử hoá 4-bit cho model 70B",
    "Thư viện mới chạy model 70B trên một máy trạm.",
    0.5,
    5,
    ["GitHub"],
  ],
];

const daysAgo = (n: number): string => {
  const [y, m, d] = todayVN().split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
};
const SNAPS: Record<string, number> = { [daysAgo(0)]: 1, [daysAgo(1)]: 2, [daysAgo(3)]: 3 };
const PAGE = 8;
const fb = new Map<number, FeedbackState>();

function items(date: string): FeedItem[] {
  const snap = SNAPS[date];
  if (!snap) return [];
  return BASE.map(([title, summary, s, t, sources], i) => ({
    position: i + 1,
    feedItemId: snap * 100 + i + 1,
    eventId: 1000 + snap * 100 + i + 1,
    title,
    summary,
    topic: T[t] ?? null,
    sourceCount: sources.length,
    articleCount: sources.length,
    sources,
    updated: i === 2,
    inDigest: i < 5,
    notifyPosition: i < 5 ? i + 1 : null,
    feedback: fb.get(snap * 100 + i + 1) ?? "none",
    score: { s, r: 0.82, p: 0.64, c: 0.5, a: 0.9, f: 0.2, u: 0.7, n: 1 },
  }));
}

const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));

export const fixtureClient: FeedClient = {
  async getFeed({ date, cursor }): Promise<FeedPage> {
    await wait();
    const d = date ?? daysAgo(0);
    const all = items(d);
    const start = cursor ? Number(cursor) : 0;
    const next = start + PAGE;
    return {
      snapshotId: SNAPS[d] ?? 0,
      date: d,
      total: all.length,
      items: all.slice(start, next),
      nextCursor: next < all.length ? String(next) : null,
    };
  },
  async getDates() {
    await wait(100);
    return {
      dates: Object.entries(SNAPS)
        .map(([date, snapshotId]) => ({ date, snapshotId, itemCount: BASE.length }))
        .sort((a, b) => b.date.localeCompare(a.date)),
    };
  },
  async getEvent(eventId): Promise<EventDetail> {
    await wait();
    const it = Object.keys(SNAPS)
      .flatMap(items)
      .find((x) => x.eventId === eventId);
    if (!it) throw new Error("not found");
    return {
      eventId,
      title: it.title,
      summary: it.summary,
      topic: it.topic,
      docs: it.sources.map((sourceName, k) => ({
        title: it.title,
        url: `https://example.com/${k}`,
        sourceName,
        publishedAt: new Date().toISOString(),
      })),
      score: it.score,
      why: `Chủ đề: ${it.topic ?? ""} · ${it.sources.join(", ")}`,
      feedItemId: it.feedItemId,
      feedback: it.feedback,
    };
  },
  async putFeedback({ feedItemId, kind }) {
    await wait(150);
    const next: FeedbackState = fb.get(feedItemId) === kind ? "none" : kind;
    fb.set(feedItemId, next);
    return next;
  },
  async postImpressions() {},
  async forMe() {
    await wait(600);
    return {
      text: "Liên quan trực tiếp đến chủ đề bạn theo dõi về model mở và agent chạy cục bộ.",
      cached: false,
    };
  },
};
