/**
 * Feed notification layer (decision 10/11/2026, mo-hinh-de-xuat.html): the feed snapshot is the
 * main source; Telegram takes at most `maxItems` items FROM THE START of the snapshot (by position), at most
 * `maxPerSource` items per source. There is no separate notification floor (owner decision 13/11/2026): every snapshot item already
 * passed the feed floor. Pure function, reads the snapshot only: it does not change the order or set of
 * feed items, so the notification rule can change without touching ranking.
 */

export interface NotifyCandidate {
  /** Position in the snapshot, 1..n. */
  position: number;
  sourceId: number;
}

export interface NotifyRule {
  maxItems: number;
  maxPerSource: number;
}

/** Notified items, in snapshot position order. */
export function pickNotify<T extends NotifyCandidate>(items: readonly T[], rule: NotifyRule): T[] {
  const out: T[] = [];
  const perSource = new Map<number, number>();
  for (const it of [...items].sort((a, b) => a.position - b.position)) {
    if (out.length >= rule.maxItems) break;
    const used = perSource.get(it.sourceId) ?? 0;
    if (used >= rule.maxPerSource) continue;
    perSource.set(it.sourceId, used + 1);
    out.push(it);
  }
  return out;
}
