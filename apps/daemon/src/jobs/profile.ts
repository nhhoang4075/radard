/**
 * Description of the user (`/profile` command): the wording they wrote (`profile.description`) and the English context
 * the LLM rewrites from that wording (`profile.prompt_context`, used in the digest scoring prompt and topic suggestions).
 */
import { type LlmProvider, nfc } from "@radard/core";
import { type Database, profile } from "@radard/db";
import { eq } from "drizzle-orm";

export interface StoredProfile {
  description: string | null;
  promptContext: string;
}

/** Saved profile; if no row exists yet, both are empty. */
export async function readProfile(db: Database, profileId: number): Promise<StoredProfile> {
  const [p] = await db
    .select({ description: profile.description, promptContext: profile.promptContext })
    .from(profile)
    .where(eq(profile.id, profileId));
  const description = p?.description?.trim() || null;
  return { description, promptContext: p?.promptContext.trim() ?? "" };
}

/**
 * Writes the user's wording; if `promptContext` is given, the context is written too, otherwise the old context is kept. If no
 * profile exists yet, it is created (empty context if it cannot be written yet: the column does not allow null).
 */
export async function saveProfile(
  db: Database,
  profileId: number,
  description: string,
  promptContext?: string,
): Promise<void> {
  const text = nfc(description).trim();
  const set = {
    description: text,
    ...(promptContext ? { promptContext } : {}),
    updatedAt: new Date(),
  };
  await db
    .insert(profile)
    .values({ id: profileId, description: text, promptContext: promptContext ?? "" })
    .onConflictDoUpdate({ target: profile.id, set });
}

const READER_SYSTEM = `You write the reader profile for a daily AI/ML news digest, from the reader's own words (any language).
The profile is used when choosing news topics for the reader and when explaining why a story matters to them.
Write 60 to 160 words in English, in the third person ("The reader ...").
Be concrete: their role, what they build, the languages, frameworks, tools and data stores they use, the topics they want to follow, and what they want to learn or have explained.
Use only what the reader said; never invent facts such as employers, seniority, tools or interests they did not mention. If the reader said little, write less rather than pad.
Reply with the profile text only: no heading, no quotes, no list.`;

/** One LLM call: user wording (Vietnamese or English) → English context, like `describeTopic`. */
export async function describeReader(llm: LlmProvider, text: string): Promise<string> {
  const reply = await llm.generateText({
    task: "profile_describe",
    system: READER_SYSTEM,
    prompt: `The reader's own words:\n${text}`,
    // The model's hidden thinking tokens count toward this cap (measured 11/10/2026): keep it generous.
    maxOutputTokens: 2000,
  });
  const out = nfc(reply)
    .trim()
    .replace(/^["“]|["”]$/g, "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
  // The 60–160 word range is a requirement for the model; the check is looser so a good answer is not dropped just for missing a few words.
  const words = out.split(/\s+/).filter(Boolean).length;
  if (words < 10 || words > 250) {
    throw new Error(`model trả bối cảnh không dùng được: ${JSON.stringify(reply.slice(0, 200))}`);
  }
  return out;
}
