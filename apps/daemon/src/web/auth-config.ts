/**
 * Sign-in config from environment variables, validated with zod.
 *
 * Fail-closed but does not crash the daemon (the `all` role still runs the scheduler, worker, and bot): if
 * `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` is missing or wrong, `loadAuthConfig` returns `null` and web returns 503 for every
 * `/api/*`. A provider missing its client id or secret is disabled on its own.
 */
import { z } from "zod";
import { normalizeEmail } from "./email.ts";

export type SocialProviderId = "github" | "google";

export interface AuthConfig {
  /** Signing key for cookies and token encryption of Better Auth (at least 32 characters). */
  secret: string;
  /** Public address of the web app, without a trailing `/`; with `https` the cookie gets `Secure`. */
  baseURL: string;
  /**
   * Emails allowed to CREATE the first owner (lowercased, deduplicated, empty entries removed). Only has effect
   * while the DB has no owner; once there is an owner this list is ignored. Empty = no bootstrap path.
   */
  bootstrapOwnerEmails: string[];
  providers: Partial<Record<SocialProviderId, { clientId: string; clientSecret: string }>>;
}

/** Raw environment variables, keeping the strings the user set as they are (may be empty). */
export interface RawAuthEnv {
  secret?: string;
  baseURL?: string;
  /** Comma-separated email list (`BOOTSTRAP_OWNER_EMAILS`). */
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

/** Comma-separated email list: lowercased, empty entries removed, deduplicated. Invalid entries are returned in `invalid`. */
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
  /** Reason for disabling or a warning, for the log. */
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
