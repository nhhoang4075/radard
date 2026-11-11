/**
 * Đăng nhập web bằng Better Auth (1.6.23): adapter Drizzle trên Postgres, GitHub và Google.
 *
 * Hai hook của `databaseHooks`, cả hai FAIL-CLOSED (lỗi hay không rõ thì từ chối):
 *  - `user.create.before`: chỉ email đã xác minh VÀ (trùng `OWNER_EMAIL` hoặc có trong `invites`
 *    chưa dùng) mới được tạo user.
 *  - `user.create.after` (và `session.create.before` làm lưới an toàn, vì hook "after" chạy sau giao
 *    dịch nên có thể hỏng riêng): bảo đảm user có hồ sơ. Email chủ dự án nối vào hồ sơ số 1, không tạo
 *    hồ sơ mới; người khác nhận một hồ sơ trống mới. Không bao giờ nối vào hồ sơ đã thuộc user khác.
 */
import { createLogger } from "@radard/core";
import {
  account,
  type Database,
  invites,
  profile,
  session,
  user as userTable,
  verification,
} from "@radard/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AuthConfig } from "./auth-config.ts";
import { normalizeEmail } from "./email.ts";

const log = createLogger("web:auth");

/** Hồ sơ của chủ dự án (dữ liệu có trước khi có web). */
export const OWNER_PROFILE_ID = 1;
/** Khoá tư vấn: tạo/nối hồ sơ chạy tuần tự, nên hai lần đăng nhập đồng thời không nối trùng. */
const PROFILE_LOCK_KEY = 7_302_419;

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

/**
 * Cho phép tạo user khi email đã xác minh và (là chủ dự án hoặc đã được mời). Mọi nhánh còn lại,
 * kể cả lỗi truy vấn hay thiếu bảng, đều ném `SignUpDenied`.
 */
export async function assertMaySignUp(
  db: Database,
  ownerEmail: string | null,
  u: HookUser,
): Promise<void> {
  try {
    const email = normalizeEmail(u.email);
    if (!email || u.emailVerified !== true) throw new SignUpDenied("email chưa xác minh");
    if (ownerEmail && email === ownerEmail) return;
    const [row] = await db
      .select({ id: invites.id })
      .from(invites)
      .where(and(eq(invites.email, email), isNull(invites.usedAt)))
      .limit(1);
    if (!row) throw new SignUpDenied("email chưa được mời");
  } catch (err) {
    if (!(err instanceof SignUpDenied))
      log.error("kiểm lời mời lỗi, từ chối", { code: errCode(err) });
    throw err instanceof SignUpDenied ? err : new SignUpDenied("lỗi kiểm lời mời");
  }
}

/**
 * Bảo đảm user có hồ sơ (idempotent). Trả id hồ sơ.
 *  - Đã có hồ sơ gắn user này: trả luôn.
 *  - Email đã xác minh trùng `ownerEmail`: nối vào hồ sơ số 1 (tạo hồ sơ số 1 nếu DB chưa có, không bao
 *    giờ tạo hồ sơ khác). Hồ sơ số 1 đã thuộc user khác thì ném lỗi, không cướp.
 *  - Còn lại: tạo hồ sơ trống, id mới lớn hơn mọi id hiện có (và >= 2, để không ai chiếm số 1).
 */
export async function ensureProfileForUser(
  db: Database,
  ownerEmail: string | null,
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
  const isOwner = ownerEmail !== null && email === ownerEmail;

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PROFILE_LOCK_KEY})`);
    const [again] = await tx
      .select({ id: profile.id })
      .from(profile)
      .where(eq(profile.userId, userId))
      .limit(1);
    if (again) return again.id;

    let profileId: number;
    if (isOwner) {
      const [p1] = await tx
        .select({ userId: profile.userId })
        .from(profile)
        .where(eq(profile.id, OWNER_PROFILE_ID))
        .limit(1);
      if (!p1) {
        await tx.insert(profile).values({ id: OWNER_PROFILE_ID, promptContext: "", userId });
      } else {
        if (p1.userId !== null) throw new Error("hồ sơ số 1 đã thuộc user khác");
        await tx.update(profile).set({ userId }).where(eq(profile.id, OWNER_PROFILE_ID));
      }
      profileId = OWNER_PROFILE_ID;
    } else {
      // Hồ sơ MỚI cho người không phải chủ dự án: lời mời phải còn trong bảng (đã dùng hay chưa đều
      // được). Lời mời bị thu hồi thì không nhận được hồ sơ, kể cả khi user đã tồn tại.
      const [inv] = await tx
        .select({ id: invites.id })
        .from(invites)
        .where(eq(invites.email, email))
        .limit(1);
      if (!inv) throw new Error("không có lời mời cho email này, không tạo hồ sơ");
      const [next] = await tx
        .select({ id: sql<number>`greatest(coalesce(max(${profile.id}), 0) + 1, 2)::int` })
        .from(profile);
      profileId = next?.id ?? 2;
      await tx.insert(profile).values({ id: profileId, promptContext: "", userId });
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
              await assertMaySignUp(db, config.ownerEmail, u);
            } catch {
              deny();
            }
          },
          after: async (u) => {
            await ensureProfileForUser(db, config.ownerEmail, u ?? {});
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
              await ensureProfileForUser(db, config.ownerEmail, u);
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
