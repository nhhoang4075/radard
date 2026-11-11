/**
 * AI interface. The core only knows these types; Vercel AI Gateway, direct provider calls or models
 * running locally are all adapters (ports & adapters).
 *
 * Every call reports to a `UsageSink` that writes to the `llm_calls` table: the cost is measured, not
 * estimated. Reasoning models have hidden thinking tokens billed at the output price, so they must be measured.
 */

/** The task a call serves, so cost can be broken down per pipeline step. */
export type AiTask = "embed_document" | "embed_profile" | "digest" | (string & {});

export interface UsageEvent {
  task: AiTask;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  /**
   * `gateway`: amount Gateway reports for this exact call (already tiered by prompt length,
   * cache, region). `estimate`: computed from Gateway's tiered price table, when Gateway reports no
   * amount. `unknown`: no price table either, cost recorded as 0.
   */
  costSource?: "gateway" | "estimate" | "unknown";
  /** Call id on the Gateway side, to match against the Vercel dashboard. */
  generationId?: string;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

export type UsageSink = (event: UsageEvent) => Promise<void>;

export interface EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  /** Fixed dimension; adapters must reject other sizes to avoid corrupting the DB column. */
  readonly dimensions: number;
  embed(texts: string[], task: AiTask): Promise<number[][]>;
}

export interface LlmProvider {
  readonly provider: string;
  readonly model: string;
  generateText(opts: {
    task: AiTask;
    system?: string;
    prompt: string;
    maxOutputTokens?: number;
  }): Promise<string>;
}

/**
 * Questions for models that make decisions (Jev and similar): the model writes no text, it only returns the
 * requested type with probabilities. `boolean`: probability the answer is "yes". `choice`: pick one name
 * from `criteria` (name → option description), with a probability for each option.
 *
 * Each question asks one thing (advice from the Jev doc); several questions about the same state
 * are sent in one call.
 */
export type DecisionQuestion =
  | { readonly type: "boolean"; readonly instructions: string }
  | {
      readonly type: "choice";
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, string>>;
    };

export type DecisionAnswer<Q extends DecisionQuestion> = Q extends {
  type: "choice";
  criteria: infer C;
}
  ? {
      type: "choice";
      choice: Extract<keyof C, string>;
      /** Covers every option; the sum is approximately 1. */
      probabilities: Record<Extract<keyof C, string>, number>;
    }
  : { type: "boolean"; probability: number };

export interface DecisionResult<Qs extends Record<string, DecisionQuestion>> {
  answers: { [K in keyof Qs]: DecisionAnswer<Qs[K]> };
  usage: { inputTokens: number; costUsd: number };
  /** Id of the model that answered (the provider may return a more specific id than configured). */
  model: string;
}

/** Shared state that all questions consider: text, or a JSON object. */
export type DecisionState = string | { readonly [key: string]: unknown };

export interface DecisionProvider {
  readonly provider: string;
  readonly model: string;
  /** One call for all questions. An error, or the model refusing any question, fails the whole call. */
  decide<const Qs extends Record<string, DecisionQuestion>>(opts: {
    task: AiTask;
    state: DecisionState;
    questions: Qs;
  }): Promise<DecisionResult<Qs>>;
}
