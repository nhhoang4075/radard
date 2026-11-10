/**
 * Mô tả về người dùng (lệnh /profile): lời họ tự viết (`profile.description`) và bối cảnh tiếng Anh
 * LLM viết lại từ lời đó (`profile.prompt_context`, dùng trong prompt điểm tin và gợi ý chủ đề).
 */
import { type LlmProvider, nfc } from "@radard/core";
import { type Database, profile } from "@radard/db";
import { eq } from "drizzle-orm";

export interface StoredProfile {
  description: string | null;
  promptContext: string;
}

/** Hồ sơ đang lưu; chưa có dòng nào thì cả hai trống. */
export async function readProfile(db: Database, profileId: number): Promise<StoredProfile> {
  const [p] = await db
    .select({ description: profile.description, promptContext: profile.promptContext })
    .from(profile)
    .where(eq(profile.id, profileId));
  const description = p?.description?.trim() || null;
  return { description, promptContext: p?.promptContext.trim() ?? "" };
}

/**
 * Ghi lời người dùng; có `promptContext` thì ghi luôn bối cảnh, không có thì giữ bối cảnh cũ. Chưa có
 * hồ sơ thì tạo (bối cảnh rỗng nếu chưa viết được: cột không cho null).
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

/** Một lời gọi LLM: lời người dùng (tiếng Việt hay tiếng Anh) → bối cảnh tiếng Anh, như `describeTopic`. */
export async function describeReader(llm: LlmProvider, text: string): Promise<string> {
  const reply = await llm.generateText({
    task: "profile_describe",
    system: READER_SYSTEM,
    prompt: `The reader's own words:\n${text}`,
    // Model có token suy nghĩ ẩn tính vào trần này (đo 11/10/2026): để rộng.
    maxOutputTokens: 2000,
  });
  const out = nfc(reply)
    .trim()
    .replace(/^["“]|["”]$/g, "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
  // Khung 60–160 từ là yêu cầu với model; kiểm rộng hơn để không bỏ câu tốt chỉ vì lệch vài từ.
  const words = out.split(/\s+/).filter(Boolean).length;
  if (words < 10 || words > 250) {
    throw new Error(`model trả bối cảnh không dùng được: ${JSON.stringify(reply.slice(0, 200))}`);
  }
  return out;
}
