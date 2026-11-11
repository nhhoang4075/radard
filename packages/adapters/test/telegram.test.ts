/**
 * Telegram adapter without network calls: a transformer intercepts every Bot API call (records it and returns a
 * fake result), fake updates are fed in via `bot.handleUpdate`.
 */
import { describe, expect, test } from "bun:test";
import {
  type ChatHandlers,
  type CustomTopicDraft,
  type FeedbackEvent,
  FOR_ME_LABELS,
  type ForMeEvent,
  type ProfileSuggestions,
  type ProfileView,
  type ProposedTopicItem,
  type TopicItem,
} from "@radard/core";
import type { Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import {
  createTelegramBot,
  createTelegramRouter,
  describeError,
  escapeHtml,
  feedbackKeyboard,
  keepPolling,
  parseTopicInput,
  render,
  suggestKeyboard,
  suggestText,
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

/** Fake transformer: records the call; `fail` returns a Telegram error for that method. */
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

describe("nút Với tôi?", () => {
  const actions = [
    { id: "like" as const, label: "👍" },
    { id: "dislike" as const, label: "👎" },
    { id: "for_me" as const, label: FOR_ME_LABELS.button },
  ];

  test("nằm cạnh 👍/👎, mang fm:ask (ASCII, ≤ 64 byte); chọn 👍 không đổi nút này", () => {
    expect(feedbackKeyboard(actions).inline_keyboard).toEqual([
      [
        { text: "👍", callback_data: "fb:like" },
        { text: "👎", callback_data: "fb:dislike" },
        { text: FOR_ME_LABELS.button, callback_data: "fm:ask" },
      ],
    ]);
    expect(feedbackKeyboard(actions, "like").inline_keyboard[0]?.[2]).toEqual({
      text: FOR_ME_LABELS.button,
      callback_data: "fm:ask",
    });
  });

  function setup(onForMe?: ChatHandlers["onForMe"]) {
    const api = fakeApi();
    const asked: ForMeEvent[] = [];
    const bot = createTelegramBot(
      { token: "123:TEST", allowedChatId: ME, botInfo, transformer: api.t },
      {
        onFeedback: async () => ({ recorded: true }),
        ...(onForMe
          ? {
              onForMe: async (ev: ForMeEvent) => {
                asked.push(ev);
                return onForMe(ev);
              },
            }
          : {}),
      },
    );
    return { bot, asked, calls: api.calls };
  }

  test("bấm: trả lời ngay để nút hết quay, rồi trả lời trong chat (reply vào tin gốc)", async () => {
    const { bot, asked, calls } = setup(async () => ({ status: "ok", text: "Câu trả lời." }));
    await bot.handleUpdate(press("fm:ask"));
    expect(asked).toEqual([{ channel: "telegram", recipient: ME, messageId: "58" }]);
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery", "sendMessage"]);
    expect(calls[0]?.payload.text).toBe(FOR_ME_LABELS.working);
    expect(calls[1]?.payload).toMatchObject({
      chat_id: Number(ME),
      text: "Câu trả lời.",
      reply_parameters: { message_id: 58 },
    });
  });

  test("not_found / limit / unavailable và lỗi ném ra: báo bằng chuỗi trong FOR_ME_LABELS", async () => {
    for (const [res, text] of [
      [{ status: "not_found" }, FOR_ME_LABELS.notFound],
      [{ status: "limit" }, FOR_ME_LABELS.limit],
      [{ status: "unavailable" }, FOR_ME_LABELS.unavailable],
    ] as const) {
      const { bot, calls } = setup(async () => res);
      await bot.handleUpdate(press("fm:ask"));
      expect(calls.at(-1)?.payload.text).toBe(text);
    }
    const { bot, calls } = setup(async () => {
      throw new Error("DB rớt");
    });
    await bot.handleUpdate(press("fm:ask"));
    expect(calls.at(-1)?.payload.text).toBe(FOR_ME_LABELS.unavailable);
  });

  test("lõi không hỗ trợ onForMe: chỉ trả lời callback; người lạ bấm: không gọi gì", async () => {
    const none = setup();
    await none.bot.handleUpdate(press("fm:ask"));
    expect(none.calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]);
    const { bot, asked, calls } = setup(async () => ({ status: "ok", text: "x" }));
    await bot.handleUpdate(press("fm:ask", "999"));
    expect(asked).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("bấm 👍 trên tin có nút Với tôi?: bàn phím mới giữ nút đó; tin cũ không có thì không thêm", async () => {
    const { bot, calls } = setup();
    const withBtn = press("fb:like");
    const msg = withBtn.callback_query?.message as { reply_markup?: unknown };
    msg.reply_markup = feedbackKeyboard(actions);
    await bot.handleUpdate(withBtn);
    expect(
      JSON.stringify(calls.find((c) => c.method === "editMessageReplyMarkup")?.payload),
    ).toContain("fm:ask");
    const old = setup();
    await old.bot.handleUpdate(press("fb:like"));
    expect(
      JSON.stringify(old.calls.find((c) => c.method === "editMessageReplyMarkup")?.payload),
    ).not.toContain("fm:ask");
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

describe("bot đa người dùng (router)", () => {
  const OTHER = "100000002";
  function setup() {
    const api = fakeApi();
    const seen: Array<{ scope: string; ev: FeedbackEvent }> = [];
    const asked: string[] = [];
    const bot = createTelegramRouter(
      { token: "123:TEST", botInfo, transformer: api.t },
      async (recipient) => {
        asked.push(recipient);
        if (recipient !== ME && recipient !== OTHER) return null;
        const scope = recipient === ME ? "1" : "2";
        return {
          scope,
          handlers: {
            onFeedback: async (ev) => {
              seen.push({ scope, ev });
              return { recorded: true };
            },
          },
        };
      },
    );
    return { bot, seen, asked, calls: api.calls };
  }

  test("mỗi chat tới đúng bộ xử lý của hồ sơ mình", async () => {
    const { bot, seen } = setup();
    await bot.handleUpdate(press("fb:like", ME));
    await bot.handleUpdate(press("fb:dislike", OTHER, "cb-2"));
    expect(seen.map((s) => [s.scope, s.ev.recipient, s.ev.kind])).toEqual([
      ["1", ME, "like"],
      ["2", OTHER, "dislike"],
    ]);
  });

  test("chat lạ: tra rồi bỏ qua, không handler nào chạy, không gọi API nào", async () => {
    const { bot, seen, asked, calls } = setup();
    await bot.handleUpdate(press("fb:like", "999"));
    expect(asked).toEqual(["999"]);
    expect(seen).toHaveLength(0);
    expect(calls).toHaveLength(0);
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

  test("bấm lại nút đang chọn: lõi trả state 'none' → báo 'Đã bỏ chọn', bàn phím về mặc định", async () => {
    const api = fakeApi();
    const bot = createTelegramBot(
      { token: "123:TEST", allowedChatId: ME, botInfo, transformer: api.t },
      { onFeedback: async () => ({ recorded: true, state: "none" }) },
    );
    await bot.handleUpdate(press("fb:like"));
    expect(api.calls[0]?.payload.text).toBe("Đã bỏ chọn");
    expect(JSON.stringify(api.calls[1]?.payload)).not.toContain("✓");
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
    // Colours: enabled is green, disabled is default, the two action buttons are blue.
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

type Kb = { inline_keyboard: { text: string; callback_data: string; style?: string }[][] };
const keyboardOf = (c: Call | undefined) =>
  ((c?.payload.reply_markup ?? { inline_keyboard: [] }) as Kb).inline_keyboard;
const textsOf = (c: Call | undefined) => keyboardOf(c).map((row) => row.map((b) => b.text));

describe("bot: /profile", () => {
  const ENGLISH = "The reader builds LLM agents in TypeScript and Postgres.";
  const SUGGESTIONS: ProfileSuggestions = {
    topics: [
      { key: "l:3", label: "Agent AI", tier: "preselect", checked: true },
      { key: "l:5", label: "Xây ứng dụng LLM", tier: "preselect", checked: true },
      { key: "l:2", label: "Huấn luyện và tối ưu model", tier: "preselect", checked: true },
      { key: "l:11", label: "An toàn và bảo mật AI", tier: "maybe", checked: false },
      // Already enabled before: pre-ticked even at the "may interest" level.
      { key: "l:13", label: "ML nền tảng", tier: "maybe", checked: true },
      // Followed but not suggested: still shown, pre-ticked.
      { key: "l:9", label: "Trợ lý và ứng dụng AI", tier: "followed", checked: true },
    ],
    newTopics: [
      {
        label: "Ngôn ngữ, runtime và cơ sở dữ liệu",
        why: "Bạn làm với Python, TypeScript và Postgres.",
        embedText: "Languages and runtimes: Python, TypeScript, Bun, Postgres releases",
      },
    ],
  };

  function setup(
    view: ProfileView,
    opts: { llm?: boolean; suggestions?: ProfileSuggestions | null } = {},
  ) {
    const api = fakeApi();
    const saved: string[] = [];
    const applied: { on: string[]; off: string[]; add: ProposedTopicItem[] }[] = [];
    let suggested = 0;
    const bot = createTelegramBot(
      { token: "123:TEST", allowedChatId: ME, botInfo, transformer: api.t },
      {
        onFeedback: async () => ({ recorded: true }),
        topics: {
          list: async () => [{ key: "l:3", label: "Agent AI", chosen: true }],
          toggle: async () => true,
          describe: async () => "x",
          addCustom: async () => {},
        },
        profile: {
          get: async () => view,
          saveDescription: async (t) => {
            saved.push(t);
            view.description = t;
            if (opts.llm === false) return { rewritten: false };
            view.promptContext = ENGLISH;
            return { rewritten: true };
          },
          suggest: async () => {
            suggested++;
            return opts.suggestions === undefined ? structuredClone(SUGGESTIONS) : opts.suggestions;
          },
          apply: async (on, off, add) => {
            applied.push({ on, off, add });
            return on.length + add.length + 2;
          },
        },
      },
    );
    return { bot, calls: api.calls, saved, applied, suggested: () => suggested };
  }

  test("có mô tả: hiện lời của bạn, hai nút Sửa mô tả / Gợi ý chủ đề", async () => {
    const { bot, calls } = setup({ description: "Mình làm agent", promptContext: ENGLISH });
    await bot.handleUpdate(text("/profile"));
    expect(String(calls[0]?.payload.text)).toContain("Mình làm agent");
    expect(String(calls[0]?.payload.text)).not.toContain(ENGLISH);
    expect(textsOf(calls[0])).toEqual([["Sửa mô tả", "Gợi ý chủ đề"]]);
    expect(keyboardOf(calls[0])[0]?.map((b) => b.style)).toEqual(["primary", "primary"]);
  });

  test("chưa tự viết nhưng có bối cảnh cũ: nói rõ và hiện đoạn tiếng Anh", async () => {
    const { bot, calls } = setup({ description: null, promptContext: ENGLISH });
    await bot.handleUpdate(text("/profile"));
    const msg = String(calls[0]?.payload.text);
    expect(msg).toContain("Bạn chưa tự viết mô tả. Hiện radard đang dùng đoạn mô tả có sẵn sau:");
    expect(msg).toContain(ENGLISH);
    expect(msg).not.toMatch(/digest|prompt|embedding|model/i);
  });

  test("sửa mô tả → lưu → gợi ý: nhóm theo mức, tích đúng; chủ đề mới có nút Thêm", async () => {
    const { bot, calls, saved } = setup({ description: null, promptContext: ENGLISH });
    await bot.handleUpdate(press("pf:edit"));
    expect(calls.at(-1)?.payload.reply_markup).toMatchObject({ force_reply: true });
    await bot.handleUpdate(text("Mình là kỹ sư AI"));
    expect(saved).toEqual(["Mình là kỹ sư AI"]);
    const msg = calls.filter((c) => c.method === "sendMessage").at(-1);
    const body = String(msg?.payload.text);
    expect(body).toContain("Nên theo dõi: Agent AI, Xây ứng dụng LLM, Huấn luyện và tối ưu model.");
    expect(body).toContain("Có thể bạn quan tâm: An toàn và bảo mật AI, ML nền tảng.");
    expect(body).toContain("Đang theo dõi: Trợ lý và ứng dụng AI.");
    expect(body).not.toContain("giữ nguyên");
    expect(body).toContain("Ngôn ngữ, runtime và cơ sở dữ liệu</b>: Bạn làm với Python");
    expect(textsOf(msg)).toEqual([
      ["✓ Agent AI", "✓ Xây ứng dụng LLM"],
      ["✓ Huấn luyện và tối ưu model"],
      ["An toàn và bảo mật AI", "✓ ML nền tảng"],
      ["✓ Trợ lý và ứng dụng AI"],
      ['Thêm "Ngôn ngữ, runtime và cơ sở dữ liệu"'],
      ["Lưu"],
    ]);
    // Every callback_data ≤ 64 bytes.
    for (const row of keyboardOf(msg))
      for (const b of row) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    expect(JSON.stringify(calls)).not.toMatch(/✅|✔️|➕|digest/);
  });

  test("bấm bật tắt rồi Lưu: chỉ áp dụng các chủ đề trong tin, báo số chủ đề đang theo dõi", async () => {
    const { bot, calls, applied } = setup({ description: "x", promptContext: ENGLISH });
    await bot.handleUpdate(press("pf:sug"));
    await bot.handleUpdate(press("pf:t:l:2"));
    expect(textsOf(calls.at(-1))[1]).toEqual(["Huấn luyện và tối ưu model"]);
    await bot.handleUpdate(press("pf:t:l:11"));
    await bot.handleUpdate(press("pf:save"));
    expect(applied).toEqual([{ on: ["l:3", "l:5", "l:11", "l:13", "l:9"], off: ["l:2"], add: [] }]);
    expect(calls.at(-1)?.method).toBe("editMessageText");
    expect(calls.at(-1)?.payload.text).toBe(
      "Đã lưu: bạn đang theo dõi 7 chủ đề. Điểm tin lần tới sẽ dùng các chủ đề này.",
    );
    // Once saved, the message is no longer valid: pressing again does not apply anything again.
    await bot.handleUpdate(press("pf:save"));
    expect(applied).toHaveLength(1);
  });

  test("chủ đề mới: bấm Thêm chỉ tích (chưa tạo); Lưu mới tạo, một lần", async () => {
    const { bot, calls, applied } = setup({ description: "x", promptContext: ENGLISH });
    await bot.handleUpdate(press("pf:sug"));
    await bot.handleUpdate(press("pf:n:0"));
    expect(applied).toHaveLength(0);
    const kb = calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1);
    expect(keyboardOf(kb).at(-2)).toEqual([
      { text: "✓ Ngôn ngữ, runtime và cơ sở dữ liệu", callback_data: "pf:n:0", style: "success" },
    ]);
    await bot.handleUpdate(press("pf:save"));
    await bot.handleUpdate(press("pf:save"));
    expect(applied).toHaveLength(1);
    expect(applied[0]?.add).toEqual([SUGGESTIONS.newTopics[0] as ProposedTopicItem]);
    expect(calls.at(-1)?.payload.text).toContain("/profile");
  });

  test("chủ đề mới: tích rồi bỏ tích trước Lưu thì không tạo gì", async () => {
    const { bot, calls, applied } = setup({ description: "x", promptContext: ENGLISH });
    await bot.handleUpdate(press("pf:sug"));
    await bot.handleUpdate(press("pf:n:0"));
    await bot.handleUpdate(press("pf:n:0"));
    const kb = calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1);
    expect(keyboardOf(kb).at(-2)).toEqual([
      { text: 'Thêm "Ngôn ngữ, runtime và cơ sở dữ liệu"', callback_data: "pf:n:0" },
    ]);
    await bot.handleUpdate(press("pf:save"));
    expect(applied[0]?.add).toEqual([]);
  });

  test("tin gợi ý lạ (bot khởi động lại): báo đã cũ, không áp dụng gì", async () => {
    const { bot, calls, applied } = setup({ description: "x", promptContext: ENGLISH });
    await bot.handleUpdate(press("pf:save", ME, "cb-9", 77));
    expect(applied).toHaveLength(0);
    expect(String(calls.at(-1)?.payload.text)).toContain("/profile");
  });

  test("không viết được bối cảnh (thiếu LLM): vẫn lưu lời bạn, báo gợi ý tạm chưa dùng được", async () => {
    const { bot, calls, saved, suggested } = setup(
      { description: null, promptContext: ENGLISH },
      { llm: false },
    );
    await bot.handleUpdate(press("pf:edit"));
    await bot.handleUpdate(text("Mình làm agent"));
    expect(saved).toEqual(["Mình làm agent"]);
    expect(suggested()).toBe(0);
    expect(calls.at(-1)?.payload.text).toBe(
      "Đã lưu mô tả của bạn. Gợi ý chủ đề tạm thời chưa dùng được, bạn thử lại sau nhé.",
    );
  });

  test("gợi ý không chạy được: báo một dòng, không gửi bộ nút", async () => {
    const { bot, calls } = setup(
      { description: "x", promptContext: ENGLISH },
      { suggestions: null },
    );
    await bot.handleUpdate(press("pf:sug"));
    expect(calls.at(-1)?.payload.text).toBe(
      "Gợi ý chủ đề tạm thời chưa dùng được, bạn thử lại sau nhé.",
    );
    expect(calls.at(-1)?.payload.reply_markup).toBeUndefined();
  });

  test("/start lần đầu (chưa có mô tả nào): chào rồi hỏi mô tả; đã có thì hiện chủ đề như cũ", async () => {
    const fresh = setup({ description: null, promptContext: "" });
    await fresh.bot.handleUpdate(text("/start"));
    expect(fresh.calls.map((c) => c.method)).toEqual(["sendMessage", "sendMessage"]);
    expect(String(fresh.calls[0]?.payload.text)).toStartWith("Chào bạn!");
    expect(fresh.calls[1]?.payload.reply_markup).toMatchObject({ force_reply: true });
    await fresh.bot.handleUpdate(text("Mình làm agent"));
    expect(fresh.saved).toEqual(["Mình làm agent"]);

    const known = setup({ description: null, promptContext: ENGLISH });
    await known.bot.handleUpdate(text("/start"));
    expect(textsOf(known.calls[0])).toEqual([["✓ Agent AI"], ["Tự thêm chủ đề", "Xong"]]);
  });

  test("đang chờ mô tả mà bấm Tự thêm chủ đề: chữ gõ sau thuộc luồng chủ đề", async () => {
    const { bot, saved } = setup({ description: null, promptContext: ENGLISH });
    await bot.handleUpdate(press("pf:edit"));
    await bot.handleUpdate(press("tp:add"));
    await bot.handleUpdate(text("Postgres cho AI"));
    expect(saved).toHaveLength(0);
  });

  test("người lạ: /profile, nút, chữ đều bị bỏ qua", async () => {
    const { bot, calls, saved, applied } = setup({ description: "x", promptContext: ENGLISH });
    await bot.handleUpdate(text("/profile", "999"));
    await bot.handleUpdate(press("pf:edit", "999"));
    await bot.handleUpdate(text("tôi là người lạ", "999"));
    await bot.handleUpdate(press("pf:save", "999"));
    expect(calls).toHaveLength(0);
    expect(saved).toHaveLength(0);
    expect(applied).toHaveLength(0);
  });

  test("bộ nút gợi ý: callback_data ≤ 64 byte kể cả id lớn", () => {
    const kb = suggestKeyboard({
      topics: [
        {
          key: `l:${Number.MAX_SAFE_INTEGER}`,
          label: "x".repeat(60),
          tier: "maybe",
          checked: false,
        },
        { key: `l:${Number.MAX_SAFE_INTEGER - 1}`, label: "w", tier: "followed", checked: true },
      ],
      newTopics: [0, 1, 2].map((i) => ({
        label: "y".repeat(60),
        why: "z",
        embedText: "e",
        checked: i === 1,
      })),
    });
    for (const row of kb.inline_keyboard)
      for (const b of row)
        expect(
          Buffer.byteLength((b as { callback_data: string }).callback_data),
        ).toBeLessThanOrEqual(64);
    expect(suggestText({ topics: [], newTopics: [] })).toContain("/topics");
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
          stopped = true; // daemon stopped: the next error does not run again
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
