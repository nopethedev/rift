import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";
import { getAuth, type AuthState, type AuthProfile } from "./auth";
import { rateLimit } from "./ratelimit";

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

type Level = "none" | "user" | "profile" | "admin";

export interface Ctx<P = Record<string, string>> {
  req: NextRequest;
  params: P;
  auth: AuthState;
  profile: AuthProfile;
  ip: string;
}

/** JSON response; bigint -> number so Prisma rows serialise. */
export const json = (data: unknown, init?: ResponseInit) =>
  new NextResponse(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v)), {
    ...init,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...(init?.headers ?? {}) },
  });

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

export async function body<T extends z.ZodType>(req: NextRequest, schema: T): Promise<z.infer<T>> {
  let data: unknown;
  try {
    data = await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  return parse(schema, data);
}

export const reqIp = (req: NextRequest) =>
  req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";

/**
 * Route wrapper: auth level, same-origin check for mutations, rate limit, error -> JSON mapping.
 * Levels: none | user (logged in) | profile (logged in + profile selected) | admin.
 */
export function route<P = Record<string, string>>(
  level: Level,
  fn: (ctx: Ctx<P>) => Promise<Response | unknown>,
  opts: { rate?: { key: string; max: number; windowMs: number } } = {},
) {
  return async (req: NextRequest, rc: { params: Promise<P> }): Promise<Response> => {
    try {
      const ip = reqIp(req);
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        const origin = req.headers.get("origin");
        const host = req.headers.get("host");
        if (origin && host && new URL(origin).host !== host) throw new HttpError(403, "Cross-origin request blocked");
      }
      if (opts.rate) {
        const wait = rateLimit(`${opts.rate.key}:${ip}`, opts.rate.max, opts.rate.windowMs);
        if (wait) throw new HttpError(429, `Too many requests. Try again in ${wait}s.`, { retryAfter: wait });
      }
      let auth = null as AuthState | null;
      if (level !== "none") {
        auth = await getAuth();
        if (!auth) throw new HttpError(401, "Not authenticated");
        if (level === "admin" && auth.user.role !== "ADMIN") throw new HttpError(403, "Admin only");
        if (level === "profile" && !auth.profile) throw new HttpError(409, "No profile selected");
      }
      const out = await fn({ req, params: await rc.params, auth: auth as AuthState, profile: auth?.profile as AuthProfile, ip });
      return out instanceof Response ? out : json(out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) {
        return json(
          { error: e.message, ...e.extra },
          { status: e.status, headers: e.status === 429 && e.extra?.retryAfter ? { "retry-after": String(e.extra.retryAfter) } : {} },
        );
      }
      if (e instanceof ZodError) return json({ error: e.message }, { status: 400 });
      console.error(`[api] ${req.method} ${req.nextUrl.pathname}:`, e);
      return json({ error: e instanceof Error ? e.message : "Internal error" }, { status: 500 });
    }
  };
}
