import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { redirect } from "next/navigation";
import { db } from "./db";
import { env } from "./config";
import { getSettings } from "./settings";
import { newToken, sha256 } from "./security";

export const SESSION_COOKIE = "rift_session";
export const MAX_PROFILES = 5;

export interface AuthUser { id: string; username: string; displayName: string | null; role: "ADMIN" | "USER" }
export interface AuthProfile { id: string; name: string; avatar: string; isKids: boolean; hasPin: boolean }
export interface AuthState {
  sessionId: string;
  user: AuthUser;
  profile: AuthProfile | null;
}

export async function createSession(userId: string, opts: { userAgent?: string | null; ip?: string }) {
  const s = await getSettings();
  const token = newToken();
  const expiresAt = new Date(Date.now() + s.sessionDays * 86400_000);
  await db.session.create({ data: { tokenHash: sha256(token), userId, userAgent: opts.userAgent?.slice(0, 250), ip: opts.ip, expiresAt } });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: env.secureCookies, path: "/", expires: expiresAt,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.session.deleteMany({ where: { tokenHash: sha256(token) } });
  jar.delete(SESSION_COOKIE);
}

/** Resolve the current session (cached per request). Null when logged out / expired / user disabled. */
export const getAuth = cache(async (): Promise<AuthState | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = await db.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!row || row.expiresAt < new Date() || row.user.disabled) return null;
  if (Date.now() - row.lastSeenAt.getTime() > 5 * 60_000) {
    db.session.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  }
  let profile: AuthProfile | null = null;
  if (row.profileId) {
    const p = await db.profile.findFirst({ where: { id: row.profileId, userId: row.userId } });
    if (p) profile = { id: p.id, name: p.name, avatar: p.avatar, isKids: p.isKids, hasPin: !!p.pinHash };
  }
  return {
    sessionId: row.id,
    user: { id: row.user.id, username: row.user.username, displayName: row.user.displayName, role: row.user.role as "ADMIN" | "USER" },
    profile,
  };
});

export async function selectProfile(sessionId: string, profileId: string | null) {
  await db.session.update({ where: { id: sessionId }, data: { profileId } });
}

export const isSetupComplete = cache(async () => {
  if ((await getSettings()).setupComplete) return true;
  return (await db.user.count()) > 0;
});

/** Server-component guards. */
export async function requireUser(): Promise<AuthState> {
  if (!(await isSetupComplete())) redirect("/setup");
  const a = await getAuth();
  if (!a) redirect("/login");
  return a;
}
export async function requireProfile(): Promise<AuthState & { profile: AuthProfile }> {
  const a = await requireUser();
  if (!a.profile) redirect("/profiles");
  return a as AuthState & { profile: AuthProfile };
}
export async function requireAdmin(): Promise<AuthState> {
  const a = await requireUser();
  if (a.user.role !== "ADMIN") redirect("/");
  return a;
}
