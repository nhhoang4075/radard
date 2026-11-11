/** Create a custom topic for profile 1 and select it; returns `topics.id` (the key for scores and baselines). */
import { type Database, profileTopics, topics } from "@radard/db";

export async function addTopic(
  db: Database,
  label: string,
  opts: { embedText?: string; active?: boolean } = {},
): Promise<number> {
  const [t] = await db
    .insert(topics)
    .values({
      name: label,
      embedText: opts.embedText ?? label,
      description: label,
      origin: "custom",
      ownerProfileId: 1,
    })
    .returning({ id: topics.id });
  const id = t?.id ?? 0;
  await db.insert(profileTopics).values({ topicId: id, active: opts.active ?? true });
  return id;
}
