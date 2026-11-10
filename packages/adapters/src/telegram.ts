/**
 * Adapter Telegram (grammY): gửi tin có nút 👍/👎 (`Notifier`) và nhận lượt bấm (`ChatChannel`).
 *
 * Chỉ thư mục `packages/adapters` được import grammY (radard-thiet-ke.html, quy tắc 1). Giải thích
 * Bot API và các lựa chọn ở đây: docs/notifier-telegram.html.
 *
 *   - Nút chỉ mang `fb:like` / `fb:dislike`, không mang id delivery: lúc gửi chưa có id đó.
 *     Lượt bấm luôn kèm `message_id` và `chat.id`, đủ để tìm lại tin.
 *   - Lọc người lạ một lần ở đầu chuỗi middleware, trước mọi truy vấn DB hay lời gọi LLM.
 *   - Token nằm trong URL của Bot API: log chỉ ghi tên phương thức và mô tả lỗi, không ghi URL.
 */
import { autoRetry } from "@grammyjs/auto-retry";
import {
  type ChatChannel,
  type ChatHandlers,
  type ChatResolver,
  type CustomTopicDraft,
  createLogger,
  type FeedbackKind,
  type Link,
  type Message,
  type Notifier,
  type ProfileHandlers,
  type ProfileSuggestions,
  type ProfileView,
  type ProposedTopicItem,
  type SuggestedTopic,
  type TopicHandlers,
  type TopicItem,
} from "@radard/core";
import {
  Api,
  Bot,
  type Context,
  GrammyError,
  HttpError,
  InlineKeyboard,
  type Transformer,
} from "grammy";
import type { UserFromGetMe } from "grammy/types";

const CHANNEL = "telegram";
const log = createLogger("telegram");

/** Telegram cho bot gửi khoảng 1 tin/giây vào một chat. */
const MIN_INTERVAL_MS = 1000;
/** Giới hạn 4.096 ký tự của một tin (tính sau khi bỏ thẻ); chừa chỗ cho tiêu đề và link. */
const MAX_TEXT = 3800;

/** Escape cho `parse_mode: "HTML"`: `&` trước, nếu không sẽ thay hỏng kết quả của các dòng sau. */
export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function anchor(l: Link): string {
  return `<a href="${escapeHtml(l.url).replaceAll('"', "&quot;")}">${escapeHtml(l.label)}</a>`;
}

/**
 * Message trung lập → HTML của Telegram. Không có `<br>`/`<p>`: xuống dòng bằng `\n`.
 * Link trình bày theo vai trò: link chính một dòng, các bài khác gộp một dòng ngăn bằng " · ",
 * trang thảo luận một dòng. Chữ hiện ra là nhãn; bấm vào mở `url` đầy đủ.
 */
export function render(msg: Message): string {
  let body = msg.lines.join("\n\n");
  if (body.length > MAX_TEXT) body = `${body.slice(0, MAX_TEXT - 1)}…`;
  const parts = [`<b>${escapeHtml(msg.title)}</b>`];
  if (body) parts.push(escapeHtml(body));

  const links = msg.links ?? [];
  const rows: string[] = [];
  for (const l of links.filter((x) => x.role === "main")) rows.push(`Đọc chi tiết: ${anchor(l)}`);
  const related = links.filter((x) => x.role === "related").map(anchor);
  if (msg.moreRelated) related.push(`+${msg.moreRelated} bài`);
  if (related.length) rows.push(`Bài khác: ${related.join(" · ")}`);
  for (const l of links.filter((x) => x.role === "discussion"))
    rows.push(`Thảo luận: ${anchor(l)}`);
  if (rows.length) parts.push(rows.join("\n"));
  return parts.join("\n\n");
}

const LABELS: Record<FeedbackKind, string> = { like: "👍", dislike: "👎" };

/**
 * Dấu "đang chọn": ✓ đơn sắc (U+2713, hiện như chữ), không dùng emoji màu như ✅ (yêu cầu
 * 13/10/2026). Đi kèm màu nút (`style` của Bot API: success xanh lá, primary xanh dương, danger
 * đỏ); bản Telegram cũ không hiện màu vẫn phân biệt được nhờ dấu ✓.
 */
const CHECK = "✓";

/**
 * Bộ nút 👍/👎; nút đang chọn có dấu ✓ để bạn thấy mình đã chọn gì. Bấm nút kia để đổi ý, bấm lại
 * đúng nút đang chọn để bỏ chọn (không truyền `chosen` thì cả hai nút đều chưa chọn).
 */
export function feedbackKeyboard(
  actions: NonNullable<Message["actions"]>,
  chosen?: FeedbackKind,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const a of actions) {
    if (a.id !== chosen) {
      kb.text(a.label, `fb:${a.id}`);
      continue;
    }
    kb.text(`${a.label} ${CHECK}`, `fb:${a.id}`);
    if (a.id === "like") kb.success();
    else kb.danger();
  }
  return kb;
}

/** Danh sách chủ đề thành nút bật tắt, hai nút một hàng; cuối cùng là "Tự thêm chủ đề", "Xong". */
export function topicsKeyboard(items: TopicItem[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  items.forEach((t, i) => {
    kb.text(t.chosen ? `${CHECK} ${t.label}` : t.label, `tp:t:${t.key}`);
    if (t.chosen) kb.success();
    if (i % 2 === 1) kb.row();
  });
  if (items.length % 2 === 1) kb.row();
  return kb.text("Tự thêm chủ đề", "tp:add").primary().text("Xong", "tp:done").primary();
}

/**
 * Lời trong tin gọi digest là "điểm tin", không dùng "digest" (từ kỹ thuật; bạn chọn 13/10/2026).
 * "digest" chỉ còn là tên trong code và DB.
 */
const TOPICS_TEXT =
  "Chọn chủ đề bạn muốn theo dõi. Bấm để bật hoặc tắt (✓ là đang bật). Điểm tin mỗi sáng chỉ lấy tin thuộc các chủ đề đang bật.";

const ADD_PROMPT = [
  "Gửi tên chủ đề ở dòng đầu, mô tả bằng lời của bạn ở các dòng sau (tiếng Việt hay tiếng Anh đều được).",
  "",
  "Ví dụ:",
  "Postgres cho AI",
  "pgvector, index vector, HNSW, tìm kiếm kết hợp từ khoá và vector trong Postgres",
].join("\n");

/** Tách tin người dùng gửi: dòng đầu là tên, phần còn lại là mô tả (thiếu thì dùng luôn tên). */
export function parseTopicInput(text: string): { label: string; description: string } | null {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const label = lines[0]?.slice(0, 60);
  if (!label) return null;
  return { label, description: lines.slice(1).join("\n") || label };
}

function draftText(d: CustomTopicDraft): string {
  return [
    `<b>${escapeHtml(d.label)}</b>`,
    `Lời của bạn: ${escapeHtml(d.description)}`,
    `Câu radard dùng để tìm bài (tiếng Anh): <i>${escapeHtml(d.embedText)}</i>`,
    "Lưu chủ đề này?",
  ].join("\n\n");
}

/** Mô tả lỗi an toàn để log: không bao giờ có URL (chứa token). */
export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof GrammyError) {
    return { method: err.method, code: err.error_code, description: err.description };
  }
  if (err instanceof HttpError) return { network: true, message: err.message };
  return { message: err instanceof Error ? err.message : String(err) };
}

export interface TelegramOptions {
  token: string;
  /** Thay mọi lời gọi Bot API (test). Không đặt thì gọi api.telegram.org thật. */
  transformer?: Transformer;
}

function withRetry<A extends { config: { use(t: Transformer): void } }>(api: A, t?: Transformer) {
  if (t) api.config.use(t);
  // 429: chờ đúng retry_after; 5xx: thử lại vài lần. 4xx khác là lỗi của ta, không thử lại.
  else api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
  return api;
}

export function telegramNotifier(opts: TelegramOptions): Notifier {
  const api = withRetry(new Api(opts.token), opts.transformer);
  let nextAt = 0;
  return {
    channel: CHANNEL,
    async send(recipient, msg) {
      const wait = nextAt - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      try {
        const sent = await api.sendMessage(recipient, render(msg), {
          parse_mode: "HTML",
          // Không tắt thì 7 tin mỗi sáng có 7 khung xem trước link to, rất dài.
          link_preview_options: { is_disabled: true },
          ...(msg.actions?.length ? { reply_markup: feedbackKeyboard(msg.actions) } : {}),
        });
        return { messageId: String(sent.message_id) };
      } catch (err) {
        log.error("gửi tin lỗi", describeError(err));
        throw err;
      } finally {
        nextAt = Date.now() + MIN_INTERVAL_MS;
      }
    },
  };
}

/** Bấm lại đúng nút đã chọn thì bộ nút không đổi: Telegram báo "message is not modified". */
function ignoreNotModified(err: unknown): void {
  if (!(err instanceof GrammyError && err.description.includes("message is not modified")))
    throw err;
}

/**
 * Chat nào đang chờ người dùng gõ chữ, và chữ đó cho luồng nào: "Tự thêm chủ đề" hay "Sửa mô tả".
 * Dùng chung một Map để bấm luồng này thì luồng kia thôi chờ (chữ gõ sau chỉ thuộc một luồng).
 */
type Awaiting = Map<string, "topic" | "profile">;

/** Lệnh chọn chủ đề: /start, /topics, nút bật tắt, và luồng "Tự thêm chủ đề" hai bước. */
function registerTopicCommands(bot: Bot, topics: TopicHandlers, awaiting: Awaiting): void {
  // Trạng thái hội thoại "Tự thêm chủ đề" chỉ giữ trong bộ nhớ: bot khởi động lại thì làm lại từ
  // đầu, không mất gì đã lưu. Một người dùng nên một Map là đủ.
  const drafts = new Map<string, CustomTopicDraft>();

  const showTopics = async (ctx: Context) => {
    await ctx.reply(TOPICS_TEXT, { reply_markup: topicsKeyboard(await topics.list()) });
  };

  bot.command(["start", "topics"], async (ctx) => {
    awaiting.delete(String(ctx.chat.id));
    await showTopics(ctx);
  });

  bot.callbackQuery(/^tp:t:([lc]:\d+)$/, async (ctx) => {
    const key = ctx.match[1] ?? "";
    const on = await topics.toggle(key);
    const items = await topics.list();
    const label = items.find((t) => t.key === key)?.label ?? "";
    await ctx.answerCallbackQuery({ text: `${on ? "Đã bật" : "Đã tắt"}: ${label}` });
    await ctx
      .editMessageReplyMarkup({ reply_markup: topicsKeyboard(items) })
      .catch(ignoreNotModified);
  });

  bot.callbackQuery("tp:add", async (ctx) => {
    const chat = String(ctx.chat?.id);
    awaiting.set(chat, "topic");
    await ctx.answerCallbackQuery();
    await ctx.reply(ADD_PROMPT, {
      reply_markup: { force_reply: true, input_field_placeholder: "Tên chủ đề, rồi mô tả" },
    });
  });

  bot.callbackQuery("tp:done", async (ctx) => {
    const n = (await topics.list()).filter((t) => t.chosen).length;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`Đã lưu: bạn đang theo dõi ${n} chủ đề. Gõ /topics để sửa.`);
  });

  bot.callbackQuery("tp:save", async (ctx) => {
    const chat = String(ctx.chat?.id);
    const d = drafts.get(chat);
    if (!d) {
      await ctx.answerCallbackQuery({ text: "Bản nháp đã hết hạn, hãy thêm lại" });
      return;
    }
    await topics.addCustom(d);
    drafts.delete(chat);
    await ctx.answerCallbackQuery({ text: "Đã lưu" });
    await ctx.editMessageText(
      `Đã thêm chủ đề: ${escapeHtml(d.label)}. Gõ /topics để xem danh sách.`,
      {
        parse_mode: "HTML",
      },
    );
  });

  bot.callbackQuery("tp:cancel", async (ctx) => {
    drafts.delete(String(ctx.chat?.id));
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Đã huỷ, không lưu gì.");
  });

  bot.on("message:text", async (ctx, next) => {
    const chat = String(ctx.chat.id);
    if (awaiting.get(chat) !== "topic") return next();
    const input = parseTopicInput(ctx.message.text);
    if (!input) return;
    awaiting.delete(chat);
    await ctx.replyWithChatAction("typing");
    const draft: CustomTopicDraft = {
      label: input.label,
      description: input.description,
      embedText: await topics.describe(input.label, input.description),
    };
    drafts.set(chat, draft);
    await ctx.reply(draftText(draft), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("Lưu", "tp:save")
        .success()
        .text("Huỷ", "tp:cancel")
        .danger(),
    });
  });
}

const PROFILE_PROMPT =
  "Viết vài câu về bạn: bạn làm gì, dùng công nghệ gì, muốn theo dõi và tìm hiểu thêm điều gì. Tiếng Việt hay tiếng Anh đều được.";

const WELCOME =
  "Chào bạn! radard gửi điểm tin AI mỗi sáng theo các chủ đề bạn chọn. Trước hết, hãy kể một chút về bạn để radard gợi ý chủ đề.";

const SUGGEST_UNAVAILABLE = "Gợi ý chủ đề tạm thời chưa dùng được, bạn thử lại sau nhé.";

const SUGGEST_EXPIRED = "Gợi ý này đã cũ, gõ /profile để xem lại";

/** Lời /profile hiện ra: lời người dùng; chưa có thì bối cảnh cũ (tiếng Anh) và lời mời tự viết. */
export function profileText(p: ProfileView): string {
  const cut = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
  if (p.description) {
    return [
      "<b>Mô tả của bạn</b>",
      escapeHtml(cut(p.description)),
      "radard dựa vào mô tả này để gợi ý chủ đề và viết vì sao mỗi tin đáng chú ý với bạn.",
    ].join("\n\n");
  }
  if (p.promptContext) {
    return [
      "Bạn chưa tự viết mô tả. Hiện radard đang dùng đoạn mô tả có sẵn sau:",
      `<i>${escapeHtml(cut(p.promptContext))}</i>`,
      "Bấm Sửa mô tả để viết bằng lời của bạn.",
    ].join("\n\n");
  }
  return "Bạn chưa có mô tả. Bấm Sửa mô tả để viết vài câu về bạn.";
}

/** [Sửa mô tả] [Gợi ý chủ đề]; chưa có bối cảnh thì chưa gợi ý được, chỉ còn nút đầu. */
export function profileKeyboard(p: ProfileView): InlineKeyboard {
  const kb = new InlineKeyboard().text("Sửa mô tả", "pf:edit").primary();
  return p.promptContext ? kb.text("Gợi ý chủ đề", "pf:sug").primary() : kb;
}

/**
 * Trạng thái một tin gợi ý: lựa chọn đang tích dở, cả chủ đề thư viện lẫn chủ đề mới (chưa tạo gì
 * cho tới khi bấm Lưu). Chỉ giữ trong bộ nhớ.
 */
export interface SuggestState {
  topics: SuggestedTopic[];
  newTopics: (ProposedTopicItem & { checked: boolean })[];
  expiresAt: number;
}

/** Tin gợi ý cũ quá thời gian này thì nút không dùng được nữa (gõ /profile để gợi ý lại). */
export const SUGGEST_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Lời của tin gợi ý. Bộ nút Telegram không có tiêu đề nhóm, nên lời tin nói nhóm nào gồm chủ đề nào;
 * bộ nút xếp đúng thứ tự đó (nên theo dõi, có thể quan tâm, đang theo dõi; mỗi nhóm một hàng mới).
 */
export function suggestText(s: Pick<SuggestState, "topics" | "newTopics">): string {
  const names = (tier: SuggestedTopic["tier"]) =>
    s.topics
      .filter((t) => t.tier === tier)
      .map((t) => escapeHtml(t.label))
      .join(", ");
  const parts = ["<b>Gợi ý chủ đề cho bạn</b>"];
  const lines: string[] = [];
  const must = names("preselect");
  const maybe = names("maybe");
  const followed = names("followed");
  if (must) lines.push(`Nên theo dõi: ${must}.`);
  if (maybe) lines.push(`Có thể bạn quan tâm: ${maybe}.`);
  if (followed) lines.push(`Đang theo dõi: ${followed}.`);
  if (lines.length > 0) {
    parts.push(lines.join("\n"));
    parts.push("Bấm để chọn hoặc bỏ (✓ là đang chọn), rồi bấm Lưu.");
  } else {
    parts.push("Chưa thấy chủ đề nào trong danh sách hợp với bạn. Gõ /topics để tự chọn.");
  }
  if (s.newTopics.length > 0) {
    parts.push(
      [
        "Chủ đề mới, chưa có trong danh sách:",
        ...s.newTopics.map((t) => `• <b>${escapeHtml(t.label)}</b>: ${escapeHtml(t.why)}`),
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

/** Nút của tin gợi ý: chủ đề hai nút một hàng theo nhóm, mỗi chủ đề mới một hàng, cuối cùng là Lưu. */
export function suggestKeyboard(s: Pick<SuggestState, "topics" | "newTopics">): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const tier of ["preselect", "maybe", "followed"] as const) {
    const group = s.topics.filter((t) => t.tier === tier);
    group.forEach((t, i) => {
      kb.text(t.checked ? `${CHECK} ${t.label}` : t.label, `pf:t:${t.key}`);
      if (t.checked) kb.success();
      if (i % 2 === 1 || i === group.length - 1) kb.row();
    });
  }
  s.newTopics.forEach((t, i) => {
    // Bật tắt như các chủ đề khác; chủ đề chỉ được tạo khi bấm Lưu.
    if (t.checked) kb.text(`${CHECK} ${t.label}`, `pf:n:${i}`).success();
    else kb.text(`Thêm "${t.label}"`, `pf:n:${i}`);
    kb.row();
  });
  return kb.text("Lưu", "pf:save").success();
}

/** Lệnh /profile: xem và sửa mô tả, gợi ý chủ đề; và /start của người dùng mới. */
function registerProfileCommands(bot: Bot, profile: ProfileHandlers, awaiting: Awaiting): void {
  // Lựa chọn đang tích dở của từng tin gợi ý, theo message_id (mỗi lần gợi ý là một tin mới, tin cũ
  // vẫn bấm được tới khi hết hạn). Chỉ giữ trong bộ nhớ như bản nháp "Tự thêm chủ đề": bot khởi
  // động lại thì gợi ý lại, không mất gì đã lưu. Chỉ một chat được dùng bot nên message_id là đủ.
  const states = new Map<number, SuggestState>();
  const recall = (id: number | undefined) => {
    if (id === undefined) return undefined;
    const s = states.get(id);
    if (s && s.expiresAt > Date.now()) return s;
    states.delete(id);
    return undefined;
  };
  const remember = (id: number, s: SuggestState) => {
    const now = Date.now();
    for (const [k, v] of states) if (v.expiresAt <= now) states.delete(k);
    states.set(id, s);
  };

  const askDescription = async (ctx: Context) => {
    awaiting.set(String(ctx.chat?.id), "profile");
    await ctx.reply(PROFILE_PROMPT, {
      reply_markup: { force_reply: true, input_field_placeholder: "Vài câu về bạn" },
    });
  };

  const sendSuggestions = async (ctx: Context) => {
    await ctx.replyWithChatAction("typing");
    const s: ProfileSuggestions | null = await profile.suggest().catch((err) => {
      log.error("gợi ý chủ đề lỗi", describeError(err));
      return null;
    });
    if (!s) {
      await ctx.reply(SUGGEST_UNAVAILABLE);
      return;
    }
    const state: SuggestState = {
      topics: s.topics.map((t) => ({ ...t })),
      newTopics: s.newTopics.map((t) => ({ ...t, checked: false })),
      expiresAt: Date.now() + SUGGEST_TTL_MS,
    };
    const empty = state.topics.length === 0 && state.newTopics.length === 0;
    const sent = await ctx.reply(suggestText(state), {
      parse_mode: "HTML",
      ...(empty ? {} : { reply_markup: suggestKeyboard(state) }),
    });
    if (!empty) remember(sent.message_id, state);
  };

  bot.command("start", async (ctx, next) => {
    const p = await profile.get();
    if (p.description || p.promptContext) return next();
    await ctx.reply(WELCOME);
    await askDescription(ctx);
  });

  bot.command("profile", async (ctx) => {
    awaiting.delete(String(ctx.chat.id));
    const p = await profile.get();
    await ctx.reply(profileText(p), { parse_mode: "HTML", reply_markup: profileKeyboard(p) });
  });

  bot.callbackQuery("pf:edit", async (ctx) => {
    await ctx.answerCallbackQuery();
    await askDescription(ctx);
  });

  bot.callbackQuery("pf:sug", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendSuggestions(ctx);
  });

  bot.callbackQuery(/^pf:t:(l:\d+)$/, async (ctx) => {
    const s = recall(ctx.callbackQuery.message?.message_id);
    const t = s?.topics.find((x) => x.key === ctx.match[1]);
    if (!s || !t) {
      await ctx.answerCallbackQuery({ text: SUGGEST_EXPIRED });
      return;
    }
    t.checked = !t.checked;
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: suggestKeyboard(s) }).catch(ignoreNotModified);
  });

  bot.callbackQuery(/^pf:n:(\d)$/, async (ctx) => {
    const s = recall(ctx.callbackQuery.message?.message_id);
    const t = s?.newTopics[Number(ctx.match[1])];
    if (!s || !t) {
      await ctx.answerCallbackQuery({ text: SUGGEST_EXPIRED });
      return;
    }
    t.checked = !t.checked;
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: suggestKeyboard(s) }).catch(ignoreNotModified);
  });

  bot.callbackQuery("pf:save", async (ctx) => {
    const id = ctx.callbackQuery.message?.message_id;
    const s = recall(id);
    if (!s || id === undefined) {
      await ctx.answerCallbackQuery({ text: SUGGEST_EXPIRED });
      return;
    }
    // Bỏ trạng thái trước khi ghi: bấm Lưu hai lần liền nhau cũng chỉ tạo chủ đề mới một lần.
    states.delete(id);
    let n: number;
    try {
      // Chỉ đụng tới chủ đề hiện trong tin: chủ đề thư viện khác (chưa theo dõi) giữ nguyên.
      n = await profile.apply(
        s.topics.filter((t) => t.checked).map((t) => t.key),
        s.topics.filter((t) => !t.checked).map((t) => t.key),
        s.newTopics
          .filter((t) => t.checked)
          .map((t) => ({ label: t.label, why: t.why, embedText: t.embedText })),
      );
    } catch (err) {
      states.set(id, s);
      log.error("lưu gợi ý lỗi", describeError(err));
      await ctx.answerCallbackQuery({ text: "Chưa lưu được, bạn thử lại nhé" });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Đã lưu" });
    await ctx.editMessageText(
      `Đã lưu: bạn đang theo dõi ${n} chủ đề. Điểm tin lần tới sẽ dùng các chủ đề này.`,
    );
  });

  bot.on("message:text", async (ctx, next) => {
    const chat = String(ctx.chat.id);
    if (awaiting.get(chat) !== "profile") return next();
    const text = ctx.message.text.trim();
    if (!text) return;
    awaiting.delete(chat);
    await ctx.replyWithChatAction("typing");
    const { rewritten } = await profile.saveDescription(text);
    if (!rewritten) {
      await ctx.reply(`Đã lưu mô tả của bạn. ${SUGGEST_UNAVAILABLE}`);
      return;
    }
    await ctx.reply("Đã lưu mô tả. Đang tìm chủ đề hợp với bạn…");
    await sendSuggestions(ctx);
  });
}

export interface TelegramChatOptions extends TelegramOptions {
  /**
   * Chế độ một bộ xử lý cố định: chỉ xử lý update từ chat này; mọi chat khác bị bỏ qua, im lặng.
   * Không đặt thì `createTelegramBot` từ chối mọi chat (fail-closed); đa người dùng dùng
   * `createTelegramRouter` / `start(resolver)` thay vì tuỳ chọn này.
   */
  allowedChatId?: string;
  /** Có sẵn thì Bot không gọi `getMe` lúc khởi động (test). */
  botInfo?: UserFromGetMe;
}

/** Dựng Bot với đủ middleware; tách riêng để test đưa update giả vào bằng `handleUpdate`. */
export function createTelegramBot(opts: TelegramChatOptions, handlers: ChatHandlers): Bot {
  const bot = new Bot(opts.token, opts.botInfo ? { botInfo: opts.botInfo } : {});
  withRetry(bot.api, opts.transformer);

  bot.use(async (ctx, next) => {
    // ctx.chat gom chat id của mọi loại update (tin nhắn, lượt bấm) về một chỗ.
    if (opts.allowedChatId !== undefined && String(ctx.chat?.id) === opts.allowedChatId) {
      await next();
    }
  });

  bot.callbackQuery(/^fb:(like|dislike)$/, async (ctx) => {
    const kind = ctx.match[1] as FeedbackKind;
    const message = ctx.callbackQuery.message;
    if (!message) {
      await ctx.answerCallbackQuery();
      return;
    }
    const res = await handlers.onFeedback({
      channel: CHANNEL,
      recipient: String(message.chat.id),
      messageId: String(message.message_id),
      kind,
      sourceId: `cb:${ctx.callbackQuery.id}`,
    });
    const state = res.state ?? kind;
    await ctx.answerCallbackQuery({
      text: state === "none" ? "Đã bỏ chọn" : `Đã ghi nhận ${LABELS[state]}`,
    });
    const kb = feedbackKeyboard(
      [
        { id: "like", label: LABELS.like },
        { id: "dislike", label: LABELS.dislike },
      ],
      state === "none" ? undefined : state,
    );
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(ignoreNotModified);
  });

  const awaiting: Awaiting = new Map();
  // /profile đăng ký trước: nó bắt /start của người dùng mới, còn lại chuyển cho /topics.
  if (handlers.profile) registerProfileCommands(bot, handlers.profile, awaiting);
  const topics = handlers.topics;
  if (topics) registerTopicCommands(bot, topics, awaiting);

  // Tin nhắn thường (chưa có tính năng nhận xét bằng chữ): chỉ dẫn lệnh, không ghi gì.
  bot.on("message:text", (ctx) =>
    ctx.reply(topics ? "Gõ /topics để chọn chủ đề theo dõi." : "radard chưa nhận tin nhắn chữ."),
  );

  // Nút lạ (tin cũ, phiên bản trước): trả lời để nút trên điện thoại không quay vòng mãi.
  bot.on("callback_query:data", (ctx) => ctx.answerCallbackQuery());

  // Không có bot.catch thì một lỗi (DB rớt mạng một giây) làm dừng cả bot.
  bot.catch((err) => log.error("xử lý update lỗi", describeError(err.error)));
  return bot;
}

/**
 * Đa người dùng: một Bot "cổng" nhận mọi update, tra chat → bộ xử lý của hồ sơ qua `resolve`.
 * `null` (chat không có quyền): bỏ qua, im lặng, không gọi handler nào. Có quyền: chuyển update cho
 * một Bot con của đúng chat đó (lưu theo chat + `scope` hồ sơ; đổi hồ sơ thì dựng lại), nên trạng thái
 * hội thoại (đang chờ nhập mô tả…) cũng tách theo chat.
 */
export function createTelegramRouter(opts: TelegramChatOptions, resolve: ChatResolver): Bot {
  const gate = new Bot(opts.token, opts.botInfo ? { botInfo: opts.botInfo } : {});
  withRetry(gate.api, opts.transformer);
  const inner = new Map<string, { scope: string; bot: Bot }>();
  gate.use(async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const recipient = String(chatId);
    const found = await resolve(recipient);
    if (!found) return;
    let entry = inner.get(recipient);
    if (!entry || entry.scope !== found.scope) {
      entry = {
        scope: found.scope,
        bot: createTelegramBot(
          { ...opts, allowedChatId: recipient, botInfo: gate.botInfo },
          found.handlers,
        ),
      };
      inner.set(recipient, entry);
    }
    await entry.bot.handleUpdate(ctx.update);
  });
  gate.catch((err) => log.error("xử lý update lỗi", describeError(err.error)));
  return gate;
}

/**
 * Chạy `start` (long polling, chỉ trả về khi dừng) và chạy lại khi nó dừng vì lỗi, chờ 5, 10, 20…
 * giây, tối đa `maxDelayMs`. Lỗi 409 "terminated by other getUpdates request" xảy ra lúc chuyển giữa
 * hai bản deploy (13/10/2026: bot dừng hẳn 17 giây sau khi bản mới lên, lượt bấm không được ghi).
 * `onStarted` gọi khi polling chạy được, để đặt lại thời gian chờ. Dừng hẳn khi `stopped()` đúng.
 */
export function keepPolling(opts: {
  start: (onStarted: () => void) => Promise<void>;
  stopped: () => boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (err: unknown, delayMs: number) => void;
}): void {
  const base = opts.baseDelayMs ?? 5_000;
  const max = opts.maxDelayMs ?? 60_000;
  let attempt = 0;
  const run = () => {
    opts
      .start(() => {
        attempt = 0;
      })
      .catch((err) => {
        if (opts.stopped()) return;
        const delay = Math.min(max, base * 2 ** attempt++);
        opts.onRetry?.(err, delay);
        setTimeout(() => {
          if (!opts.stopped()) run();
        }, delay);
      });
  };
  run();
}

export function telegramChat(opts: TelegramChatOptions): ChatChannel {
  let bot: Bot | null = null;
  let stopping = false;
  return {
    channel: CHANNEL,
    async start(handlers) {
      const resolver = typeof handlers === "function";
      const b = resolver ? createTelegramRouter(opts, handlers) : createTelegramBot(opts, handlers);
      bot = b;
      if (resolver || handlers.topics) {
        // Menu lệnh khi gõ "/". Tên lệnh tiếng Anh, mô tả tiếng Việt (quyết định 12/10/2026).
        await b.api
          .setMyCommands([
            { command: "topics", description: "Chọn chủ đề theo dõi" },
            ...(resolver || handlers.profile
              ? [{ command: "profile", description: "Mô tả về bạn và nhận gợi ý chủ đề" }]
              : []),
            { command: "start", description: "Bắt đầu" },
          ])
          .catch((err) => log.warn("không đặt được menu lệnh", describeError(err)));
      }
      // Không await: bot.start() chỉ trả về khi bot dừng. Không dùng drop_pending_updates: nó
      // xoá cả lượt 👍 bạn bấm lúc bot tắt; khoá "cb:" + id đã lo phần giao lại.
      keepPolling({
        start: (onStarted) =>
          b.start({
            allowed_updates: ["callback_query", "message"],
            onStart: (me) => {
              onStarted();
              log.info("bot đang nhận update", { username: me.username });
            },
          }),
        stopped: () => stopping,
        onRetry: (err, delayMs) =>
          log.error("long polling dừng vì lỗi, sẽ chạy lại", { ...describeError(err), delayMs }),
      });
    },
    async stop() {
      stopping = true;
      // Xác nhận offset cuối với Telegram rồi đóng kết nối.
      await bot?.stop();
    },
  };
}
