/**
 * Lớp thông báo của feed (quyết định 10/11/2026, mo-hinh-de-xuat.html): bản chụp feed là nguồn
 * chính; Telegram chỉ lấy tối đa `maxItems` tin ĐẦU của bản chụp (theo vị trí) có S ≥ sàn thông
 * báo, mỗi nguồn tối đa `maxPerSource` tin. Hàm thuần, chỉ đọc bản chụp: không đổi thứ tự hay tập
 * tin của feed, nên quy tắc báo đổi được mà không đụng xếp hạng.
 */

export interface NotifyCandidate {
  /** Vị trí trong bản chụp, 1..n. */
  position: number;
  /** S (chưa trừ phạt), so với sàn thông báo. */
  S: number;
  sourceId: number;
}

export interface NotifyRule {
  floor: number;
  maxItems: number;
  maxPerSource: number;
}

/** Các tin được báo, theo thứ tự vị trí trong bản chụp. */
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
