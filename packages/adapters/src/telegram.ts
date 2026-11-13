/**
 * Telegram adapter (grammY): sends messages with 👍/👎 buttons (`Notifier`) and receives presses (`ChatChannel`).
 *
 * Only the `packages/adapters` folder may import grammY (radard-thiet-ke.html, rule 1). Explains
 * the Bot API and the choices made here: docs/notifier-telegram.html.
 *
 *   - Buttons carry only `fb:like` / `fb:dislike`, not the delivery id: that id does not exist yet when sending.
 *     A press always comes with `message_id` and `chat.id`, enough to find the message again.
 *   - Strangers are filtered once at the start of the middleware chain, before any DB query or LLM call.
 *   - The token is in the Bot API URL: logs record only the method name and error description, never the URL.
 */
import { autoRetry } from "@grammyjs/auto-retry";
import {
  type ChatChannel,
  type ChatHandlers,
  type ChatResolver,
  type CustomTopicDraft,
  createLogger,
  type FeedbackKind,
  type FeedbackState,
  FOR_ME_LABELS,
  type ForMeResult,
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

/** Telegram lets a bot send about 1 message/second to one chat. */
const MIN_INTERVAL_MS = 1000;
/** Limit of 4.096 characters per message (counted after removing tags); leave room for the title and link. */
const MAX_TEXT = 3800;

/** Escape for `parse_mode: "HTML"`: `&` first, otherwise it would corrupt the results of the later replacements. */
export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function anchor(l: Link): string {
  return `<a href="${escapeHtml(l.url).replaceAll('"', "&quot;")}">${escapeHtml(l.label)}</a>`;
}

/**
 * Neutral message → Telegram HTML. No `<br>`/`<p>`: line breaks use `\n`.
 * Links are laid out by role: the main link on one line, other articles grouped on one line separated by " · ",
 * the discussion page on one line. The visible text is a label; tapping opens the full `url`.
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

/** Data of the "Với tôi?" button: carries no item id; the press's `message_id` and `chat.id` are enough. */
const FOR_ME_DATA = "fm:ask";
/** Length limit of a Telegram message (characters), leaving room for the truncation mark. */
const MAX_REPLY_CHARS = 4000;

/**
 * The "đang chọn" mark: ✓ monochrome (U+2713, shown like text), not a colour emoji such as ✅ (requested
 * 13/10/2026). Paired with button colours (`style` of the Bot API: success green, primary blue, danger
 * red); older Telegram clients that do not show colours still tell them apart by the ✓ mark.
 */
const CHECK = "✓";

/**
 * The 👍/👎 button set; the selected button has a ✓ so you can see what you picked. Press the other button to change your mind, press
 * the selected button again to deselect (without passing `chosen`, both buttons are unselected).
 */
export function feedbackKeyboard(
  actions: NonNullable<Message["actions"]>,
  chosen?: FeedbackKind,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const a of actions) {
    if (a.id === "for_me") {
      kb.text(a.label, FOR_ME_DATA);
      continue;
    }
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

/** The keyboard of a sent item for the item's current `state`; shared by the press path and `refreshFeedbackMark`. */
export function feedbackStateKeyboard(state: FeedbackState, forMe: boolean): InlineKeyboard {
  return feedbackKeyboard(
    [
      { id: "like", label: LABELS.like },
      { id: "dislike", label: LABELS.dislike },
      ...(forMe ? [{ id: "for_me" as const, label: FOR_ME_LABELS.button }] : []),
    ],
    state === "none" ? undefined : state,
  );
}

/** Topic list as on/off buttons, two per row; the last ones are "Tự thêm chủ đề" and "Xong". */
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
 * The message wording calls the digest "điểm tin", not "digest" (a technical term; you chose on 13/10/2026).
 * "digest" is now only a name in code and DB.
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

/** Splits the user's message: the first line is the name, the rest is the description (if missing, the name is used). */
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

/** Error description safe to log: never contains a URL (it holds the token). */
export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof GrammyError) {
    return { method: err.method, code: err.error_code, description: err.description };
  }
  if (err instanceof HttpError) return { network: true, message: err.message };
  return { message: err instanceof Error ? err.message : String(err) };
}

export interface TelegramOptions {
  token: string;
  /** Replaces every Bot API call (tests). If not set, calls the real api.telegram.org. */
  transformer?: Transformer;
}

function withRetry<A extends { config: { use(t: Transformer): void } }>(api: A, t?: Transformer) {
  if (t) api.config.use(t);
  // 429: wait exactly retry_after; 5xx: retry a few times. Other 4xx are our error and are not retried.
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
          // Without disabling it, each of the 7 morning messages gets a very long link preview.
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
    async refreshFeedbackMark(recipient, messageId, state, opts) {
      await api
        .editMessageReplyMarkup(recipient, Number(messageId), {
          reply_markup: feedbackStateKeyboard(state, opts.forMe),
        })
        .catch(ignoreNotModified);
    },
  };
}

/** Pressing the already-selected button again leaves the button set unchanged: Telegram reports "message is not modified". */
function ignoreNotModified(err: unknown): void {
  if (!(err instanceof GrammyError && err.description.includes("message is not modified")))
    throw err;
}

/**
 * Which chat is waiting for the user to type text, and which flow that text belongs to: "Tự thêm chủ đề" or "Sửa mô tả".
 * One shared Map: starting one flow stops the other from waiting (text typed next belongs to one flow only).
 */
type Awaiting = Map<string, "topic" | "profile">;

/** Topic selection commands: /start, /topics, on/off buttons, and the two-step "Tự thêm chủ đề" flow. */
function registerTopicCommands(bot: Bot, topics: TopicHandlers, awaiting: Awaiting): void {
  // The "Tự thêm chủ đề" conversation state is kept only in memory: if the bot restarts, it starts over from
  // the beginning; nothing saved is lost. One Map per user is enough.
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

/** Text shown by /profile: the user's words; if none yet, the old context (English) and an invitation to write one. */
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

/** [Sửa mô tả] [Gợi ý chủ đề]; without context no suggestion is possible, so only the first button remains. */
export function profileKeyboard(p: ProfileView): InlineKeyboard {
  const kb = new InlineKeyboard().text("Sửa mô tả", "pf:edit").primary();
  return p.promptContext ? kb.text("Gợi ý chủ đề", "pf:sug").primary() : kb;
}

/**
 * State of one suggestion message: the in-progress selection, both library topics and new topics (nothing created
 * until Lưu is pressed). Kept in memory only.
 */
export interface SuggestState {
  topics: SuggestedTopic[];
  newTopics: (ProposedTopicItem & { checked: boolean })[];
  expiresAt: number;
}

/** Suggestion messages older than this have dead buttons (type /profile to get suggestions again). */
export const SUGGEST_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Text of the suggestion message. The Telegram button set has no group titles, so the text says which group holds which topics;
 * the buttons follow that same order (should follow, may interest, following; each group starts a new row).
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

/** Buttons of a suggestion message: topics two per row by group, each new topic on its own row, Lưu last. */
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
    // On/off like other topics; a topic is created only when Lưu is pressed.
    if (t.checked) kb.text(`${CHECK} ${t.label}`, `pf:n:${i}`).success();
    else kb.text(`Thêm "${t.label}"`, `pf:n:${i}`);
    kb.row();
  });
  return kb.text("Lưu", "pf:save").success();
}

/** /profile command: view and edit the description, suggest topics; and /start for new users. */
function registerProfileCommands(bot: Bot, profile: ProfileHandlers, awaiting: Awaiting): void {
  // In-progress selection of each suggestion message, keyed by message_id (each suggestion is a new message; old ones
  // stay tappable until they expire). Kept in memory like the "Tự thêm chủ đề" draft: if the bot restarts,
  // suggestions are made again, nothing saved is lost. Only one chat uses the bot, so message_id is enough.
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
    // Clear the state before writing: pressing Lưu twice in a row also creates the new topic only once.
    states.delete(id);
    let n: number;
    try {
      // Only touches topics shown in the message: other library topics (not followed) stay unchanged.
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
   * Single fixed-handler mode: only handles updates from this chat; every other chat is silently ignored.
   * Without it, `createTelegramBot` rejects every chat (fail-closed); multi-user uses
   * `createTelegramRouter` / `start(resolver)` instead of this option.
   */
  allowedChatId?: string;
  /** If set, the Bot does not call `getMe` at startup (tests). */
  botInfo?: UserFromGetMe;
}

/** Builds the Bot with all middleware; kept separate so tests can feed fake updates via `handleUpdate`. */
export function createTelegramBot(opts: TelegramChatOptions, handlers: ChatHandlers): Bot {
  const bot = new Bot(opts.token, opts.botInfo ? { botInfo: opts.botInfo } : {});
  withRetry(bot.api, opts.transformer);

  bot.use(async (ctx, next) => {
    // ctx.chat gathers the chat id of every update type (messages, presses) in one place.
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
    // Keep the "Với tôi?" button if the message has it (old messages from before the button existed get none).
    const hasForMe =
      "reply_markup" in message &&
      Boolean(
        message.reply_markup?.inline_keyboard.some((row) =>
          row.some((b) => "callback_data" in b && b.callback_data === FOR_ME_DATA),
        ),
      );
    const kb = feedbackStateKeyboard(state, hasForMe);
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(ignoreNotModified);
  });

  // "Với tôi?": the core looks up the message's profile for this chat (unknown chats were blocked at the start of the middleware chain).
  bot.callbackQuery(FOR_ME_DATA, async (ctx) => {
    const message = ctx.callbackQuery.message;
    if (!message || !handlers.onForMe) {
      await ctx.answerCallbackQuery();
      return;
    }
    // Answer right away so the button does not spin while the model writes.
    await ctx.answerCallbackQuery({ text: FOR_ME_LABELS.working });
    let res: ForMeResult;
    try {
      res = await handlers.onForMe({
        channel: CHANNEL,
        recipient: String(message.chat.id),
        messageId: String(message.message_id),
      });
    } catch (err) {
      log.error("Với tôi? lỗi", describeError(err));
      res = { status: "unavailable" };
    }
    const text =
      res.status === "ok"
        ? res.text.length > MAX_REPLY_CHARS
          ? `${res.text.slice(0, MAX_REPLY_CHARS)}…`
          : res.text
        : res.status === "not_found"
          ? FOR_ME_LABELS.notFound
          : res.status === "limit"
            ? FOR_ME_LABELS.limit
            : FOR_ME_LABELS.unavailable;
    await ctx.reply(text, {
      reply_parameters: { message_id: message.message_id },
      link_preview_options: { is_disabled: true },
    });
  });

  const awaiting: Awaiting = new Map();
  // /profile is registered first: it catches /start for new users, the rest passes to /topics.
  if (handlers.profile) registerProfileCommands(bot, handlers.profile, awaiting);
  const topics = handlers.topics;
  if (topics) registerTopicCommands(bot, topics, awaiting);

  // Regular messages (no written-comment feature yet): only point to commands, write nothing.
  bot.on("message:text", (ctx) =>
    ctx.reply(topics ? "Gõ /topics để chọn chủ đề theo dõi." : "radard chưa nhận tin nhắn chữ."),
  );

  // Unknown button (old message, previous version): answer so the button on the phone does not spin forever.
  bot.on("callback_query:data", (ctx) => ctx.answerCallbackQuery());

  // Without bot.catch, one error (the DB dropping its network for a second) would stop the whole bot.
  bot.catch((err) => log.error("xử lý update lỗi", describeError(err.error)));
  return bot;
}

/**
 * Multi-user: one "gate" Bot receives every update and looks up the chat → the profile's handler via `resolve`.
 * `null` (chat with no rights): ignored silently, no handler is called. With rights: the update is passed to
 * a child Bot for that exact chat (stored by chat + profile `scope`; a profile change rebuilds it), so conversation state
 * (waiting for a description…) is also kept per chat.
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
 * Runs `start` (long polling, returns only when stopped) and reruns it when it stops because of an error, waiting 5, 10, 20…
 * seconds, up to `maxDelayMs`. Error 409 "terminated by other getUpdates request" happens when switching between
 * two deploys (13/10/2026: the bot stopped for 17 seconds after the new version went up, and presses were not recorded).
 * `onStarted` is called when polling runs, to reset the wait time. Stops for good when `stopped()` returns true.
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
        // Command menu shown when typing "/". Command names in English, descriptions in Vietnamese (decision 12/10/2026).
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
      // Not awaited: bot.start() returns only when the bot stops. Do not use drop_pending_updates: it
      // also deletes the 👍 presses made while the bot was off; the "cb:" + id key already handles redelivery.
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
      // Confirm the last offset with Telegram, then close the connection.
      await bot?.stop();
    },
  };
}
