/**
 * Đăng nhập web bằng Better Auth (1.6.23): adapter Drizzle trên Postgres, GitHub và Google.
 * Owner nằm trong DB (`user_roles`), không nằm trong biến môi trường (quyết định 11/11/2026).
 *
 * Hai hook của `databaseHooks`, cả hai FAIL-CLOSED (lỗi hay không rõ thì từ chối):
 *  - `user.create.before`: chỉ email đã xác minh VÀ (có lời mời chưa dùng, HOẶC nằm trong
 *    `BOOTSTRAP_OWNER_EMAILS` và DB chưa có owner nào) mới được tạo user.
 *  - `user.create.after` (và `session.create.before` làm lưới an toàn, vì hook "after" chạy sau giao
 *    dịch nên có thể hỏng riêng): bảo đảm user có hồ sơ, trong một giao dịch dưới khoá tư vấn.
 *    Đường bootstrap (chưa có owner): gán role owner và nhận hồ sơ chưa có chủ nhỏ nhất (tạo mới nếu
 *    không có). Đường lời mời: role lấy từ `invites.role`, luôn một hồ sơ trống MỚI. Không bao giờ nhận
 *    hồ sơ đã có `user_id`.
 */
import { createLogger } from "@radard/core";
import {
  account,
  type Database,
  invites,
  profile,
  session,
  userRoles,
  user as userTable,
  verification,
} from "@radard/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AuthConfig } from "./auth-config.ts";
import { normalizeEmail } from "./email.ts";
import { PROFILE_LOCK_KEY } from "./profile-lock.ts";

const log = createLogger("web:auth");

/** Mã lỗi ngắn để log (thông điệp của driver kèm tham số truy vấn, có email). */
function errCode(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : err instanceof Error ? err.name : "unknown";
}

export interface HookUser {
  id?: unknown;
  email?: unknown;
  emailVerified?: unknown;
}

/** Từ chối việc tạo user (fail-closed). Không nêu lý do cụ thể ra ngoài. */
export class SignUpDenied extends Error {}

type Executor = Pick<Database, "select">;

/** Đã có ít nhất một owner trong DB chưa. Lỗi (thiếu bảng...) thì ném, người gọi từ chối. */
async function hasOwner(q: Executor): Promise<boolean> {
  const [row] = await q
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .where(eq(userRoles.role, "owner"))
    .limit(1);
  return row !== undefined;
}

/**
 * Cho phép tạo user khi email đã xác minh và (được mời, hoặc nằm trong `bootstrapOwnerEmails` khi chưa có
 * owner nào). Mọi nhánh còn lại, kể cả lỗi truy vấn hay thiếu bảng, đều ném `SignUpDenied`.
 */
export async function assertMaySignUp(
  db: Database,
  bootstrapOwnerEmails: readonly string[],
  u: HookUser,
): Promise<void> {
  try {
    const email = normalizeEmail(u.email);
    if (!email || u.emailVerified !== true) throw new SignUpDenied("email chưa xác minh");
    const [row] = await db
      .select({ id: invites.id })
      .from(invites)
      .where(and(eq(invites.email, email), isNull(invites.usedAt)))
      .limit(1);
    if (row) return;
    if (bootstrapOwnerEmails.includes(email) && !(await hasOwner(db))) return;
    throw new SignUpDenied("email chưa được mời");
  } catch (err) {
    if (!(err instanceof SignUpDenied))
      log.error("kiểm lời mời lỗi, từ chối", { code: errCode(err) });
    throw err instanceof SignUpDenied ? err : new SignUpDenied("lỗi kiểm lời mời");
  }
}

/**
 * Bảo đảm user có hồ sơ (idempotent). Trả id hồ sơ. Role và hồ sơ được ghi trong cùng một giao dịch.
 *  - Đã có hồ sơ gắn user này: trả luôn.
 *  - Trong giao dịch (khoá tư vấn, kiểm lại bên trong): email nằm trong `bootstrapOwnerEmails` VÀ chưa có
 *    owner nào → gán owner, nhận hồ sơ chưa có chủ (`user_id` NULL) có id nhỏ nhất, không có thì tạo mới.
 *  - Ngược lại cần lời mời (đã dùng hay chưa đều được; bị thu hồi thì không): role lấy từ `invites.role`,
 *    luôn tạo hồ sơ trống MỚI (id = max + 1), không bao giờ nhận hồ sơ cũ.
 */
export async function ensureProfileForUser(
  db: Database,
  bootstrapOwnerEmails: readonly string[],
  u: HookUser,
): Promise<number> {
  if (typeof u.id !== "string" || !u.id) throw new Error("user không có id");
  const userId = u.id;
  const [existing] = await db
    .select({ id: profile.id })
    .from(profile)
    .where(eq(profile.userId, userId))
    .limit(1);
  if (existing) return existing.id;

  const email = normalizeEmail(u.email);
  if (!email || u.emailVerified !== true) throw new Error("email chưa xác minh, không tạo hồ sơ");

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PROFILE_LOCK_KEY})`);
    const [again] = await tx
      .select({ id: profile.id })
      .from(profile)
      .where(eq(profile.userId, userId))
      .limit(1);
    if (again) return again.id;

    const [inv] = await tx
      .select({ id: invites.id, role: invites.role, usedAt: invites.usedAt })
      .from(invites)
      .where(eq(invites.email, email))
      .limit(1);

    let role: "owner" | "member";
    let profileId: number | null = null;
    if (bootstrapOwnerEmails.includes(email) && !(await hasOwner(tx))) {
      // Đường bootstrap: nhận hồ sơ chưa có chủ nhỏ nhất.
      role = "owner";
      const [free] = await tx
        .select({ id: profile.id })
        .from(profile)
        .where(isNull(profile.userId))
        .orderBy(asc(profile.id))
        .limit(1)
        .for("update");
      if (free) {
        await tx.update(profile).set({ userId }).where(eq(profile.id, free.id));
        profileId = free.id;
      }
    } else {
      // Đường lời mời: lời mời phải còn trong bảng (đã dùng hay chưa đều được); bị thu hồi thì không.
      if (!inv) throw new Error("không có lời mời cho email này, không tạo hồ sơ");
      // Quyền owner chỉ lấy từ lời mời CHƯA dùng: lời mời đã dùng không được cấp lại owner (vd. sau `owners remove` + `profiles relink`).
      role = inv.role === "owner" && inv.usedAt === null ? "owner" : "member";
    }
    if (profileId === null) {
      const [next] = await tx
        .select({ id: sql<number>`coalesce(max(${profile.id}), 0) + 1` })
        .from(profile);
      profileId = Number(next?.id ?? 1);
      await tx.insert(profile).values({ id: profileId, promptContext: "", userId });
    }
    if (role === "owner") {
      await tx
        .insert(userRoles)
        .values({ userId, role: "owner" })
        .onConflictDoUpdate({ target: userRoles.userId, set: { role: "owner" } });
    }
    await tx
      .update(invites)
      .set({ usedAt: new Date() })
      .where(and(eq(invites.email, email), isNull(invites.usedAt)));
    return profileId;
  });
}

export interface CreateAuthOptions {
  db: Database;
  config: AuthConfig;
  /** Chỉ test: plugin phụ (ví dụ `testUtils`). Không bao giờ truyền ở luồng thật. */
  plugins?: NonNullable<Parameters<typeof betterAuth>[0]>["plugins"];
}

function deny(): never {
  throw new APIError("FORBIDDEN", { message: "invite_required" });
}

export function createAuth({ db, config, plugins }: CreateAuthOptions) {
  const https = config.baseURL.startsWith("https://");
  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  for (const [id, cred] of Object.entries(config.providers)) if (cred) socialProviders[id] = cred;

  return betterAuth({
    appName: "radard",
    baseURL: config.baseURL,
    secret: config.secret,
    trustedOrigins: [config.baseURL],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: userTable, session, account, verification },
    }),
    socialProviders,
    // Lỗi đăng nhập (ví dụ chưa được mời) quay về trang đăng nhập kèm `?error=…`.
    onAPIError: { errorURL: `${config.baseURL}/login` },
    advanced: {
      useSecureCookies: https,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: https },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (u) => {
            try {
              await assertMaySignUp(db, config.bootstrapOwnerEmails, u);
            } catch {
              deny();
            }
          },
          after: async (u) => {
            await ensureProfileForUser(db, config.bootstrapOwnerEmails, u ?? {});
          },
        },
      },
      session: {
        create: {
          // Lưới an toàn: user đã tạo nhưng bước "after" hỏng thì lần đăng nhập sau nối lại hồ sơ.
          // Nối không được thì không cấp phiên.
          before: async (s) => {
            try {
              const [u] = await db
                .select()
                .from(userTable)
                .where(eq(userTable.id, String(s.userId)))
                .limit(1);
              if (!u) deny();
              await ensureProfileForUser(db, config.bootstrapOwnerEmails, u);
            } catch (err) {
              if (!(err instanceof APIError))
                log.error("nối hồ sơ lỗi, từ chối phiên", { code: errCode(err) });
              deny();
            }
          },
        },
      },
    },
    plugins,
  });
}

export type Auth = ReturnType<typeof createAuth>;
