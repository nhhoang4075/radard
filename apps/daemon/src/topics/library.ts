/**
 * Thư viện chủ đề: các chủ đề radard soạn sẵn để người dùng bấm chọn, không phải tự viết gì.
 *
 * Người dùng chỉ thấy `labelVi`. `descriptionEn` là câu dùng để embed: viết bằng tiếng Anh cho
 * khớp dữ liệu, gồm tên sản phẩm, kỹ thuật cụ thể. Thử trên 16 nghìn tài liệu ngày 12/10/2026:
 * câu chứa nhiều chữ chung chung ("AI models", "LLM") kéo về mọi tiêu đề có chữ đó (chủ đề ảnh,
 * video, giọng nói bản đầu); thay bằng tên cụ thể (Midjourney, Sora, text-to-speech) thì bắt đúng.
 *
 * Sửa một câu mô tả ở đây rồi chạy `topics seed`: thư viện được cập nhật, chủ đề người dùng đã
 * chọn từ thư viện nhận câu mới và được embed lại.
 */
export interface LibraryTopic {
  key: string;
  groupVi: string;
  labelVi: string;
  descriptionEn: string;
}

export const TOPIC_LIBRARY: LibraryTopic[] = [
  {
    key: "agents",
    groupVi: "AI ứng dụng",
    labelVi: "Agent AI",
    descriptionEn:
      "AI agents: LLM agents that use tools and take actions, planning, memory, multi-agent systems, coding agents, computer-use agents, Model Context Protocol (MCP), agent frameworks and agent evaluation",
  },
  {
    key: "llm_apps",
    groupVi: "AI ứng dụng",
    labelVi: "Xây ứng dụng LLM",
    descriptionEn:
      "How developers build products on top of LLM APIs: prompt engineering, context engineering, structured JSON output, function calling, AI SDKs, LLM gateways and routers, testing and debugging AI features",
  },
  {
    key: "rag_search",
    groupVi: "AI ứng dụng",
    labelVi: "RAG & tìm kiếm",
    descriptionEn:
      "Retrieval-augmented generation and semantic search: embeddings, vector databases, hybrid search, reranking, chunking documents, knowledge graphs for LLMs",
  },
  {
    key: "ai_coding",
    groupVi: "AI ứng dụng",
    labelVi: "Công cụ lập trình AI",
    descriptionEn:
      "AI coding tools: AI code assistants and AI IDEs such as GitHub Copilot, Cursor and Claude Code, code generation with LLMs, AI code review, vibe coding",
  },
  {
    key: "ai_products",
    groupVi: "AI ứng dụng",
    labelVi: "Phần mềm có AI",
    descriptionEn:
      "Software products with AI built in: new AI features in apps and developer platforms, open-source AI tools, AI product launches",
  },
  {
    key: "new_models",
    groupVi: "Model",
    labelVi: "Model mới ra",
    descriptionEn:
      "New AI model releases: new large language models from OpenAI, Anthropic, Google, Meta and others, new model versions, their benchmark results, pricing and context windows",
  },
  {
    key: "open_models",
    groupVi: "Model",
    labelVi: "Model mã nguồn mở",
    descriptionEn:
      "Open-weight models anyone can download: new Llama, Qwen, Mistral, DeepSeek, Gemma and Kimi releases, weights published on Hugging Face, running them locally with llama.cpp, Ollama or MLX",
  },
  {
    key: "multimodal",
    groupVi: "Model",
    labelVi: "Model ảnh, video, giọng nói",
    descriptionEn:
      "Generating and understanding images, video and audio with AI: image generators like Midjourney, Stable Diffusion and Flux, video generators like Sora and Veo, speech-to-text, text-to-speech, voice cloning",
  },
  {
    key: "ml_research",
    groupVi: "Nghiên cứu",
    labelVi: "Nghiên cứu ML",
    descriptionEn:
      "Machine learning and deep learning research: new neural network architectures, transformers and attention, scaling laws, reasoning in language models, research papers",
  },
  {
    key: "training",
    groupVi: "Nghiên cứu",
    labelVi: "Huấn luyện & fine-tune",
    descriptionEn:
      "Techniques for training language models: pretraining datasets, supervised fine-tuning, LoRA adapters, reinforcement learning from human feedback, RLHF, GRPO, reward models, distillation, synthetic training data",
  },
  {
    key: "ai_safety",
    groupVi: "Nghiên cứu",
    labelVi: "An toàn & nguyên lý AI",
    descriptionEn:
      "AI safety and interpretability: alignment, jailbreaks, prompt injection, red teaming, mechanistic interpretability, dangerous model behavior and misuse of AI",
  },
  {
    key: "evals",
    groupVi: "Nghiên cứu",
    labelVi: "Đánh giá & benchmark",
    descriptionEn:
      "Evaluating AI models: LLM benchmarks, leaderboards, evaluation methods, LLM-as-a-judge, measuring hallucination and reliability of AI systems",
  },
  {
    key: "inference",
    groupVi: "Hạ tầng",
    labelVi: "GPU & inference",
    descriptionEn:
      "AI infrastructure: GPUs and AI chips, LLM inference serving and optimization, quantization, vLLM, distributed training, AI data centers",
  },
  {
    key: "mlops",
    groupVi: "Hạ tầng",
    labelVi: "MLOps & vận hành LLM",
    descriptionEn:
      "Running ML and LLM systems in production: MLOps, LLM observability and tracing, model deployment and monitoring, data pipelines for AI",
  },
  {
    // 13/10/2026: bạn thêm sau khi thấy REA, Doory (công cụ mã nguồn mở, không hẳn AI) khớp yếu
    // với các chủ đề AI. Tên sản phẩm ví dụ cố ý không nhắc tới chính các tin đó.
    key: "open_source_tools",
    groupVi: "Phần mềm",
    labelVi: "Công cụ mã nguồn mở",
    descriptionEn:
      "Open-source software tools and projects: new open-source repositories on GitHub, self-hosted apps, open-source alternatives to commercial products like Notion, Figma or Firebase, developer libraries, frameworks and command-line tools, Show HN launches",
  },
  {
    key: "ai_industry",
    groupVi: "Ngành AI",
    labelVi: "Công ty & đầu tư AI",
    descriptionEn:
      "AI industry news: AI labs and AI startups, funding rounds, acquisitions, partnerships, executives and business strategy of OpenAI, Anthropic, Google, Microsoft and Nvidia",
  },
  {
    key: "ai_policy",
    groupVi: "Ngành AI",
    labelVi: "Chính sách & pháp lý AI",
    descriptionEn:
      "AI policy and regulation: AI laws, government AI policy, copyright lawsuits over AI training data, AI and jobs, societal impact of AI",
  },
];
