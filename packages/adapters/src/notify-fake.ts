/**
 * Notifier giả trong bộ nhớ, không gọi mạng: test đọc `sent` để kiểm. `failAfter` làm lần gửi thứ
 * (failAfter + 1) ném lỗi, để thử "chết giữa chừng rồi chạy lại thì gửi tiếp".
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
