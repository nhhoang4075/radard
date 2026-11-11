/**
 * Immutable scorer (a): data types. Replays the sent days, re-scores the item order using the
 * score components stored at selection time and the 👍/👎 labels; calls no model, reads no DB.
 */

/** Level label of an item: 👍, not clicked (also a level), 👎. */
export type Level = "like" | "none" | "dislike";

/**
 * Gain per level (fixed: 👍 = 2, not clicked = 1, 👎 = 0). Change it HERE if needed later; all
 * metrics read gains from this table.
 */
export const GAIN: Readonly<Record<Level, number>> = { like: 2, none: 1, dislike: 0 };

/** Score components stored in `digests.meta.plan.items[].score` at selection time. */
export interface StoredScore {
  S: number;
  penalty: number;
  R: number;
  P: number;
  C: number;
  A: number;
  F: number;
  N: number;
}

/** An item sent in one day. */
export interface EvalSample {
  /** Day (YYYY-MM-DD, Vietnam time) of the digest that contains the item. */
  date: string;
  /** Position in the digest (1…7). Used to break ties deterministically. */
  position: number;
  /** `url_canonical` of the documents in the event: the stable label key (event_id changes when rebuilt). */
  urls: string[];
  level: Level;
  score: StoredScore;
}

/** All items sent in one day (at most 7). */
export interface EvalDay {
  date: string;
  samples: EvalSample[];
}

export const gainOf = (s: Pick<EvalSample, "level">): number => GAIN[s.level];

/** Day with nothing to tell apart (all items at the same level): order cannot be measured, so it is excluded from the mean. */
export function isInformative(day: EvalDay): boolean {
  const first = day.samples[0];
  if (!first) return false;
  return day.samples.some((s) => s.level !== first.level);
}
