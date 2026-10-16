/**
 * Cổng chủ đề bằng model quyết định (Jev): sự kiện có R trong vùng xám [0,5; 0,7) được hỏi "tin
 * này có chủ yếu nói về chủ đề này không", thay cho luật R ≥ 0,6.
 *
 * Đo 13–16/10/2026 trên tin thật có điểm chủ đề trong vùng này: Jev ở ngưỡng 0,6 khớp nhãn tham
 * chiếu 84%, luật R ≥ 0,6 chỉ 53%; bạn đã xác nhận các nhãn tham chiếu. Câu hỏi và dạng trạng thái
 * giữ đúng như lúc đo. Tên chủ đề và phạm vi đưa cho model bằng tiếng Anh (`topicNameEn`: tên đã
 * đo của thư viện; tên tiếng Việt trong phạm vi được thay bằng tên đó), vì Jev yếu nhất ngoài
 * tiếng Anh.
 *
 * Không có model quyết định, hay lời gọi lỗi: sự kiện đó dùng lại luật R ≥ `gateR` và được đánh
 * dấu `fallback`. Bước xếp hạng không bao giờ hỏng vì model quyết định.
 */
import { createLogger, type DecisionProvider, type RankConfig, type RankEvent } from "@radard/core";
import { type Database, docText, documents, topics as topicsTable } from "@radard/db";
import { eq, inArray } from "drizzle-orm";
import { topicNameEn } from "./topic-overlap.ts";

const log = createLogger("gate");

/** Câu hỏi đúng như lúc đo (thử nghiệm B, 13–16/10/2026). */
export const TOPIC_GATE_QUESTION = "Is this news item mainly about the topic below?";
/** Số ký tự đầu của văn bản đã embed đưa vào trích đoạn (bắt đầu bằng tiêu đề), như lúc đo. */
export const GATE_EXCERPT_CHARS = 400;
/** Số lời gọi chạy cùng lúc: mỗi lời gọi ~0,6–1 giây. */
export const GATE_CONCURRENCY = 8;

/** Một sự kiện đã được xét bằng model quyết định (hoặc lẽ ra được hỏi mà không hỏi được). */
export interface GateDecision {
  eventId: number;
  /** Tiêu đề sự kiện, để đọc plan. */
  title: string;
  R: number;
  topicId: number;
  /** Nhãn tiếng Việt của chủ đề, để đọc plan. */
  topic: string;
  /** Xác suất "có" của model; `null` khi không hỏi được. */
  probability: number | null;
  /** Qua cổng hay không: theo xác suất, hoặc theo luật R ≥ `gateR` khi `fallback`. */
  pass: boolean;
  /** `true`: không có model quyết định hoặc lời gọi lỗi, nên dùng luật R ≥ `gateR`. */
  fallback: boolean;
}

export interface GateCounts {
  /** Số sự kiện có R trong vùng xám. */
  inBand: number;
  /** Số lời gọi model có câu trả lời. */
  asked: number;
  passed: number;
  rejected: number;
  /** Số sự kiện dùng luật cũ vì không hỏi được. */
  fallback: number;
}

/** Ứng viên cần hỏi: sự kiện, R, chủ đề cho R và tài liệu cho R (tài liệu khớp chủ đề nhất). */
export interface GateCandidate {
  event: RankEvent;
  R: number;
  topicId: number;
  documentId: number;
}

interface TopicInfo {
  label: string;
  name: string;
  description: string;
  labelGuide: string;
}

type DecideState = {
  item: { title: string; excerpt: string };
  topic: { name: string; description: string; scope_note: string };
};

export function countGate(decisions: readonly GateDecision[]): GateCounts {
  const asked = decisions.filter((d) => !d.fallback);
  return {
    inBand: decisions.length,
    asked: asked.length,
    passed: asked.filter((d) => d.pass).length,
    rejected: asked.filter((d) => !d.pass).length,
    fallback: decisions.length - asked.length,
  };
}

/** Hỏi model quyết định cho từng ứng viên, tối đa `GATE_CONCURRENCY` lời gọi cùng lúc. */
export async function decideGate(
  db: Database,
  candidates: readonly GateCandidate[],
  decider: DecisionProvider | null | undefined,
  cfg: Pick<RankConfig, "gateR" | "decision">,
): Promise<GateDecision[]> {
  if (candidates.length === 0) return [];
  const topics = await loadTopics(db);
  const fallback = (c: GateCandidate): GateDecision => ({
    eventId: c.event.eventId,
    title: c.event.title,
    R: c.R,
    topicId: c.topicId,
    topic: topics.get(c.topicId)?.label ?? String(c.topicId),
    probability: null,
    pass: c.R >= cfg.gateR,
    fallback: true,
  });
  if (!decider) {
    log.warn("chưa có model quyết định: vùng xám dùng luật R ≥ gateR", { n: candidates.length });
    return candidates.map(fallback);
  }
  const items = await loadItems(
    db,
    candidates.map((c) => c.documentId),
  );
  return mapLimit(candidates, GATE_CONCURRENCY, async (c) => {
    const topic = topics.get(c.topicId);
    const item = items.get(c.documentId);
    if (!topic || !item) return fallback(c);
    try {
      const probability = await askOne(decider, {
        item,
        topic: { name: topic.name, description: topic.description, scope_note: topic.labelGuide },
      });
      return {
        ...fallback(c),
        probability,
        pass: probability >= cfg.decision.minP,
        fallback: false,
      };
    } catch (err) {
      log.warn("hỏi cổng lỗi, dùng luật R ≥ gateR", {
        eventId: c.event.eventId,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
      return fallback(c);
    }
  });
}

async function askOne(decider: DecisionProvider, state: DecideState): Promise<number> {
  const res = await decider.decide({
    task: "decide_topic_gate",
    state,
    questions: { q: { type: "boolean", instructions: TOPIC_GATE_QUESTION } },
  });
  return res.answers.q.probability;
}

/**
 * Thay tên tiếng Việt của các chủ đề nhắc tới trong phạm vi ("→ Agent AI") bằng tên tiếng Anh. Chỉ
 * thay trọn tên (không dính chữ cái hai bên: nhãn "Agent" không được thay trong "Agents"); tên dài
 * thay trước, để "Model AI: phát hành và hành vi" không bị thay dở bởi một tên ngắn hơn.
 */
export function englishScopeNote(note: string, names: ReadonlyMap<string, string>): string {
  let out = note;
  for (const [vi, en] of [...names].sort((a, b) => b[0].length - a[0].length)) {
    const escaped = vi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu"),
      () => en,
    );
  }
  return out;
}

/** Mọi chủ đề (để thay tên trong phạm vi), khoá theo id, kèm tên và phạm vi tiếng Anh. */
async function loadTopics(db: Database): Promise<Map<number, TopicInfo>> {
  const rows = await db
    .select({
      id: topicsTable.id,
      key: topicsTable.key,
      label: topicsTable.name,
      embedText: topicsTable.embedText,
      labelGuide: topicsTable.labelGuide,
    })
    .from(topicsTable);
  const names = new Map(rows.map((t) => [t.label, topicNameEn(t)]));
  return new Map(
    rows.map((t) => [
      t.id,
      {
        label: t.label,
        name: topicNameEn(t),
        description: t.embedText,
        labelGuide: englishScopeNote(t.labelGuide ?? "", names),
      },
    ]),
  );
}

async function loadItems(db: Database, ids: number[]) {
  const rows = await db
    .select({ id: documents.id, title: documents.title, text: docText.text })
    .from(documents)
    .innerJoin(docText, eq(docText.documentId, documents.id))
    .where(inArray(documents.id, ids));
  return new Map(
    rows.map((r) => [r.id, { title: r.title ?? "", excerpt: r.text.slice(0, GATE_EXCERPT_CHARS) }]),
  );
}

/** Chạy `fn` cho từng phần tử, tối đa `limit` cùng lúc; kết quả giữ đúng thứ tự đầu vào. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
