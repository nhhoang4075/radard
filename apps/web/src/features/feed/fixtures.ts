/** Dữ liệu giả cho Feed, CHỈ dùng khi dev và chưa bật VITE_FEED_API=1 (xem lib/feed-client.ts). Không vào bản build. */
import type { FeedClient } from "../../lib/feed-client.ts";
import { todayVN } from "../../lib/format.ts";
import type { EventDetail, FeedFeedbackKind, FeedItem, FeedPage } from "./types.ts";

const TOPICS = [
  { id: 1, name: "Model AI" },
  { id: 2, name: "Lập trình với AI" },
  { id: 3, name: "Xây ứng dụng LLM" },
  { id: 4, name: "Agent AI" },
  { id: 5, name: "Trợ lý và ứng dụng AI" },
  { id: 6, name: "Hạ tầng AI" },
  { id: 7, name: "Truy hồi và xếp hạng" },
  { id: 8, name: "Cơ sở dữ liệu vector" },
];
const SRC = {
  hn: { id: 1, name: "Hacker News" },
  gh: { id: 2, name: "GitHub" },
  ax: { id: 3, name: "arXiv" },
};

const BASE: [string, string, number, keyof typeof SRC, number][] = [
  [
    "Meta mở trọng số Muse Spark Open, model 816B tham số",
    "Meta phát hành trọng số mở của model 816B tham số, kèm báo cáo huấn luyện.",
    0.69,
    "hn",
    0,
  ],
  [
    "Nemotron 3.5 Bolt 74B-A9B chạy agent cục bộ trong 24GB",
    "NVIDIA phát hành model chuyên gia thưa chạy được trên một GPU 24GB.",
    0.67,
    "hn",
    0,
  ],
  [
    "ruflo: harness điều phối swarm cho Claude Code và Codex",
    "Repo mới giúp điều phối nhiều agent lập trình chạy song song.",
    0.64,
    "gh",
    1,
  ],
  [
    "Sinh văn bản song song bằng khuếch tán rời rạc",
    "Nghiên cứu sinh nhiều token cùng lúc để tăng tốc suy luận.",
    0.62,
    "ax",
    0,
  ],
  [
    "Show HN: I built 7 B2B APIs and 5 MCP servers for compliance and trade",
    "Tác giả chia sẻ cách đóng gói API doanh nghiệp thành MCP server.",
    0.6,
    "hn",
    2,
  ],
  ["PostHog MCP Leaderboard", "Bảng xếp hạng các MCP server theo mức dùng thật.", 0.58, "hn", 3],
  [
    "Visual Nerve, Free workflow visualization and simulation with MCP",
    "Công cụ miễn phí để vẽ và chạy thử quy trình agent.",
    0.56,
    "hn",
    3,
  ],
  [
    "OpenTodo, a Todoist killer with MCP integration",
    "Ứng dụng việc cần làm mã nguồn mở, nối thẳng với agent qua MCP.",
    0.54,
    "hn",
    4,
  ],
  [
    "bbylw/rea-cn: REA, reverse engineer anything through one MCP server",
    "Một MCP server cho phép agent phân tích ngược nhiều loại tệp.",
    0.53,
    "gh",
    3,
  ],
  [
    "Chỉ mục vector theo đồ thị giảm 40% bộ nhớ",
    "Cách nén đồ thị HNSW mà vẫn giữ độ chính xác truy hồi.",
    0.51,
    "ax",
    7,
  ],
  [
    "Gói suy luận lượng tử hoá 4-bit cho model 70B",
    "Thư viện mới chạy model 70B trên một máy trạm.",
    0.5,
    "gh",
    5,
  ],
  [
    "Cách một đội viết lại hệ thống truy hồi trong ba tuần",
    "Bài kể lại quá trình thay thế BM25 bằng truy hồi lai.",
    0.49,
    "hn",
    6,
  ],
  [
    "Benchmark mới cho agent dùng trình duyệt",
    "Bộ đánh giá 600 nhiệm vụ web, kèm khung chạy tái lập.",
    0.48,
    "ax",
    3,
  ],
  [
    "Ghi chú về chi phí khi chạy agent dài hơi",
    "Tổng hợp số đo chi phí token của các agent chạy hơn một giờ.",
    0.47,
    "hn",
    3,
  ],
  [
    "Mở rộng ngữ cảnh 1M token bằng trí nhớ phân cấp",
    "Nghiên cứu về bộ nhớ ba tầng cho tác vụ ngữ cảnh dài.",
    0.46,
    "ax",
    0,
  ],
];

const daysAgo = (n: number): string => {
  const [y, m, d] = todayVN().split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
};
const SNAPS: Record<string, number> = { [daysAgo(0)]: 1, [daysAgo(1)]: 2, [daysAgo(3)]: 3 };
const PAGE = 8;
const feedback = new Map<number, FeedFeedbackKind | null>();

function items(date: string): FeedItem[] {
  const snap = SNAPS[date];
  if (!snap) return [];
  return BASE.map(([title, summary, score, src, t], i) => ({
    feedItemId: snap * 100 + i + 1,
    position: i + 1,
    eventId: 1000 + snap * 100 + i + 1,
    title,
    summary,
    topic: TOPICS[t] ?? null,
    source: SRC[src],
    occurredAt: new Date(`${date}T0${1 + (i % 6)}:30:00Z`).toISOString(),
    score,
    inDigest: i < 5,
    isUpdate: i === 2,
    feedback: feedback.get(snap * 100 + i + 1) ?? null,
  }));
}

const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));

export const fixtureClient: Omit<FeedClient, "forMe"> = {
  async getFeed({ date, cursor }): Promise<FeedPage> {
    await wait();
    const d = date ?? daysAgo(0);
    const all = items(d);
    const start = cursor ? Number(cursor) : 0;
    const page = all.slice(start, start + PAGE);
    const next = start + PAGE;
    return {
      snapshotId: SNAPS[d] ?? 0,
      date: d,
      total: all.length,
      items: page,
      nextCursor: next < all.length ? String(next) : null,
    };
  },
  async getDates() {
    await wait(100);
    return {
      dates: Object.entries(SNAPS)
        .map(([date]) => ({ date, total: BASE.length }))
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
      articles: [
        {
          title: it.title,
          url: "https://example.com/a",
          source: it.source.name,
          publishedAt: it.occurredAt,
        },
        {
          title: `${it.title} (bài thứ hai)`,
          url: "https://example.com/b",
          source: "Hacker News",
          publishedAt: it.occurredAt,
        },
      ],
      components: { r: 0.82, p: 0.64, c: 0.5, a: 0.9, f: 0.2, u: 0.7 },
      score: it.score,
      penalty: 0.02,
    };
  },
  async putFeedback({ feedItemId, kind }) {
    await wait(150);
    feedback.set(feedItemId, kind === "clear" ? null : kind);
  },
  async postImpressions() {},
};
