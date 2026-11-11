/**
 * Invite list: only emails listed here (or emails in `BOOTSTRAP_OWNER_EMAILS` while there is no owner yet) can sign up. The "before
 * create user" hook of Better Auth looks up this table and rejects when not found or on error (fail-closed).
 *
 * `email` is always lowercase (CHECK constraint) so comparison does not depend on letter case.
 */
import { sql } from "drizzle-orm";
import { check, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { profile } from "./profile.ts";

export const invites = pgTable(
  "invites",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull().unique(),
    /** Profile of the inviter; empty when the project owner adds directly. */
    invitedByProfileId: integer("invited_by_profile_id").references(() => profile.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the invitee finishes signing up; empty = not used yet. */
    usedAt: timestamp("used_at", { withTimezone: true }),
    /** Role granted when the invitee signs up: `member` (default) or `owner`. */
    role: text("role").notNull().default("member"),
  },
  (t) => [
    check("invites_email_lower_ck", sql`${t.email} = lower(${t.email})`),
    check("invites_role_ck", sql`${t.role} in ('owner', 'member')`),
  ],
);
