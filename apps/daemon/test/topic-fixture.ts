/** Tạo một chủ đề tự thêm cho hồ sơ 1 và chọn nó; trả về `topics.id` (khoá của điểm và mặt bằng). */
import { type Database, profileTopics, topics } from "@radard/db";

export async function addTopic(
  db: Database,
  label: string,
  opts: { descriptionEn?: string; active?: boolean } = {},
): Promise<number> {
  const [t] = await db
    .insert(topics)
    .values({
      labelVi: label,
      descriptionEn: opts.descriptionEn ?? label,
      descriptionUser: label,
      origin: "custom",
      ownerProfileId: 1,
    })
    .returning({ id: topics.id });
  const id = t?.id ?? 0;
  await db.insert(profileTopics).values({ topicId: id, active: opts.active ?? true });
  return id;
}
