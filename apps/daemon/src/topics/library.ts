/**
 * Topic library: topics radard prepares for users to pick, so they do not have to write anything themselves.
 *
 * The 14-topic set from 15/10/2026 (docs/bo-chu-de-moi.html) is split by exactly one question: what the news is
 * mainly about. The old 17-topic set mixed several ways of splitting (audience, activity, property, kind of
 * news), so one story fell into several boxes at once.
 *
 * Users only see `name`. `embedText` is the sentence used for embedding: written in English to
 * match the data, and lists only the included scope, with product names and specific techniques. Embedding does not understand negation:
 * writing "not X" into the sentence pulls it closer to X. These sentences were measured on 16.203 AI stories from
 * the last 30 days; editing any sentence means measuring again.
 *
 * `labelGuide` is the scope of the topic (what it includes and excludes, and which topic a story that overlaps belongs to); it is only
 * passed to the LLM when it labels stories in a digest; it is not embedded.
 *
 * To change a description sentence here, run `topics seed`: the library is updated, and the user topics that
 * were picked from the library receive the new sentence and are re-embedded. Changing `labelGuide` does not need re-embedding.
 */
export interface LibraryTopic {
  key: string;
  groupName: string;
  name: string;
  embedText: string;
  labelGuide: string;
}

export const TOPIC_LIBRARY: LibraryTopic[] = [
  {
    key: "llm_models",
    groupName: "Model",
    // "LLM: …" missed SLMs, on-device models and VLMs (16/10/2026); the key and the description sentence stay the same:
    // widening the description sentence would measure worse.
    name: "Model AI: phát hành và hành vi",
    embedText:
      "Large language models themselves: new model releases and open-weight models, model architecture, reasoning and chain of thought, model behavior, hallucination and faithfulness, interpretability, benchmarks and evaluations of LLMs",
    labelGuide:
      "AI models themselves: new model releases from any lab, open or closed weights, including small language models (SLMs), on-device models and vision-language models (VLMs); architecture, reasoning, model behavior, hallucination, benchmarks and evaluations, looking inside models (interpretability). Not: how models are trained or optimized (→ Huấn luyện và tối ưu model); agents (→ Agent AI); models that generate images, video or audio (→ Ảnh, video và âm thanh).",
  },
  {
    key: "training",
    groupName: "Model",
    name: "Huấn luyện và tối ưu model",
    embedText:
      "Training and optimizing models: pretraining, post-training, reinforcement learning with rewards, distillation, fine-tuning, quantization, KV cache, efficient attention, long context, making inference faster and cheaper",
    labelGuide:
      "Pretraining, post-training (RL, distillation), fine-tuning, quantization, KV cache, efficient attention, long context, making models faster and cheaper at the algorithm level. Not: hardware and servers that run models (→ Hạ tầng AI).",
  },
  {
    key: "agents",
    groupName: "Xây dựng với AI",
    name: "Agent AI",
    embedText:
      "AI agents: LLM agents that plan, use tools and take actions, agent memory, multi-agent systems, agent harnesses, computer-use and browser agents, Model Context Protocol servers",
    labelGuide:
      "Agents that plan, call tools and act; agent memory; multi-agent systems; MCP; computer-use and browser-use agents. Not: coding agents (→ Lập trình với AI); agent security (→ An toàn và bảo mật AI).",
  },
  {
    key: "ai_coding",
    groupName: "Xây dựng với AI",
    name: "Lập trình với AI",
    embedText:
      "AI for software development: AI coding assistants and coding agents such as Claude Code, Codex and Cursor, AI code generation and code review, the experience of programming with AI",
    labelGuide:
      "AI coding assistants and coding agents (Claude Code, Codex, Cursor…), code generation, AI code review, the experience of programming with AI. Not: programming tools that do not use AI.",
  },
  {
    key: "llm_apps",
    groupName: "Xây dựng với AI",
    name: "Xây ứng dụng LLM",
    embedText:
      "Building applications on LLMs: retrieval-augmented generation, embeddings and vector search, prompt and context engineering, structured output, LLM APIs and SDKs, reliability and observability of LLM apps",
    labelGuide:
      "RAG, embeddings and vector search, prompt and context engineering, structured JSON output, LLM APIs and SDKs, reliability and monitoring of LLM apps. Not: agent design (→ Agent AI); running and serving models (→ Hạ tầng AI).",
  },
  {
    key: "multimodal",
    groupName: "Model",
    name: "Ảnh, video và âm thanh",
    embedText:
      "Generative and multimodal media AI: image and video generation, diffusion models, vision-language models, speech recognition, text to speech, voice cloning and music generation",
    labelGuide:
      "Image, video and music generation; diffusion; speech recognition and speech synthesis. Vision-language models (VLMs) belong here only when the news is about generating images, video or audio; otherwise → Model AI: phát hành và hành vi. Not: medical imaging (→ AI trong khoa học và y tế).",
  },
  {
    key: "robotics",
    groupName: "Ứng dụng",
    name: "Robot và AI vật lý",
    embedText:
      "Robotics and embodied AI: robot learning, manipulation, humanoid robots, world models, self-driving cars and drones",
    labelGuide:
      "Robot learning, object manipulation, humanoid robots, world models, self-driving cars, drones.",
  },
  {
    key: "ai_infra",
    groupName: "Xây dựng với AI",
    name: "Hạ tầng AI",
    embedText:
      "AI compute infrastructure: GPUs and AI chips, data centers, inference servers and serving engines, running models locally, AI cloud platforms, cost and energy use of AI compute",
    labelGuide:
      "GPUs and AI chips, data centers, inference servers (vLLM…), running models on a personal machine, AI cloud platforms, compute cost and energy use. Not: algorithm-level optimization (→ Huấn luyện và tối ưu model); financial news about chip companies (→ Kinh doanh AI).",
  },
  {
    key: "ai_products",
    groupName: "Ứng dụng",
    name: "Trợ lý và ứng dụng AI",
    embedText:
      "Launches and new features of AI apps and chat assistants for end users, such as ChatGPT, Claude, Gemini and Copilot, and AI features added to everyday consumer software",
    labelGuide:
      "ChatGPT, Claude, Gemini, Copilot and other AI apps for end users; AI features in everyday software. Not: tools for developers (→ Lập trình với AI, Xây ứng dụng LLM).",
  },
  {
    key: "ai_industry",
    groupName: "Ngành và xã hội",
    name: "Kinh doanh AI",
    embedText:
      "The AI industry as a business: AI companies and startups, funding rounds, acquisitions, IPOs, revenue, valuations and competition between AI labs",
    labelGuide:
      "AI companies and startups, funding rounds, acquisitions, IPOs, revenue, valuations, competition between AI labs. Not: laws and policy (→ Chính sách và xã hội).",
  },
  {
    key: "ai_safety",
    groupName: "Ngành và xã hội",
    name: "An toàn và bảo mật AI",
    embedText:
      "AI safety and security: alignment, red teaming, jailbreaks and prompt injection, security of AI agents, misuse of AI, catastrophic and existential AI risk",
    labelGuide:
      "Alignment, red teaming, jailbreaks, prompt injection, security of AI agents, misuse of AI, large-scale risks from AI. Not: laws and policy (→ Chính sách và xã hội).",
  },
  {
    key: "ai_policy",
    groupName: "Ngành và xã hội",
    name: "Chính sách và xã hội",
    embedText:
      "AI policy and society: AI regulation and laws, government AI policy, copyright and AI, impact of AI on jobs and education, public opinion and debate about AI",
    labelGuide:
      "AI laws and regulation, government policy, copyright, impact of AI on jobs and education, public debate about AI.",
  },
  {
    key: "ml_foundations",
    groupName: "Nghiên cứu",
    name: "ML nền tảng",
    embedText:
      "Core machine learning research beyond language models: optimization, learning theory, bandits, graph neural networks, time-series forecasting, theory of generative models, statistics for machine learning",
    labelGuide:
      "Machine learning research beyond language models: optimization, learning theory, bandits, graph neural networks (GNN), time-series forecasting, theory of generative models, statistics for ML.",
  },
  {
    key: "ai_science",
    groupName: "Ứng dụng",
    name: "AI trong khoa học và y tế",
    embedText:
      "AI for science and medicine: medical imaging and clinical diagnosis, healthcare AI, protein structure and drug discovery, chemistry and materials, physics, climate and weather forecasting models",
    labelGuide:
      "Medical imaging and diagnosis, AI in healthcare, proteins and drug discovery, chemistry and materials, physics, climate and weather forecasting.",
  },
];

/**
 * A topic removed from the library → a new topic replaces it (15/10/2026: the old 17-topic set becomes the 14-topic set).
 * `topics seed` moves selections using this table: whoever has an old topic enabled gets the new topic enabled, and the old
 * topic is turned off (the old row is kept, so history is not lost). Topics that keep their old key (`agents`, `training`…)
 * are not listed here: they stay the same topic, only renamed and given a new description sentence.
 */
export const TOPIC_SUCCESSORS: Record<string, string> = {
  new_models: "llm_models",
  open_models: "llm_models",
  evals: "llm_models",
  rag_search: "llm_apps",
  mlops: "llm_apps",
  inference: "ai_infra",
  ml_research: "ml_foundations",
  open_source_tools: "ai_coding",
};

/**
 * English name of each library topic: the exact name the decision model (Jev) sees everywhere it needs a topic name
 * (the topic gate, topics mentioned in a scope, checking for similar topics). The model is only guaranteed to work with
 * English, so Vietnamese names are not given to it. Custom topics are not here: use the
 * "Name:" part at the start of the description sentence (`englishName` in topic-overlap.ts).
 *
 * Eight topics marked "measured" keep the exact names from the 13–16/10/2026 experiment (topic gate: Jev matches
 * the reference labels 84%); the other six are not measured yet and get short names in the same style. Changing a measured name means measuring
 * again.
 */
export const TOPIC_NAMES_EN: Record<string, string> = {
  // Measured with "LLMs: models and behavior"; DELIBERATELY renamed to the new label "Model AI: phát hành và hành vi"
  // (16/10/2026), so the name matches the new scope, which now includes SLMs, on-device models and VLMs.
  llm_models: "AI models: releases and behavior",
  training: "Training and optimizing models", // measured
  agents: "AI agents", // measured
  ai_coding: "Programming with AI", // measured
  llm_apps: "Building LLM applications", // measured
  multimodal: "Image, video and audio AI", // measured
  robotics: "Robotics and physical AI",
  ai_infra: "AI infrastructure",
  ai_products: "AI assistants and apps", // measured
  ai_industry: "AI business",
  ai_safety: "AI safety and security",
  ai_policy: "AI policy and society",
  ml_foundations: "ML foundations", // measured
  ai_science: "AI in science and medicine",
};

/** Two rules for when a story fits two topics; written into the labelling prompt of the digest. */
export const TOPIC_TIE_BREAKS = [
  'A more specific topic beats a general one: an agent that writes code belongs to the coding topic ("Lập trình với AI"), not to "Agent AI".',
  'The application domain beats the data modality: medical imaging belongs to science and medicine ("AI trong khoa học và y tế"), not to "Ảnh, video và âm thanh".',
];
