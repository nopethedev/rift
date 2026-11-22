import "server-only";
import { HttpError } from "../api";
import { OnlineError, onlineEnabled } from "./online";

/** Runs an online lookup, mapping failures to clean HTTP errors (feature off -> 409, upstream trouble -> 502). */
export async function online<T>(fn: () => Promise<T>): Promise<T> {
  if (!(await onlineEnabled())) throw new HttpError(409, "Online music info is turned off (Admin → Music → Settings).");
  try { return await fn(); } catch (e) { if (e instanceof OnlineError) throw new HttpError(502, e.message); throw e; }
}
