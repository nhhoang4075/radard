/**
 * Thư viện chủ đề: các chủ đề radard soạn sẵn để người dùng bấm chọn, không phải tự viết gì.
 *
 * Bộ 14 chủ đề từ 15/10/2026 (docs/bo-chu-de-moi.html) chia theo đúng một câu hỏi: tin này chủ
 * yếu nói về cái gì. Bộ 17 chủ đề cũ trộn nhiều cách chia (đối tượng, hoạt động, tính chất, loại
 * tin) nên một tin rơi vào nhiều ô cùng lúc.
 *
 * Người dùng chỉ thấy `name`. `embedText` là câu dùng để embed: viết bằng tiếng Anh cho
 * khớp dữ liệu, chỉ gồm phần "Gồm" với tên sản phẩm, kỹ thuật cụ thể. Embedding không hiểu phủ
 * định: viết "không gồm X" vào câu lại kéo nó gần X hơn. Các câu đã được đo trên 16.203 tin AI của
 * 30 ngày; sửa câu nào thì đo lại.
 *
 * `labelGuide` là phạm vi của chủ đề (gồm gì, không gồm gì, tin lấn sang thì thuộc chủ đề nào), chỉ
 * đưa cho LLM khi nó gắn nhãn cho tin trong điểm tin; không embed.
 *
 * Sửa một câu mô tả ở đây rồi chạy `topics seed`: thư viện được cập nhật, chủ đề người dùng đã
 * chọn từ thư viện nhận câu mới và được embed lại. Sửa `labelGuide` thì không phải embed lại.
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
    // "LLM: …" bỏ sót SLM, model chạy trên máy và VLM (16/10/2026); khoá và câu mô tả giữ nguyên:
    // đổi câu mô tả cho rộng ra thì đo lại kém hơn.
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
 * Chủ đề đã rút khỏi thư viện → chủ đề mới thay nó (15/10/2026: bộ 17 chủ đề cũ sang bộ 14).
 * `topics seed` chuyển lựa chọn theo bảng này: ai đang bật chủ đề cũ thì được bật chủ đề mới, chủ
 * đề cũ tắt đi (dòng cũ giữ lại, không mất lịch sử). Chủ đề giữ khoá cũ (`agents`, `training`…)
 * không nằm ở đây: nó vẫn là chính nó, chỉ đổi tên và câu mô tả.
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
 * Tên tiếng Anh của từng chủ đề thư viện: đúng tên model quyết định (Jev) thấy ở mọi chỗ cần tên
 * chủ đề (cổng chủ đề, chủ đề nhắc tới trong phạm vi, soát chủ đề gần giống). Model chỉ được hãng
 * bảo đảm với tiếng Anh, nên không đưa tên tiếng Việt cho nó. Chủ đề tự thêm không có ở đây: dùng
 * phần "Tên:" đầu câu mô tả (`englishName` trong topic-overlap.ts).
 *
 * Tám chủ đề có đánh dấu "đã đo" giữ đúng tên của thử nghiệm 13–16/10/2026 (cổng chủ đề: Jev khớp
 * nhãn tham chiếu 84%); sáu chủ đề còn lại chưa đo, đặt tên ngắn cùng kiểu. Sửa tên đã đo thì đo
 * lại.
 */
export const TOPIC_NAMES_EN: Record<string, string> = {
  // Đã đo với "LLMs: models and behavior"; CỐ Ý đổi theo nhãn mới "Model AI: phát hành và hành vi"
  // (16/10/2026), để tên khớp phạm vi mới gồm cả SLM, model chạy trên máy và VLM.
  llm_models: "AI models: releases and behavior",
  training: "Training and optimizing models", // đã đo
  agents: "AI agents", // đã đo
  ai_coding: "Programming with AI", // đã đo
  llm_apps: "Building LLM applications", // đã đo
  multimodal: "Image, video and audio AI", // đã đo
  robotics: "Robotics and physical AI",
  ai_infra: "AI infrastructure",
  ai_products: "AI assistants and apps", // đã đo
  ai_industry: "AI business",
  ai_safety: "AI safety and security",
  ai_policy: "AI policy and society",
  ml_foundations: "ML foundations", // đã đo
  ai_science: "AI in science and medicine",
};

/** Hai quy tắc khi một tin hợp hai chủ đề; viết vào prompt gắn nhãn của điểm tin. */
export const TOPIC_TIE_BREAKS = [
  'A more specific topic beats a general one: an agent that writes code belongs to the coding topic ("Lập trình với AI"), not to "Agent AI".',
  'The application domain beats the data modality: medical imaging belongs to science and medicine ("AI trong khoa học và y tế"), not to "Ảnh, video và âm thanh".',
];
