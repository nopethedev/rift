import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export type AppId = "stream" | "music";
export const APP_COOKIE = "rift_app"; // session cookie: which app was picked since the browser was opened
export const LAST_APP_COOKIE = "rift_app_last"; // remembered for a year, only to highlight "last used"

const valid = (v: string | undefined): v is AppId => v === "stream" || v === "music";

/** The app picker ("Stream" or "Music") is shown once per browser session, right after the site is opened and signed in. */
export async function requireAppChoice(): Promise<AppId> {
  const v = (await cookies()).get(APP_COOKIE)?.value;
  if (!valid(v)) redirect("/apps");
  return v;
}
export async function lastApp(): Promise<AppId | null> {
  const v = (await cookies()).get(LAST_APP_COOKIE)?.value;
  return valid(v) ? v : null;
}
