/**
 * Notification interface. The core (digest job) only knows these types; Telegram, Discord, Web Push are
 * adapters. Items are stored and passed in a NEUTRAL form: plain text, no HTML or markdown specific to any
 * channel; each adapter renders it itself (radard-thiet-ke.html, rule 2).
 */

/** Button feedback. Matches `feedback.kind`; `comment` (a text comment) comes later. */
export type FeedbackKind = "like" | "dislike";

/** An item's current opinion after a tap: `none` = not chosen, or unselected. */
export type FeedbackState = FeedbackKind | "none";

/** One link of an item. The job decides which links exist and their labels; the adapter only decides presentation. */
export interface Link {
  url: string;
  /** Visible text, e.g. the domain name "openai.com". The real link is still the full `url`. */
  label: string;
  /**
   * main: the most worth-reading article · related: other articles on the same topic · discussion: discussion page
   * (HN comments…).
   */
  role: "main" | "related" | "discussion";
}

export interface Message {
  kind: "digest" | "system";
  title: string;
  /** Each element is one paragraph, plain text. */
  lines: string[];
  /** All links of the item; an item has no other link fields. */
  links?: Link[];
  /** Number of related articles NOT in `links` (shown as "+N articles"). */
  moreRelated?: number;
  /** `for_me`: the "Với tôi?" button (not feedback, does not write `feedback`). */
  actions?: { id: FeedbackKind | "for_me"; label: string }[];
}

export interface Notifier {
  readonly channel: string;
  /** Send one item; returns the channel-side message id, which the job writes to `deliveries.message_id`. */
  send(recipient: string, msg: Message): Promise<{ messageId: string }>;
  /**
   * Re-render the feedback buttons of an already sent message so they show `state` (used when feedback was
   * written on another channel, e.g. the web). `forMe`: the message keeps its "Với tôi?" button.
   */
  refreshFeedbackMark(
    recipient: string,
    messageId: string,
    state: FeedbackState,
    opts: { forMe: boolean },
  ): Promise<void>;
}

/** One button tap, normalized to a neutral form. */
export interface FeedbackEvent {
  channel: string;
  recipient: string;
  /** The tapped item: linked back to `deliveries` via (channel, recipient, message_id). */
  messageId: string;
  kind: FeedbackKind;
  /**
   * The channel-side id of THIS tap (Telegram: `callback_query.id`). If the channel redelivers the same tap
   * (the bot restarts before it can confirm), the id is the same, so it is not written twice.
   */
  sourceId: string;
}

/** One "Với tôi?" tap on an item. */
export interface ForMeEvent {
  channel: string;
  recipient: string;
  /** The tapped item: linked back to `deliveries` via (channel, recipient, message_id). */
  messageId: string;
}

/** Result of "Với tôi?"; if `status` is not `ok`, the channel reports the matching error and there is no `text`. */
export type ForMeResult =
  | { status: "ok"; text: string }
  | { status: "not_found" | "limit" | "unavailable" };

/** A topic shown in the selection list: from the library, or added by the user. */
export interface TopicItem {
  /** Stable key for toggling: `l:<topics.id>` (library) or `c:<profile_topics.id>` (user-added). */
  key: string;
  label: string;
  chosen: boolean;
}

export interface CustomTopicDraft {
  label: string;
  /** The user's own words, kept in the language they wrote. */
  description: string;
  /** English phrase for embedding, written by the LLM from the user's words. */
  embedText: string;
}

/** Topic command that the chat channel passes to the core (step 5, week 3). */
export interface TopicHandlers {
  list(): Promise<TopicItem[]>;
  /** On/off; returns the new state. */
  toggle(key: string): Promise<boolean>;
  /** Write an English description (one LLM call). Saves nothing yet. */
  describe(label: string, text: string): Promise<string>;
  /** Save the user-added topic (now on). */
  addCustom(draft: CustomTopicDraft): Promise<void>;
}

/** Description of the user, as shown by the /profile command. */
export interface ProfileView {
  /** The text the user wrote about themselves (kept in their language); `null`: not written yet. */
  description: string | null;
  /** English context radard is using; empty string: none yet. */
  promptContext: string;
}

/** A library topic shown in the suggestion message, with its initial checkbox state. */
export interface SuggestedTopic {
  /** Same key form as `TopicItem` (`l:<topics.id>`). */
  key: string;
  label: string;
  /**
   * preselect: should follow · maybe: you may be interested · followed: not suggested, but the user
   * already follows it (still shown, so the suggestions cover every enabled library topic).
   */
  tier: "preselect" | "maybe" | "followed";
  /** Pre-checked: the "should follow" level, or the user already has this topic on. */
  checked: boolean;
}

/** A new topic (not yet in the library) that radard suggests. */
export interface ProposedTopicItem {
  label: string;
  /** Why it is suggested, one sentence in Vietnamese (shown to the user). */
  why: string;
  /** English phrase for embedding. */
  embedText: string;
}

export interface ProfileSuggestions {
  /** Should follow first, then may be interested (higher level first), then already followed. */
  topics: SuggestedTopic[];
  newTopics: ProposedTopicItem[];
}

/** The /profile command: description of the user and topic suggestions. */
export interface ProfileHandlers {
  get(): Promise<ProfileView>;
  /**
   * Save the user's words, then ask the LLM to rewrite the English context. `rewritten = false`: could not
   * (no LLM, or the call failed); the user's words are still saved, and the old context is kept.
   */
  saveDescription(text: string): Promise<{ rewritten: boolean }>;
  /** Suggestions based on the saved context. `null`: cannot suggest for now. */
  suggest(): Promise<ProfileSuggestions | null>;
  /**
   * Save the suggested topics: create (and enable) new `add` topics, enable `on` topics, disable `off` topics
   * (key `l:<id>`). Returns the number of followed topics, including the ones just created.
   */
  apply(on: string[], off: string[], add: ProposedTopicItem[]): Promise<number>;
}

export interface ChatHandlers {
  /**
   * Write feedback. `recorded = false`: already written earlier (the tap was redelivered). `state` = the item's
   * current opinion after the tap (tapping the already-selected button again gives `none`); if omitted, the channel
   * treats it as the button just tapped.
   */
  onFeedback(ev: FeedbackEvent): Promise<{ recorded: boolean; state?: FeedbackState }>;
  /**
   * "Với tôi?" button: the tapped item is looked up to the tapper's profile in the core (fail-closed). Without it, the
   * channel treats the button as unknown.
   */
  onForMe?(ev: ForMeEvent): Promise<ForMeResult>;
  /** Without it, the channel does not accept topic selection commands. */
  topics?: TopicHandlers;
  /** Without it, the channel does not accept /profile commands. */
  profile?: ProfileHandlers;
}

/**
 * Multi-user: look up the recipient (chat id) → handler of that exact profile. `null` = the recipient has no
 * permission: the channel ignores the update, does not reply and calls no handler (fail-closed).
 * `scope` identifies the profile behind the handler (the channel uses it to know when to rebuild the handler).
 */
export type ChatResolver = (
  recipient: string,
) => Promise<{ scope: string; handlers: ChatHandlers } | null>;

/** Inbound side: receives taps (later: commands, messages) from a channel. */
export interface ChatChannel {
  readonly channel: string;
  /** Start receiving; returns immediately, receiving runs in the background until `stop()`. */
  start(handlers: ChatHandlers | ChatResolver): Promise<void>;
  stop(): Promise<void>;
}
