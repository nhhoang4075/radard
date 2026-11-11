/**
 * Feed notification layer (decision 10/11/2026, mo-hinh-de-xuat.html): the feed snapshot is the
 * main source; Telegram takes at most `maxItems` items FROM THE START of the snapshot (by position) with S ≥ the notification floor,
 * at most `maxPerSource` items per source. Pure function, reads the snapshot only: it does not change the order or set of
 * feed items, so the notification rule can change without touching ranking.
 */

export interface NotifyCandidate {
  /** Position in the snapshot, 1..n. */
  position: number;
  /** S (before penalty), compared with the notification floor. */
  S: number;
  sourceId: number;
}

export interface NotifyRule {
  floor: number;
  maxItems: number;
  maxPerSource: number;
}

/** Notified items, in snapshot position order. */
export function pickNotify<T extends NotifyCandidate>(items: readonly T[], rule: NotifyRule): T[] {
  const out: T[] = [];
  const perSource = new Map<number, number>();
  for (const it of [...items].sort((a, b) => a.position - b.position)) {
    if (out.length >= rule.maxItems) break;
    if (it.S < rule.floor) continue;
    const used = perSource.get(it.sourceId) ?? 0;
    if (used >= rule.maxPerSource) continue;
    perSource.set(it.sourceId, used + 1);
    out.push(it);
  }
  return out;
}
