/**
 * Adapter Telegram không gọi mạng: một transformer chặn mọi lời gọi Bot API (ghi lại và trả kết
 * quả giả), update giả đưa vào bằng `bot.handleUpdate`.
 */
import { describe, expect, test } from "bun:test";
import type { CustomTopicDraft, FeedbackEvent, TopicItem } from "@radard/core";
import type { Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import {
  createTelegramBot,
  describeError,
  escapeHtml,
  feedbackKeyboard,
  keepPolling,
  parseTopicInput,
  render,
  telegramNotifier,
} from "../src/telegram.ts";

const ME = "100000001";
const botInfo = {
  id: 42,
  is_bot: true,
  first_name: "radard",
  username: "radard_test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;

type Call = { method: string; payload: Record<string, unknown> };

/** Transformer giả: ghi lời gọi; `fail` trả lỗi Telegram cho phương thức đó. */
function fakeApi(fail: Record<string, string> = {}) {
  const calls: Call[] = [];
  const t: Transformer = async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (fail[method]) {
      return { ok: false, error_code: 400, description: fail[method] } as never;
    }
    const result =
      method === "sendMessage" ? { message_id: 58, chat: { id: Number(ME) }, date: 0 } : true;
    return { ok: true, result } as never;
  };
  return { calls, t };
}

function press(data: string, chatId = ME, cbId = "cb-1", messageId = 58): Update {
  return {
    update_id: 9001,
    callback_query: {
      id: cbId,
      from: { id: Number(chatId), is_bot: false, first_name: "H" },
      chat_instance: "x",
      data,
      message: {
        message_id: messageId,
        date: 0,
        chat: { id: Number(chatId), type: "private", first_name: "H" },
        text: "tin",
      },
    },
  } as Update;
}

describe("render", () => {
  test("escape & trước, rồi < >; URL escape cả dấu nháy", () => {
    expect(escapeHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
    const html = render({
      kind: "digest",
      title: "Why x < y in Rust & C++",
      lines: ["Dòng 1 <b>không phải thẻ</b>", "Dòng 2"],
      links: [{ url: 'https://x.com/a?b=1&c="2"', label: "x.com", role: "main" }],
    });
    expect(html).toBe(
      '<b>Why x &lt; y in Rust &amp; C++</b>\n\nDòng 1 &lt;b&gt;không phải thẻ&lt;/b&gt;\n\nDòng 2\n\nĐọc chi tiết: <a href="https://x.com/a?b=1&amp;c=&quot;2&quot;">x.com</a>',
    );
  });

  test("link theo vai trò: chính · bài khác (+N) · thảo luận; nhãn hiện ra, url đầy đủ phía sau", () => {
    const html = render({
      kind: "digest",
      title: "OpenAI ra mắt Decisions API",
      lines: [],
      links: [
        { url: "https://openai.com/index/decisions-api", label: "openai.com", role: "main" },
        {
          url: "https://techcrunch.com/2026/09/30/openai-decisions",
          label: "techcrunch.com",
          role: "related",
        },
        { url: "https://venturebeat.com/ai/decisions", label: "venturebeat.com", role: "related" },
        {
          url: "https://news.ycombinator.com/item?id=1",
          label: "HN · 34 điểm, 12 bình luận",
          role: "discussion",
        },
      ],
      moreRelated: 5,
    });
    expect(html.split("\n\n").at(-1)).toBe(
      [
        'Đọc chi tiết: <a href="https://openai.com/index/decisions-api">openai.com</a>',
        'Bài khác: <a href="https://techcrunch.com/2026/09/30/openai-decisions">techcrunch.com</a> · <a href="https://venturebeat.com/ai/decisions">venturebeat.com</a> · +5 bài',
        'Thảo luận: <a href="https://news.ycombinator.com/item?id=1">HN · 34 điểm, 12 bình luận</a>',
      ].join("\n"),
    );
  });

  test("tin quá dài bị cắt an toàn dưới giới hạn 4.096 ký tự", () => {
    const html = render({ kind: "digest", title: "t", lines: ["x".repeat(10_000)] });
    expect(html.length).toBeLessThan(4096);
    expect(html.endsWith("…")).toBe(true);
  });

  test("nút chỉ mang fb:like / fb:dislike (ASCII, ≤ 64 byte); nút đã chọn có ✓", () => {
    const kb = feedbackKeyboard(
      [
        { id: "like", label: "👍" },
        { id: "dislike", label: "👎" },
      ],
      "dislike",
    );
    expect(kb.inline_keyboard).toEqual([
      [
        { text: "👍", callback_data: "fb:like" },
        { text: "👎 ✓", callback_data: "fb:dislike", style: "danger" },
      ],
    ]);
  });
});

describe("telegramNotifier", () => {
  test("gửi HTML, tắt xem trước link, gắn nút; trả message_id", async () => {
    const { calls, t } = fakeApi();
    const n = telegramNotifier({ token: "123:TEST", transformer: t });
    const r = await n.send(ME, {
      kind: "digest",
      title: "A",
      lines: ["b"],
      actions: [{ id: "like", label: "👍" }],
    });
    expect(r).toEqual({ messageId: "58" });
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.payload).toMatchObject({
      chat_id: ME,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  test("lỗi được mô tả không kèm token hay URL", async () => {
    const { t } = fakeApi({ sendMessage: "Bad Request: can't parse entities" });
    const n = telegramNotifier({ token: "123:SECRET", transformer: t });
    const err = await n.send(ME, { kind: "digest", title: "A", lines: [] }).catch((e) => e);
    const d = JSON.stringify(describeError(err));
    expect(d).toContain("can't parse entities");
    expect(d).not.toContain("SECRET");
  });
});

describe("bot: lượt bấm", () => {
  function setup(fail: Record<string, string> = {}) {
    const api = fakeApi(fail);
    const events: FeedbackEvent[] = [];
    const bot = createTelegramBot(
      { token: "123:TEST", allowedChatId: ME, botInfo, transformer: api.t },
      {
        onFeedback: async (ev) => {
          events.push(ev);
          return { recorded: true };
        },
      },
    );
    return { bot, events, calls: api.calls };
  }

  test("👍 → onFeedback với message_id và id lượt bấm; trả lời; nút đổi thành 👍 ✓", async () => {
    const { bot, events, calls } = setup();
    await bot.handleUpdate(press("fb:like"));
    expect(events).toEqual([
      { channel: "telegram", recipient: ME, messageId: "58", kind: "like", sourceId: "cb:cb-1" },
    ]);
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery", "editMessageReplyMarkup"]);
    expect(calls[0]?.payload.text).toBe("Đã ghi nhận 👍");
    expect(JSON.stringify(calls[1]?.payload)).toContain("👍 ✓");
  });

  test("người lạ bấm: không ghi, không gọi API nào", async () => {
    const { bot, events, calls } = setup();
    await bot.handleUpdate(press("fb:like", "999"));
    expect(events).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("bấm lại đúng nút đã chọn: lỗi 'message is not modified' bị bỏ qua", async () => {
    const { bot, events } = setup({
      editMessageReplyMarkup:
        "Bad Request: message is not modified: specified new message content and reply markup are exactly the same",
    });
    await bot.handleUpdate(press("fb:dislike"));
    expect(events.map((e) => e.kind)).toEqual(["dislike"]);
  });

  test("nút lạ: chỉ trả lời để nút không quay vòng, không ghi gì", async () => {
    const { bot, events, calls } = setup();
    await bot.handleUpdate(press("old:button"));
    expect(events).toHaveLength(0);
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]);
  });
});

function text(t: string, chatId = ME): Update {
  const isCommand = t.startsWith("/");
  return {
    update_id: 9100,
    message: {
      message_id: 70,
      date: 0,
      chat: { id: Number(chatId), type: "private", first_name: "H" },
      from: { id: Number(chatId), is_bot: false, first_name: "H" },
      text: t,
      ...(isCommand
        ? { entities: [{ type: "bot_command", offset: 0, length: t.split(" ")[0]?.length ?? 0 }] }
        : {}),
    },
  } as Update;
}

describe("bot: chọn chủ đề", () => {
  function setup() {
    const api = fakeApi();
    const items: TopicItem[] = [
      { key: "l:1", label: "Agent AI", chosen: true },
      { key: "l:2", label: "RAG & tìm kiếm", chosen: false },
      { key: "c:9", label: "Postgres cho AI", chosen: true },
    ];
    const added: CustomTopicDraft[] = [];
    const described: string[] = [];
    const bot = createTelegramBot(
      { token: "123:TEST", allowedChatId: ME, botInfo, transformer: api.t },
      {
        onFeedback: async () => ({ recorded: true }),
        topics: {
          list: async () => items,
          toggle: async (key) => {
            const t = items.find((x) => x.key === key);
            if (t) t.chosen = !t.chosen;
            return t?.chosen ?? false;
          },
          describe: async (label, desc) => {
            described.push(`${label}|${desc}`);
            return "Postgres for AI: pgvector, HNSW, hybrid search";
          },
          addCustom: async (d) => {
            added.push(d);
          },
        },
      },
    );
    return { bot, calls: api.calls, items, added, described };
  }

  test("/topics: nút bật tắt hai cái một hàng, chủ đề đang bật có ✓ đơn sắc, không emoji màu", async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate(text("/topics"));
    const markup = (calls[0]?.payload.reply_markup ?? { inline_keyboard: [] }) as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    const kb = markup.inline_keyboard;
    expect(kb.map((row) => row.map((b) => b.text))).toEqual([
      ["✓ Agent AI", "RAG & tìm kiếm"],
      ["✓ Postgres cho AI"],
      ["Tự thêm chủ đề", "Xong"],
    ]);
    expect(kb[0]?.[1]?.callback_data).toBe("tp:t:l:2");
    // Màu: đang bật xanh lá, đang tắt mặc định, hai nút hành động xanh dương.
    expect(kb.map((row) => row.map((b) => (b as { style?: string }).style ?? "-"))).toEqual([
      ["success", "-"],
      ["success"],
      ["primary", "primary"],
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/✅|✔️|➕/);
  });

  test("bấm một chủ đề: bật, báo lại, vẽ lại bộ nút", async () => {
    const { bot, calls, items } = setup();
    await bot.handleUpdate(press("tp:t:l:2"));
    expect(items[1]?.chosen).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery", "editMessageReplyMarkup"]);
    expect(calls[0]?.payload.text).toBe("Đã bật: RAG & tìm kiếm");
  });

  test("tự thêm: hỏi → bạn gửi tên + mô tả → LLM viết câu → Lưu thì mới ghi", async () => {
    const { bot, calls, added, described } = setup();
    await bot.handleUpdate(press("tp:add"));
    expect(calls.at(-1)?.payload.reply_markup).toMatchObject({ force_reply: true });
    await bot.handleUpdate(text("Postgres cho AI\npgvector, index vector"));
    expect(described).toEqual(["Postgres cho AI|pgvector, index vector"]);
    const preview = calls.at(-1);
    expect(preview?.method).toBe("sendMessage");
    expect(String(preview?.payload.text)).toContain(
      "Postgres for AI: pgvector, HNSW, hybrid search",
    );
    expect(added).toHaveLength(0);
    await bot.handleUpdate(press("tp:save"));
    expect(added).toEqual([
      {
        label: "Postgres cho AI",
        description: "pgvector, index vector",
        embedText: "Postgres for AI: pgvector, HNSW, hybrid search",
      },
    ]);
  });

  test("Huỷ thì không ghi; tin thường khi không đang thêm chỉ được hướng dẫn", async () => {
    const { bot, calls, added } = setup();
    await bot.handleUpdate(press("tp:add"));
    await bot.handleUpdate(text("Chủ đề X"));
    await bot.handleUpdate(press("tp:cancel"));
    await bot.handleUpdate(press("tp:save"));
    expect(added).toHaveLength(0);
    await bot.handleUpdate(text("chào bot"));
    expect(calls.at(-1)?.payload.text).toBe("Gõ /topics để chọn chủ đề theo dõi.");
  });

  test("người lạ gõ /topics: không gọi gì (không lộ danh sách, không tốn LLM)", async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate(text("/topics", "999"));
    await bot.handleUpdate(text("Chủ đề lạ\nmô tả", "999"));
    expect(calls).toHaveLength(0);
  });

  test("parseTopicInput: dòng đầu là tên; chỉ một dòng thì mô tả = tên; rỗng thì null", () => {
    expect(parseTopicInput("  Tên  \n\n mô tả 1\nmô tả 2 ")).toEqual({
      label: "Tên",
      description: "mô tả 1\nmô tả 2",
    });
    expect(parseTopicInput("Chỉ tên")).toEqual({ label: "Chỉ tên", description: "Chỉ tên" });
    expect(parseTopicInput(" \n ")).toBeNull();
  });
});

describe("keepPolling", () => {
  test("polling dừng vì lỗi (409 lúc chuyển bản deploy) thì chạy lại; đã tắt thì thôi", async () => {
    let calls = 0;
    let stopped = false;
    const delays: number[] = [];
    await new Promise<void>((done) => {
      keepPolling({
        start: async (onStarted) => {
          calls++;
          if (calls <= 2) throw new Error("409: Conflict: terminated by other getUpdates request");
          onStarted();
          stopped = true; // daemon tắt: lần lỗi sau không chạy lại
          done();
          throw new Error("đã dừng");
        },
        stopped: () => stopped,
        baseDelayMs: 1,
        maxDelayMs: 2,
        onRetry: (_err, ms) => delays.push(ms),
      });
    });
    await Bun.sleep(10);
    expect(calls).toBe(3);
    expect(delays).toEqual([1, 2]);
  });
});
