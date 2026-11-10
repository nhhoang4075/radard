/**
 * Chỉ dẫn nhiệm vụ cho vector chủ đề. Qwen3-Embedding nhận chỉ dẫn ở phía truy vấn theo dạng
 * `Instruct: …\nQuery: …`, phía tài liệu thì để nguyên. Trong radard chủ đề là truy vấn, tin là
 * tài liệu, nên chỉ vector chủ đề có tiền tố này; vector tin không đổi.
 *
 * `TOPIC_RECIPE` ghi trên mỗi chủ đề đã embed (`topics.embedding_recipe`): đổi chỉ dẫn thì đổi
 * giá trị này, và job process sẽ embed lại các chủ đề (chỉ vài chục, không đụng vector tin).
 */
export const TOPIC_INSTRUCTION = "Given a topic description, retrieve news items about that topic";

export const TOPIC_RECIPE = "instruct-v1";

/** Văn bản đưa cho embedder khi embed một chủ đề (hoặc bản nháp chủ đề). */
export function topicQueryText(embedText: string): string {
  return `Instruct: ${TOPIC_INSTRUCTION}\nQuery: ${embedText}`;
}
