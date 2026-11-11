/**
 * Task instruction for the topic vector. Qwen3-Embedding takes the instruction on the query side in the form
 * `Instruct: …\nQuery: …`, while the document side is left as is. In radard a topic is the query and a story is
 * a document, so only topic vectors get this prefix; story vectors do not change.
 *
 * `TOPIC_RECIPE` is recorded for every embedded topic (`topics.embedding_recipe`): changing the instruction changes
 * this value, and the process job re-embeds the topics (only a few dozen; story vectors are untouched).
 */
export const TOPIC_INSTRUCTION = "Given a topic description, retrieve news items about that topic";

export const TOPIC_RECIPE = "instruct-v1";

/** Text given to the embedder when embedding a topic (or a topic draft). */
export function topicQueryText(embedText: string): string {
  return `Instruct: ${TOPIC_INSTRUCTION}\nQuery: ${embedText}`;
}
