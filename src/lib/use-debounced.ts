"use client";
import { useEffect, useState } from "react";

/** Searches start this long after the last keystroke (Enter searches at once). */
export const SEARCH_DELAY_MS = 1000;

/** `value`, but only once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms = SEARCH_DELAY_MS): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
