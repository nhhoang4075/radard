/**
 * In-memory fake notifier, no network calls: tests read `sent` to check. `failAfter` makes send number
 * (failAfter + 1) throw, to test "dies midway, then re-runs and keeps sending".
 */
import type { FeedbackState, Message, Notifier } from "@radard/core";

export interface FakeNotifier extends Notifier {
  sent: { recipient: string; msg: Message; messageId: string }[];
  /** Calls of `refreshFeedbackMark`, in order. */
  refreshed: { recipient: string; messageId: string; state: FeedbackState; forMe: boolean }[];
  /** If set, `refreshFeedbackMark` throws this (tests of best-effort callers). */
  refreshError?: Error;
  failAfter?: number;
}

export function fakeNotifier(opts: { failAfter?: number; startId?: number } = {}): FakeNotifier {
  let next = opts.startId ?? 1;
  const n: FakeNotifier = {
    channel: "telegram",
    sent: [],
    refreshed: [],
    failAfter: opts.failAfter,
    async send(recipient, msg) {
      if (n.failAfter !== undefined && n.sent.length >= n.failAfter) {
        throw new Error("fake: mạng rớt");
      }
      const messageId = String(next++);
      n.sent.push({ recipient, msg, messageId });
      return { messageId };
    },
    async refreshFeedbackMark(recipient, messageId, state, opts) {
      if (n.refreshError) throw n.refreshError;
      n.refreshed.push({ recipient, messageId, state, forMe: opts.forMe });
    },
  };
  return n;
}
