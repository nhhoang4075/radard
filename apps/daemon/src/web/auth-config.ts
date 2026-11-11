/**
 * Cấu hình đăng nhập từ biến môi trường, kiểm bằng zod.
 *
 * Fail-closed nhưng không làm sập daemon (vai trò `all` còn chạy scheduler, worker, bot): thiếu hoặc sai
 * `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` thì `loadAuthConfig` trả `null` và web trả 503 cho mọi
 * `/api/*`. Provider thiếu client id hoặc secret thì chỉ provider đó tắt.
 */
import { z } from "zod";
import { normalizeEmail } from "./email.ts";

export type SocialProviderId = "github" | "google";

export interface AuthConfig {
  /** Khoá ký cookie và mã hoá token của Better Auth (từ 32 ký tự). */
  secret: string;
  /** Địa chỉ công khai của web, không có dấu `/` cuối; `https` thì cookie có `Secure`. */
  baseURL: string;
  /**
   * Email được phép KHỞI TẠO owner đầu tiên (chuẩn hoá chữ thường, bỏ trùng và rỗng). Chỉ có tác dụng
   * khi DB chưa có owner nào; có owner rồi thì danh sách này bị bỏ qua. Trống = không có đường khởi tạo.
   */
  bootstrapOwnerEmails: string[];
  providers: Partial<Record<SocialProviderId, { clientId: string; clientSecret: string }>>;
}

/** Biến môi trường thô, giữ nguyên chuỗi người dùng đặt (có thể rỗng). */
export interface RawAuthEnv {
  secret?: string;
  baseURL?: string;
  /** Danh sách email phân tách dấu phẩy (`BOOTSTRAP_OWNER_EMAILS`). */
  bootstrapOwnerEmails?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  googleClientId?: string;
  googleClientSecret?: string;
}

const schema = z.object({
  secret: z.string().min(32, "BETTER_AUTH_SECRET phải từ 32 ký tự"),
  baseURL: z
    .url({ protocol: /^https?$/, error: "BETTER_AUTH_URL phải là địa chỉ http(s)" })
    .transform((u) => u.replace(/\/+$/, "")),
});

/** Danh sách email phân tách dấu phẩy: chuẩn hoá chữ thường, bỏ rỗng, bỏ trùng. Phần tử sai trả về ở `invalid`. */
const emailList = z.string().transform((raw) => {
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(",")) {
    if (!part.trim()) continue;
    const e = normalizeEmail(part);
    if (!e) invalid.push(part.trim());
    else if (!emails.includes(e)) emails.push(e);
  }
  return { emails, invalid };
});

export interface LoadResult {
  config: AuthConfig | null;
  /** Lý do tắt hoặc cảnh báo, để log. */
  problems: string[];
}

export function loadAuthConfig(raw: RawAuthEnv): LoadResult {
  const problems: string[] = [];
  const parsed = schema.safeParse({ secret: raw.secret, baseURL: raw.baseURL });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] === "secret" ? "BETTER_AUTH_SECRET" : "BETTER_AUTH_URL";
      problems.push(`${field}: chưa đặt hoặc không hợp lệ (${issue.message})`);
    }
    return { config: null, problems };
  }

  const list = emailList.parse(raw.bootstrapOwnerEmails ?? "");
  const bootstrapOwnerEmails = list.emails;
  for (const bad of list.invalid)
    problems.push(`BOOTSTRAP_OWNER_EMAILS: "${bad}" không phải email hợp lệ, bỏ qua`);
  if (bootstrapOwnerEmails.length === 0)
    problems.push(
      "chưa đặt BOOTSTRAP_OWNER_EMAILS: không có đường khởi tạo owner (chỉ đăng nhập bằng lời mời)",
    );

  const providers: AuthConfig["providers"] = {};
  const pairs: Array<[SocialProviderId, string | undefined, string | undefined]> = [
    ["github", raw.githubClientId, raw.githubClientSecret],
    ["google", raw.googleClientId, raw.googleClientSecret],
  ];
  for (const [id, clientId, clientSecret] of pairs) {
    if (clientId && clientSecret) providers[id] = { clientId, clientSecret };
    else if (clientId || clientSecret)
      problems.push(`${id}: thiếu client id hoặc secret, provider tắt`);
  }
  if (Object.keys(providers).length === 0)
    problems.push("không có provider đăng nhập nào được bật");

  return { config: { ...parsed.data, bootstrapOwnerEmails, providers }, problems };
}
