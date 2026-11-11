/**
 * Topic gate by the decision model (Jev): an event whose R is in the grey zone [0,5; 0,7) is asked "is this
 * article mainly about this topic", instead of the rule R ≥ 0,6.
 *
 * Measured 13–16/10/2026 on real items whose topic score is in this zone: Jev at threshold 0,6 matches the reference labels
 * 84%, the rule R ≥ 0,6 only 53%; you confirmed the reference labels. The question and the status form stay exactly as measured.
 * The topic name and scope are given to the model in English (`topicNameEn`: the name measured in the
 * library; the Vietnamese name in the scope is replaced with it), because Jev is weakest outside
 * English.
 *
 * With no decision model, or on a failed call, the event falls back to the rule R ≥ `gateR` and is marked
 * `fallback`. The ranking step never fails because of the decision model.
 */
import { createLogger, type DecisionProvider, type RankConfig, type RankEvent } from "@radard/core";
import { type Database, docText, documents, topics as topicsTable } from "@radard/db";
import { eq, inArray } from "drizzle-orm";
import { topicNameEn } from "./topic-overlap.ts";

const log = createLogger("gate");

/** The question exactly as measured (experiment B, 13–16/10/2026). */
export const TOPIC_GATE_QUESTION = "Is this news item mainly about the topic below?";
/** Number of leading characters of the embedded text that go into the excerpt (starting with the title), as measured. */
export const GATE_EXCERPT_CHARS = 400;
/** Number of calls running at once: each call takes ~0,6–1 seconds. */
export const GATE_CONCURRENCY = 8;

/** An event that was checked by the decision model (or should have been asked but could not be). */
export interface GateDecision {
  eventId: number;
  /** Event title, for reading the plan. */
  title: string;
  R: number;
  topicId: number;
  /** Vietnamese label of the topic, for reading the plan. */
  topic: string;
  /** The model's "yes" probability; `null` when it could not be asked. */
  probability: number | null;
  /** Whether it passes the gate: by probability, or by the rule R ≥ `gateR` when `fallback`. */
  pass: boolean;
  /** `true`: no decision model or the call failed, so the rule R ≥ `gateR` is used. */
  fallback: boolean;
}

export interface GateCounts {
  /** Number of events with R in the grey zone. */
  inBand: number;
  /** Number of model calls that returned an answer. */
  asked: number;
  passed: number;
  rejected: number;
  /** Number of events that used the old rule because they could not be asked. */
  fallback: number;
}

/** Candidates to ask: event, R, the topic that gave R and the document that gave R (the most topic-matching document). */
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

/** Asks the decision model for each candidate, at most `GATE_CONCURRENCY` calls at once. */
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
 * Replaces the Vietnamese names of topics mentioned in the scope ("→ Agent AI") with English names. Only
 * whole names are replaced (no letters stuck to either side: the label "Agent" is not replaced inside "Agents"); long names
 * are replaced first, so "Model AI: phát hành và hành vi" is not partially replaced by a shorter name.
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

/** All topics (to replace names inside scopes), keyed by id, with their English name and scope. */
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

/** Runs `fn` for each element, at most `limit` at once; results keep the input order. */
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
