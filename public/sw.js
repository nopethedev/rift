// Minimal service worker: it only makes Rift installable and shows a friendly page when the server cannot be reached.
// It caches nothing (the content is private, per user, and large).
const OFFLINE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Rift</title>
<body style="margin:0;min-height:100dvh;display:grid;place-items:center;background:#0b0b12;color:#f3f3fa;font-family:system-ui,sans-serif;text-align:center;padding:24px">
<div><h1 style="margin:0 0 8px">Can't reach your Rift server</h1><p style="color:#9a9ab2;margin:0 0 20px">Check your connection (or that the server is running), then try again.</p>
<button onclick="location.reload()" style="background:#8b5cf6;color:#fff;border:0;border-radius:10px;padding:12px 22px;font-size:16px">Try again</button></div>`;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } })));
});
