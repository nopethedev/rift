"use client";
import { useEffect } from "react";

/** Registers the (tiny) service worker so browsers offer "Install app" / "Add to Home Screen". Production only. */
export function Pwa() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }, []);
  return null;
}
