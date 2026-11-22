import { request, check, until, sleep, summary, login, workerStats, BASE } from "./lib.mjs";
const api = await request.newContext({ baseURL: BASE });
await login(api);
const put = (data) => api.put("/api/admin/music/settings", { data });
await put({ musicSource: "hybrid", musicEngine: "ytdlp", musicRightsAttested: true, musicLicensePolicy: "attested", musicSearchProviders: ["soundcloud"], musicPreload: false, musicCleanupGraceSec: 2, musicMaxStreams: 0 });

// forged candidate pointing at an arbitrary URL must be ignored: the title/artist is resolved normally instead
const forged = { engine: "ytdlp", sourceId: "evil:1", title: "x", artist: "y", durationSec: 10, url: "http://127.0.0.1:8099/od2.mp3", score: 1, sig: "forged" };
await api.put("/api/music/queue", { data: { items: [{ title: "Alpha Track", artist: "Demo Artist", durationSec: 10, candidate: forged }], startIndex: 0 } });
const q = await (await api.get("/api/music/queue")).json();
check("forged candidate is dropped when queued", q.items[0].candidate === null);
const r = await api.post("/api/music/play", { data: {} });
const key = (await r.json()).play.key;
const st = await until(async () => { const s = await (await api.get(`/api/music/od/${key}/status`)).json(); return s.state === "ready" ? s : null; }, 20000, 300);
check("…and the song is resolved by title/artist instead (never the forged URL)", st?.candidate?.sourceId === "soundcloud:alpha", st?.candidate?.sourceId);

// a candidate issued by the server (search) is accepted; with a tampered url it is not
const search = await (await api.get("/api/music/search/ondemand?q=" + encodeURIComponent("Demo Artist Alpha Track"))).json();
const good = search.candidates[0];
check("search results are signed", typeof good?.sig === "string" && good.sig.length > 20);
await api.put("/api/music/queue", { data: { items: [{ title: "Alpha Track", artist: "Demo Artist", candidate: good }, { title: "Beta", artist: "x", candidate: { ...good, url: "http://169.254.169.254/" } }], startIndex: 0 } });
const q2 = await (await api.get("/api/music/queue")).json();
check("server-issued candidate kept, tampered one dropped", q2.items[0].candidate?.sourceId === good.sourceId && q2.items[1].candidate === null);

// non-admin users: no direct links
const u = await api.post("/api/admin/users", { data: { username: "listener", password: "Listener-pass-123!", role: "USER" } });
check("created a normal user", u.ok(), await u.text());
const user = await request.newContext({ baseURL: BASE });
await user.post("/api/auth/login", { data: { username: "listener", password: "Listener-pass-123!" } });
const pr = await (await user.get("/api/profiles")).json();
await user.post("/api/profiles/" + pr.profiles[0].id, { data: {} });
let d = await user.get("/api/music/search/ondemand?q=" + encodeURIComponent("http://169.254.169.254/latest/meta-data/"));
check("non-admin pasting a direct link is refused", d.status() === 403 && /administrators/i.test((await d.json()).error), `${d.status()}`);
d = await user.get("/api/music/search/ondemand?q=" + encodeURIComponent("Demo Artist Alpha Track"));
check("non-admin normal search works (on-demand access = everyone)", d.ok(), `${d.status()}`);
d = await user.post("/api/admin/music/scan");
check("non-admin cannot use music admin endpoints", d.status() === 403);
d = await user.put("/api/admin/music/settings", { data: { musicSource: "local" } });
check("non-admin cannot change music settings", d.status() === 403);
d = await request.newContext({ baseURL: BASE }).then((c) => c.get("/api/music/queue"));
check("anonymous requests are rejected", d.status() === 401);
d = await user.get("/api/music/od/" + "a".repeat(24) + "/audio");
check("unknown on-demand audio key -> 404 (no probing)", d.status() === 404, `${d.status()}`);
await api.post("/api/music/queue/clear");
summary();
