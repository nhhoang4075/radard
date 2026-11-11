/**
 * Cấu hình từ biến môi trường. Gom một chỗ để thấy ngay daemon cần những gì để chạy.
 * Bun tự đọc file `.env` ở thư mục chạy lệnh.
 */
export type Role = "scheduler" | "worker" | "bot" | "web" | "all";
export type EmbedderKind = "gateway" | "fake" | "none";
export type ObjectStoreKind = "fs" | "r2";

const num = (v: string | undefined, fallback: number) => (v ? Number(v) : fallback);

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/radard",
  /** `fs` ghi bản thô ra `DATA_DIR` (dev); `r2` ghi lên bucket R2 (deploy), cần bốn biến `R2_*`. */
  objectStore: (process.env.OBJECT_STORE ?? "fs") as ObjectStoreKind,
  /** Thư mục bản thô khi `OBJECT_STORE=fs`. */
  dataDir: process.env.DATA_DIR ?? "./data",
  r2: {
    endpoint: process.env.R2_ENDPOINT || undefined,
    bucket: process.env.R2_BUCKET || undefined,
    accessKeyId: process.env.R2_ACCESS_KEY_ID || undefined,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || undefined,
  },
  role: (process.env.SERVICE_ROLE ?? "all") as Role,

  /**
   * Bot Telegram. Không có token thì không gửi digest và không chạy vai trò bot. Người nhận
   * lấy từ bảng `profile_channels` (`channels add`), không từ biến môi trường: bot bỏ qua mọi chat chưa có trong bảng.
   */
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
  /** Cổng HTTP của vai trò `web` (Railway đặt `PORT`). */
  port: num(process.env.PORT, 8080),
  /**
   * Khoá HMAC ký link theo dõi. Thiếu thì route `/o/*` trả 404 và tin giữ link trực tiếp: không có khoá mặc định.
   */
  linkSecret: process.env.LINK_SECRET || undefined,
  /** Địa chỉ công khai của vai trò `web` (ví dụ https://radard.example.com); cùng `linkSecret` bật link theo dõi. */
  publicBaseUrl: process.env.PUBLIC_BASE_URL || undefined,
  /**
   * Đăng nhập web (Better Auth). Thiếu `BETTER_AUTH_SECRET` hoặc `BETTER_AUTH_URL` thì đăng nhập tắt
   * (`/api/*` trả 503), daemon vẫn chạy. Kiểm bằng zod ở `web/auth-config.ts`.
   */
  auth: {
    secret: process.env.BETTER_AUTH_SECRET || undefined,
    baseURL:
      process.env.BETTER_AUTH_URL ||
      (process.env.NODE_ENV === "production"
        ? undefined
        : `http://localhost:${num(process.env.PORT, 8080)}`),
    ownerEmail: process.env.OWNER_EMAIL || undefined,
    githubClientId: process.env.GITHUB_CLIENT_ID || undefined,
    githubClientSecret: process.env.GITHUB_CLIENT_SECRET || undefined,
    googleClientId: process.env.GOOGLE_CLIENT_ID || undefined,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || undefined,
  },
  fetchConcurrency: num(process.env.FETCH_CONCURRENCY, 4),
  /**
   * Hạn mức "Với tôi?" (web và Telegram): số câu model viết cho mỗi hồ sơ mỗi ngày (giờ VN). Cache
   * hit không tính (quyết định 11/11/2026).
   */
  forMeDailyLimit: num(process.env.FOR_ME_DAILY_LIMIT, 100),

  /**
   * `gateway` cần `AI_GATEWAY_API_KEY`; `fake` là embedding băm từ, chỉ để thử cơ chế
   * (kết quả lọc/gộp vô nghĩa về chất lượng); `none` thì job process không chạy.
   */
  embedder: (process.env.EMBEDDER ??
    (process.env.AI_GATEWAY_API_KEY ? "gateway" : "none")) as EmbedderKind,
  embedModel: process.env.EMBED_MODEL ?? "alibaba/qwen3-embedding-0.6b",
  /**
   * Khoảng cách tối thiểu giữa hai request embedding. Gói miễn phí AI Gateway giới hạn 5
   * request/phút (đo 06/10/2026, cần đặt 12000); sau khi nạp credits (11/10/2026) 8 request
   * liền nhau đều qua, nên mặc định 1 giây. Chạm rate limit thì adapter vẫn tự chờ Retry-After.
   */
  embedMinIntervalMs: num(process.env.EMBED_MIN_INTERVAL_MS, 1_000),
  /**
   * Model sinh văn bản (digest, sau này phân xử vùng xám, brief…). Mặc định
   * anthropic/claude-haiku-5.5 (11/10/2026); đổi qua `LLM_MODEL` để so sánh, ví dụ
   * openai/gpt-6-luna. Không cấu hình giá: chi phí ghi vào `llm_calls` là số Gateway báo cho
   * từng lời gọi (đã tính bậc giá, cache, token suy nghĩ); Gateway không báo thì ước tính từ
   * bảng giá có bậc đọc từ Gateway (`gateway-pricing.ts`).
   */
  llmModel: process.env.LLM_MODEL ?? "anthropic/claude-haiku-5.5",
  /**
   * Model ra quyết định (chọn đáp án kèm xác suất, không viết văn bản), qua AI Gateway. Đo
   * 13/10/2026 (docs/mo-hinh-quyet-dinh.html tab 05): typesafe-ai/jev đúng 7/7 ca quan hệ chủ
   * đề, ~0,5 giây, $0,042 mỗi triệu token vào (token ra miễn phí). Dự phòng cùng giá:
   * microsoft/microsoft-decision-1 (cũng 7/7, chậm gấp đôi).
   */
  decisionModel: process.env.DECISION_MODEL ?? "typesafe-ai/jev",
  /** Trần số lô (128 tài liệu) mỗi lượt job `process`, để job xong trước hạn 30 phút. */
  processMaxBatches: num(process.env.PROCESS_MAX_BATCHES, 60),
  /** Trần số tài liệu gộp mỗi lượt `process` (~85 ms mỗi tài liệu): 3.000 ≈ 4–5 phút. */
  processMaxCluster: num(process.env.PROCESS_MAX_CLUSTER, 3000),

  /**
   * Gộp 0,9 (chỉnh 28/09/2026 trên 2.569 tài liệu thật với qwen3-embedding-0.6b): trong 0,8–0,9
   * lẫn cả gộp đúng lẫn gộp sai, chỉ trên 0,9 mới gần như chắc là cùng bài. Vùng 0,85–0,9 do
   * digest xử lý bằng phạt trùng. Không còn ngưỡng liên quan ở đây: mọi tài liệu được gộp (D4).
   */
  thresholds: {
    join: num(process.env.JOIN_THRESHOLD, 0.9),
    windowDays: num(process.env.CLUSTER_WINDOW_DAYS, 7),
  },
};
