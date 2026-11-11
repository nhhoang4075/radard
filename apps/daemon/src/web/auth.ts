/**
 * Web sign-in with Better Auth (1.6.23): Drizzle adapter on Postgres, GitHub and Google.
 * Owners live in the DB (`user_roles`), not in environment variables (decision 11/11/2026).
 *
 * Two hooks of `databaseHooks`, both FAIL-CLOSED (on error or unclear result they reject):
 *  - `user.create.before`: only a verified email AND (an unused invite, OR an email listed in
 *    `BOOTSTRAP_OWNER_EMAILS` while the DB has no owner) may create a user.
 *  - `user.create.after` (and `session.create.before` as a safety net, since the "after" hook runs after the transaction and can fail on its own):
 *    ensures the user has a profile, in one transaction under an advisory lock.
 *    Bootstrap path (no owner yet): assign the owner role and take the smallest unowned profile (create one if none
 *    exists). Invite path: the role comes from `invites.role`, always a NEW empty profile. Never takes
 *    a profile that already has a `user_id`.
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

/** Short error code for the log (the driver message includes query parameters, including the email). */
function errCode(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : err instanceof Error ? err.name : "unknown";
}

export interface HookUser {
  id?: unknown;
  email?: unknown;
  emailVerified?: unknown;
}

/** Rejects user creation (fail-closed). The specific reason is not disclosed outside. */
export class SignUpDenied extends Error {}

type Executor = Pick<Database, "select">;

/** Whether the DB has at least one owner yet. An error (e.g. missing table) throws, and the caller rejects. */
async function hasOwner(q: Executor): Promise<boolean> {
  const [row] = await q
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .where(eq(userRoles.role, "owner"))
    .limit(1);
  return row !== undefined;
}

/**
 * Allows creating a user when the email is verified and (invited, or listed in `bootstrapOwnerEmails` while there is no
 * owner). Every other branch, including query errors or a missing table, throws `SignUpDenied`.
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
 * Ensures the user has a profile (idempotent). Returns the profile id. The role and profile are written in the same transaction.
 *  - Already has a profile linked to this user: return it.
 *  - Inside the transaction (advisory lock, rechecked inside): the email is in `bootstrapOwnerEmails` AND there is no
 *    owner yet → assign owner, take the unowned profile (`user_id` NULL) with the smallest id, create one if none exists.
 *  - Otherwise an invite is required (used or unused both work; revoked does not): the role comes from `invites.role`,
 *    always create a NEW empty profile (id = max + 1), never take an old profile.
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
      // Bootstrap path: take the smallest unowned profile.
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
      // Invite path: the invite must still be in the table (used or unused both work); a revoked invite does not.
      if (!inv) throw new Error("không có lời mời cho email này, không tạo hồ sơ");
      // Owner rights come only from an UNUSED invite: a used invite must never re-grant owner (e.g. after `owners remove` + `profiles relink`).
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
  /** Tests only: extra plugins (e.g. `testUtils`). Never passed in the real flow. */
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
    // Sign-in errors (e.g. not invited) redirect to the sign-in page with `?error=…`.
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
          // Safety net: the user was created but the "after" step failed, so the next sign-in re-links the profile.
          // If linking fails, do not issue a session.
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
