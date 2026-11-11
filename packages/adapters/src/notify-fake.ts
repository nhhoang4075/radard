/**
 * In-memory fake notifier, no network calls: tests read `sent` to check. `failAfter` makes send number
 * (failAfter + 1) throw, to test "dies midway, then re-runs and keeps sending".
 */
import type { Message, Notifier } from "@radard/core";

export interface FakeNotifier extends Notifier {
  sent: { recipient: string; msg: Message; messageId: string }[];
  failAfter?: number;
}

export function fakeNotifier(opts: { failAfter?: number; startId?: number } = {}): FakeNotifier {
  let next = opts.startId ?? 1;
  const n: FakeNotifier = {
    channel: "telegram",
    sent: [],
    failAfter: opts.failAfter,
    async send(recipient, msg) {
      if (n.failAfter !== undefined && n.sent.length >= n.failAfter) {
        throw new Error("fake: mạng rớt");
      }
      const messageId = String(next++);
      n.sent.push({ recipient, msg, messageId });
      return { messageId };
    },
  };
  return n;
}
