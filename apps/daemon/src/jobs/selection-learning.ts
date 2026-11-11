/**
 * Learning data of the Gumbel top-k selection (mo-hinh-de-xuat.html, section "Two beats"): right after selecting, run
 * `select` itself 10.000 times with exactly that day's input (same config including T and floor, same
 * candidate pool) to estimate p_i of each candidate and p_ij of the pairs in the sent items; store it with
 * logP of the real list, the selection seed and the simulation seed.
 *
 * Where it is stored: `digests.meta.learning` (JSON), no new table. Reason: the data belongs to exactly one digest
 * (already has `profile_id`, a rerun key, a shared lifecycle), and is only read in weekly batches, a few KB per day.
 * A separate table is only worth it when p has to be queried per item across many days; then migrating from JSON is easy.
 *
 * The pool = items SENT + items that passed the gate/floor but were not selected (`not_picked`, `source_cap`); items dropped by
 * the gate, floor or `not_new` have p = 0 so are not written. p_ij is written only for pairs within the sent items.
 *
 * Since the feed existed (decision 10/11/2026): `select` picks K items from the snapshot, and "sent" is the notification
 * layer (the first ≤ 7 items of the snapshot that pass the notification floor, `pickNotify`). The simulation runs BOTH steps (select then
 * pickNotify) so p_i, p_ij remain the probability of being SENT for exactly 7 items, as before. Snapshot items
 * that are not sent are in the pool with `sent = false`. Learning by feed position (θk) is for later.
 */
import {
  deriveSimSeed,
  type NotifyRule,
  orderedListLogProb,
  pairKey,
  pickNotify,
  type Selection,
  simulateInclusion,
} from "@radard/core";
import type { RankResult } from "./rank.ts";

/** Number of Monte Carlo runs per digest (approved 10/11/2026). */
export const SIMULATION_RUNS = 10_000;

export interface SelectionLearning {
  version: 1;
  /** Seed of the real selection; re-running with this seed gives exactly the chosen set. */
  selectSeed: number;
  /** Simulation seed = deriveSimSeed(selectSeed). */
  simSeed: number;
  temperature: number;
  runs: number;
  /** ln P of the sent list under Plackett–Luce (approximation, see `orderedListLogProb`). */
  logP: number | null;
  /** p̂_i of every item in the pool, S sorted descending. */
  pool: { eventId: number; S: number; p: number; sent: boolean }[];
  /** p̂_ij of the pairs in the sent items (n·(n−1)/2 pairs), a < b. */
  pairs: { a: number; b: number; p: number }[];
  ms: number;
}

/** Strong seed (crypto), unsigned 32-bit integer. */
export function newSelectSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

/** The events notified (sent) from one `select` result: position = order in `picked`. */
export function notifiedEventIds(selection: Selection, rule: NotifyRule): number[] {
  return pickNotify(
    selection.picked.map((p, i) => ({
      position: i + 1,
      S: p.S,
      sourceId: p.c.sourceId,
      eventId: p.event.eventId,
    })),
    rule,
  ).map((x) => x.eventId);
}

/** The notification layer of one ranking run: the cap of `config.notify` and the notification floor `floor`. */
export function notifyRuleOf(rank: RankResult): NotifyRule {
  return {
    floor: rank.floor.value,
    maxItems: rank.config.notify.maxItems,
    maxPerSource: rank.config.notify.maxPerSource,
  };
}

/** Null when the selection is deterministic (T = 0, no seed) or no item is sent. */
export function computeSelectionLearning(rank: RankResult): SelectionLearning | null {
  const seed = rank.selectSeed;
  const cfg = rank.selectConfig;
  const rule = notifyRuleOf(rank);
  const sentIds = notifiedEventIds(rank, rule);
  if (seed === null || !(cfg.temperature > 0) || sentIds.length === 0) return null;
  const started = Date.now();
  const simSeed = deriveSimSeed(seed);
  const byId = new Map(rank.picked.map((p) => [p.event.eventId, p]));
  const sentSet = new Set(sentIds);
  const sent = sentIds.map((id) => ({ eventId: id, S: byId.get(id)?.S ?? 0, sent: true }));
  const rest = [
    ...rank.picked.filter((p) => !sentSet.has(p.event.eventId)),
    ...rank.rejected.filter((r) => r.reason === "not_picked" || r.reason === "source_cap"),
  ].map((r) => ({ eventId: r.event.eventId, S: r.S, sent: false }));
  const members = [...sent, ...rest];
  const sim = simulateInclusion(rank.scored, cfg, {
    runs: SIMULATION_RUNS,
    seed: simSeed,
    focusEventIds: members.map((m) => m.eventId),
    chosen: (selection) => notifiedEventIds(selection, rule),
  });
  const ids = sent.map((s) => s.eventId);
  const pairs: SelectionLearning["pairs"] = [];
  for (const [x, a] of ids.entries()) {
    for (const b of ids.slice(x + 1)) {
      pairs.push({ a: Math.min(a, b), b: Math.max(a, b), p: sim.pairProb.get(pairKey(a, b)) ?? 0 });
    }
  }
  return {
    version: 1,
    selectSeed: seed,
    simSeed,
    temperature: cfg.temperature,
    runs: sim.runs,
    logP: orderedListLogProb(
      members.map((m) => m.S),
      sent.map((_, i) => i),
      cfg.temperature,
    ),
    pool: members
      .map((m) => ({ ...m, p: sim.selectionProb.get(m.eventId) ?? 0 }))
      .sort((a, b) => b.S - a.S),
    pairs,
    ms: Date.now() - started,
  };
}
