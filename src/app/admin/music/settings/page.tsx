"use client";
import { useEffect, useState } from "react";
import { Plus, Save, X } from "lucide-react";
import { usePoll } from "@/lib/use-poll";
import { api, Badge, Button, Card, Input, Select, Skeleton } from "@/components/ui";
import { ErrorNote, PageHeader } from "../../parts";

type Node = { id: string; name: string; url: string; password: string; searchPrefix: string };
type S = {
  musicSource: "local" | "ondemand" | "hybrid"; musicEngine: "auto" | "ytdlp" | "lavalink"; musicMetadata: boolean; musicPreload: boolean; musicPreloadCount: number; musicCacheDir: string; musicMaxCacheMB: number;
  musicCacheCleanup: boolean; musicCleanupGraceSec: number; musicFormat: "mp3" | "aac" | "opus"; musicBitrate: number; musicMaxStreams: number; musicMaxDownloads: number;
  musicOnDemandAccess: "admins" | "everyone"; musicRightsAttested: boolean; musicLicensePolicy: "licensed-only" | "attested"; musicSearchProviders: ("youtube" | "soundcloud")[];
  musicLibraryDirs: string[]; musicUploadDir: string; musicLavalinkNodes: Node[]; musicLavalinkAllowedSources: string[]; musicLavalinkPlugins: { dependency: string; repository: string }[];
  musicLavalinkYoutube: Yt; musicLavalinkLyricsPlugins: boolean; musicLyrics: boolean;
  spotifyClientId: string; spotifyClientSecret: string;
};
type Yt = { enabled: boolean; oauth: boolean; refreshToken: string; poToken: string; visitorData: string; cipherUrl: string; cipherPassword: string };
const PUBLIC_CIPHER = "https://cipher.kikkia.dev/";
type Test = { ok: boolean; version?: string; sources?: string[]; plugins?: { name: string; version: string }[]; sinkReady?: boolean; bridge?: { ok: boolean; error?: string }; error?: string };

export default function MusicSettingsPage() {
  const { data, loading } = usePoll<{ settings: S }>("/api/admin/music/settings");
  const [s, setS] = useState<S | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tests, setTests] = useState<Record<string, Test | "busy">>({});
  const [srcText, setSrcText] = useState("");
  useEffect(() => { if (data && !s) { setS(data.settings); setSrcText(data.settings.musicLavalinkAllowedSources.join(", ")); } }, [data, s]);
  const set = <K extends keyof S>(k: K, v: S[K]) => setS((c) => (c ? { ...c, [k]: v } : c));
  const num = (k: keyof S) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) as never);
  const sources = () => srcText.split(/[ ,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

  async function save(): Promise<boolean> {
    if (!s) return false;
    setSaving(true); setMsg(null);
    try {
      const r = await api<{ settings: S }>("/api/admin/music/settings", { method: "PUT", body: { ...s, musicLavalinkAllowedSources: sources() } });
      setS(r.settings); setMsg({ ok: true, text: "Music settings saved." }); setSaving(false); return true;
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); setSaving(false); return false; }
  }
  async function test(n: Node) {
    setTests((t) => ({ ...t, [n.id]: "busy" }));
    try { const r = await api<Test>("/api/admin/music/lavalink/test", { method: "POST", body: n }); setTests((t) => ({ ...t, [n.id]: r })); }
    catch (e) { setTests((t) => ({ ...t, [n.id]: { ok: false, error: (e as Error).message } })); }
  }
  async function fetchToken() {
    try {
      const r = await api<{ saved: boolean; note: string }>("/api/admin/music/lavalink/youtube-token", { method: "POST" });
      setMsg({ ok: r.saved, text: r.note });
      if (r.saved) setS((c) => (c ? { ...c, musicLavalinkYoutube: { ...c.musicLavalinkYoutube, refreshToken: "••••" } } : c));
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }
  async function writeConfig() {
    if (!(await save())) return;
    try { const r = await api<{ file: string; note: string }>("/api/admin/music/lavalink/config", { method: "POST" }); setMsg({ ok: true, text: `Wrote ${r.file}. ${r.note}` }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }

  if (loading || !s) return <><PageHeader title="Music settings" /><Skeleton className="h-96" /></>;
  const onDemand = s.musicSource !== "local";
  const check = (label: string, k: "musicMetadata" | "musicPreload" | "musicCacheCleanup" | "musicRightsAttested", help?: string) => (
    <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={s[k]} onChange={(e) => set(k, e.target.checked)} className="mt-1 size-4 accent-violet-500" /><span><span className="font-medium">{label}</span>{help && <span className="block text-muted">{help}</span>}</span></label>
  );
  return (
    <>
      <PageHeader title="Music settings" subtitle="Where songs come from, and how on-demand audio is fetched, cached and cleaned up." actions={<Button onClick={save} loading={saving}><Save className="size-4" /> Save changes</Button>} />
      {msg && <div role={msg.ok ? "status" : "alert"} className={`mb-4 rounded-lg px-3 py-2 text-sm ${msg.ok ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300"}`}>{msg.text}</div>}
      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="space-y-4">
          <h2 className="font-semibold">Playback source</h2>
          <Select label="Playback source" value={s.musicSource} onChange={(e) => set("musicSource", e.target.value as S["musicSource"])}>
            <option value="local">Local library (uploaded / imported files only)</option>
            <option value="ondemand">On-demand (stream from external sources)</option>
            <option value="hybrid">Hybrid (library first, on-demand for everything else)</option>
          </Select>
          <Select label="On-demand engine" value={s.musicEngine} onChange={(e) => set("musicEngine", e.target.value as S["musicEngine"])} disabled={!onDemand}>
            <option value="auto">Both: Lavalink first, yt-dlp if it fails (recommended)</option>
            <option value="ytdlp">yt-dlp only</option>
            <option value="lavalink">Lavalink only</option>
          </Select>
          <Select label="Who can use on-demand" value={s.musicOnDemandAccess} onChange={(e) => set("musicOnDemandAccess", e.target.value as S["musicOnDemandAccess"])} disabled={!onDemand}>
            <option value="everyone">Everyone with an account</option><option value="admins">Administrators only</option>
          </Select>
          {onDemand && (
            <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" checked={s.musicRightsAttested} onChange={(e) => setS({ ...s, musicRightsAttested: e.target.checked, ...(e.target.checked ? { musicLicensePolicy: "attested" as const } : {}) })} className="mt-1 size-4 accent-violet-500" />
                <span><span className="font-medium">I agree: I have the rights to download and stream audio from the sources I enable</span><span className="block text-muted">Ticking this switches on-demand playback on for any result (no per-track licence check). It stays off until you agree. You are responsible for what passes through your server.</span></span>
              </label>
              <Select label="Licence policy (yt-dlp)" value={s.musicLicensePolicy} onChange={(e) => set("musicLicensePolicy", e.target.value as S["musicLicensePolicy"])}>
                <option value="licensed-only">Open-licensed only: Creative Commons / public domain (strict)</option>
                <option value="attested">Any result: I agreed to the rights above</option>
              </Select>
              <p className="text-xs text-muted">With &ldquo;open-licensed only&rdquo; each result&apos;s licence is read from the source and anything else is refused. Lavalink cannot report licences, so it only plays the source types you allow under Lavalink below.</p>
            </div>
          )}
        </Card>

        <Card className="space-y-4">
          <h2 className="font-semibold">Streaming &amp; cache</h2>
          {check("Online album art, artist info and music feed", "musicMetadata", "Fetches missing album covers, artist photos and bios, charts and new releases from Deezer, iTunes and Wikipedia. Only artist, album and title text is sent; nothing about your listening. Images are cached on this server.")}
          {check("Preload upcoming songs", "musicPreload", "Fetches the next songs in the queue before they play, and cancels them when the queue changes.")}
          <Input label="Songs to preload" type="number" min={1} max={5} value={s.musicPreloadCount} onChange={num("musicPreloadCount")} disabled={!s.musicPreload} />
          <Input label="Temporary cache directory" value={s.musicCacheDir} onChange={(e) => set("musicCacheDir", e.target.value)} placeholder="(worker default: <transcode dir>/music-cache)" hint="Path on the worker's filesystem (a rift-music subfolder is used). Temporary audio only." />
          <Input label="Maximum cache size (MB)" type="number" min={64} value={s.musicMaxCacheMB} onChange={num("musicMaxCacheMB")} hint="Least recently used unused audio is evicted first; when everything is in use, new fetches wait or fail instead of overfilling the disk." />
          {check("Automatic cache cleanup", "musicCacheCleanup", "Deletes a track's audio after nobody needs it any more (finished, skipped, or the listener left).")}
          <Input label="Delete unused audio after (seconds)" type="number" min={0} value={s.musicCleanupGraceSec} onChange={num("musicCleanupGraceSec")} disabled={!s.musicCacheCleanup} hint="A short delay lets “previous” and quick replays reuse the cached file." />
          <div className="grid grid-cols-2 gap-3">
            <Select label="Streaming format" value={s.musicFormat} onChange={(e) => set("musicFormat", e.target.value as S["musicFormat"])}><option value="mp3">MP3 (works everywhere)</option><option value="aac">AAC</option><option value="opus">Opus (not on older Safari)</option></Select>
            <Select label="Bitrate" value={s.musicBitrate} onChange={(e) => set("musicBitrate", Number(e.target.value))}>{[96, 128, 160, 192, 256, 320].map((b) => <option key={b} value={b}>{b} kbps</option>)}</Select>
            <Input label="Concurrent listeners (0 = no limit)" type="number" min={0} value={s.musicMaxStreams} onChange={num("musicMaxStreams")} />
            <Input label="Concurrent downloads" type="number" min={1} max={16} value={s.musicMaxDownloads} onChange={num("musicMaxDownloads")} />
          </div>
        </Card>

        <Card className="space-y-4">
          <h2 className="font-semibold">yt-dlp engine</h2>
          <p className="text-xs text-muted">Searches the enabled sources, matches title/artist/duration, avoids remixes, covers and live versions unless asked for, and streams the audio into the cache. yt-dlp must be installed on the worker (the Docker image includes it).</p>
          <div className="flex gap-2">
            {(["soundcloud", "youtube"] as const).map((p) => { const on = s.musicSearchProviders.includes(p); return <button key={p} type="button" onClick={() => set("musicSearchProviders", on ? s.musicSearchProviders.filter((x) => x !== p) : [...s.musicSearchProviders, p])} className={`rounded-full px-3 py-1 text-sm capitalize ${on ? "bg-accent/30 text-white" : "bg-white/10 text-muted hover:text-white"}`}>{p}</button>; })}
          </div>
        </Card>

        <Card className="space-y-4 xl:col-span-2">
          <div className="flex items-center justify-between"><h2 className="font-semibold">Lavalink engine</h2><Badge tone="amber">needs the Rift audio bridge</Badge></div>
          <p className="text-xs text-muted">Lavalink only outputs audio to Discord-style voice connections. Rift therefore runs a small <span className="text-white/80">audio bridge</span> on the worker that Lavalink connects to as a voice server; the received Opus audio is cached and streamed to browsers like any other on-demand track. Lavalink plays in real time, so a song becomes fully seekable once its capture finishes. Nodes must be able to reach the worker&apos;s bridge port and trust its certificate (see the README).</p>
          <div className="space-y-3">
            {s.musicLavalinkNodes.map((n, i) => {
              const t = tests[n.id];
              const up = (patch: Partial<Node>) => set("musicLavalinkNodes", s.musicLavalinkNodes.map((x, j) => (j === i ? { ...x, ...patch } : x)));
              return (
                <div key={i} className="rounded-xl border border-line p-3">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_2fr_1fr_1fr_auto]">
                    <Input label="Node id" value={n.id} onChange={(e) => up({ id: e.target.value })} />
                    <Input label="Name" value={n.name} onChange={(e) => up({ name: e.target.value })} />
                    <Input label="URL" value={n.url} onChange={(e) => up({ url: e.target.value })} placeholder="http://lavalink:2333" />
                    <Input label="Password" type="password" autoComplete="new-password" value={n.password} onChange={(e) => up({ password: e.target.value })} />
                    <Input label="Search prefix" value={n.searchPrefix} onChange={(e) => up({ searchPrefix: e.target.value })} hint="auto = every allowed source, or e.g. scsearch,ytsearch,spsearch" />
                    <div className="flex items-end"><Button variant="ghost" aria-label="Remove node" onClick={() => set("musicLavalinkNodes", s.musicLavalinkNodes.filter((_, j) => j !== i))}><X className="size-4" /></Button></div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                    <Button size="sm" variant="secondary" loading={t === "busy"} onClick={() => test(n)}>Test connection</Button>
                    {t && t !== "busy" && (t.ok ? <span className="text-emerald-300">Lavalink {t.version} · sources: {t.sources?.join(", ")}{t.plugins?.length ? ` · plugins: ${t.plugins.map((p) => p.name).join(", ")}` : ""} · bridge {t.sinkReady ? "ready" : "not running"}{t.bridge && (t.bridge.ok ? <span> · node → bridge: <b>works</b></span> : <span className="block text-amber-300">This node can&apos;t play into Rift: {t.bridge.error}</span>)}</span> : <span className="text-red-300">{t.error}</span>)}
                  </div>
                </div>
              );
            })}
            <Button size="sm" variant="secondary" onClick={() => set("musicLavalinkNodes", [...s.musicLavalinkNodes, { id: `node${s.musicLavalinkNodes.length + 1}`, name: "Lavalink node", url: "http://", password: "", searchPrefix: "scsearch" }])}><Plus className="size-4" /> Add node</Button>
          </div>
          <Input label="Allowed source types" value={srcText} onChange={(e) => setSrcText(e.target.value)} hint="Lavalink sourceNames that may be played, e.g. http, soundcloud, bandcamp. Lavalink can't read licences, so only list sources you are entitled to stream." />
          {(() => {
            const yt = s.musicLavalinkYoutube;
            const up = (patch: Partial<Yt>) => set("musicLavalinkYoutube", { ...yt, ...patch });
            const ytAllowed = sources().some((x) => x === "youtube" || x === "youtubemusic");
            return (
              <div className="space-y-3 rounded-lg border border-white/10 p-3">
                <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={yt.enabled} onChange={(e) => up({ enabled: e.target.checked })} className="mt-1 size-4 accent-violet-500" /><span><span className="font-medium">YouTube on the bundled Lavalink</span><span className="block text-xs text-muted">Adds the <code>youtube-source</code> plugin (Lavalink&apos;s built-in YouTube source no longer works and is switched off). Searches YouTube Music first. Nodes you didn&apos;t start with Rift need this set up on their side.</span></span></label>
                {yt.enabled && (
                  <>
                    {!ytAllowed && <p className="flex flex-wrap items-center gap-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">&ldquo;youtube&rdquo; isn&apos;t in the allowed source types below, so YouTube results are searched but never played. <button type="button" onClick={() => setSrcText((t) => [t.trim(), "youtube"].filter(Boolean).join(", "))} className="font-semibold underline">Allow YouTube</button></p>}
                    <p className="text-xs text-muted">Set the node&apos;s search prefix to <code>auto</code> (or <code>ytmsearch, scsearch</code>) so Rift searches YouTube on it.</p>
                    <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
                      <Input label="Remote cipher server" value={yt.cipherUrl} placeholder={PUBLIC_CIPHER} onChange={(e) => up({ cipherUrl: e.target.value })} hint="Deciphers YouTube's stream signatures, the usual reason YouTube tracks won't play. The default is a free public yt-cipher instance (rate limited); run your own for reliability. Empty = the plugin deciphers itself." />
                      <Input label="Cipher password" type="password" autoComplete="new-password" value={yt.cipherPassword} onChange={(e) => up({ cipherPassword: e.target.value })} hint="Only for your own yt-cipher (its API_TOKEN)." />
                    </div>
                    <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={yt.oauth} onChange={(e) => up({ oauth: e.target.checked })} className="mt-1 size-4 accent-violet-500" /><span><span className="font-medium">Sign in to YouTube (OAuth)</span><span className="block text-xs text-muted">The most reliable fix for &ldquo;Sign in to confirm you&apos;re not a bot&rdquo;. <b className="text-amber-200">Use a throwaway Google account</b>: accounts used this way can get flagged. After writing the config and restarting, run <code>docker compose logs -f lavalink</code>, open the google.com/device link it prints and enter the code. Then press &ldquo;Get token from node&rdquo; so the sign-in survives restarts.</span></span></label>
                    {yt.oauth && (
                      <div className="flex items-end gap-2">
                        <Input label="Refresh token" type="password" autoComplete="new-password" value={yt.refreshToken} placeholder="filled in after the sign-in" onChange={(e) => up({ refreshToken: e.target.value })} />
                        <Button size="sm" variant="secondary" onClick={fetchToken}>Get token from node</Button>
                      </div>
                    )}
                    <details className="text-xs text-muted">
                      <summary className="cursor-pointer text-white/70">poToken (advanced, instead of signing in)</summary>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <Input label="poToken" type="password" autoComplete="new-password" value={yt.poToken} onChange={(e) => up({ poToken: e.target.value })} />
                        <Input label="visitorData" value={yt.visitorData} onChange={(e) => up({ visitorData: e.target.value })} />
                      </div>
                      <p className="mt-1">Used by the WEB clients only, and only when both are set. Tokens expire; signing in is easier.</p>
                    </details>
                  </>
                )}
              </div>
            );
          })()}
          <div className="space-y-2 rounded-lg border border-white/10 p-3">
            <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={s.musicLyrics} onChange={(e) => set("musicLyrics", e.target.checked)} className="mt-1 size-4 accent-violet-500" /><span><span className="font-medium">Lyrics in the player</span><span className="block text-xs text-muted">Looked up through a Lavalink node with the LavaLyrics plugin (any song, also library and yt-dlp ones). Time-synced where available.</span></span></label>
            <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={s.musicLavalinkLyricsPlugins} onChange={(e) => set("musicLavalinkLyricsPlugins", e.target.checked)} className="mt-1 size-4 accent-violet-500" /><span><span className="font-medium">Lyrics plugins on the bundled Lavalink</span><span className="block text-xs text-muted">Adds LavaLyrics + LavaSrc with LRCLIB (synced) and YouTube Music lyrics. No accounts needed; LavaSrc&apos;s other sources stay off.</span></span></label>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium text-white/80">Plugins for the bundled Lavalink</p>
            <div className="space-y-2">
              {s.musicLavalinkPlugins.map((p, i) => (
                <div key={i} className="flex gap-2">
                  <Input aria-label="Plugin dependency" value={p.dependency} placeholder="group:artifact:version" onChange={(e) => set("musicLavalinkPlugins", s.musicLavalinkPlugins.map((x, j) => (j === i ? { ...x, dependency: e.target.value } : x)))} />
                  <Input aria-label="Plugin repository" value={p.repository} placeholder="repository URL (optional)" onChange={(e) => set("musicLavalinkPlugins", s.musicLavalinkPlugins.map((x, j) => (j === i ? { ...x, repository: e.target.value } : x)))} />
                  <Button variant="ghost" aria-label="Remove plugin" onClick={() => set("musicLavalinkPlugins", s.musicLavalinkPlugins.filter((_, j) => j !== i))}><X className="size-4" /></Button>
                </div>
              ))}
              <div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => set("musicLavalinkPlugins", [...s.musicLavalinkPlugins, { dependency: "", repository: "" }])}><Plus className="size-4" /> Add plugin</Button><Button size="sm" variant="secondary" onClick={writeConfig}>Save &amp; write Lavalink config</Button></div>
              <p className="text-xs text-muted">Writes the bundled node&apos;s <code>application.yml</code> (password, plugins, YouTube and lyrics settings) to the shared config volume; restart the <code>lavalink</code> container to apply (<code>docker compose restart lavalink</code>). Plugins you list here win over Rift&apos;s defaults, e.g. to pin another version.</p>
            </div>
          </div>
        </Card>

        <Card className="space-y-4">
          <h2 className="font-semibold">Library folders</h2>
          <div className="space-y-2">
            {s.musicLibraryDirs.map((d, i) => <div key={i} className="flex gap-2"><Input aria-label={`Music folder ${i + 1}`} value={d} onChange={(e) => set("musicLibraryDirs", s.musicLibraryDirs.map((x, j) => (j === i ? e.target.value : x)))} />{s.musicLibraryDirs.length > 1 && <Button variant="ghost" aria-label="Remove folder" onClick={() => set("musicLibraryDirs", s.musicLibraryDirs.filter((_, j) => j !== i))}><X className="size-4" /></Button>}</div>)}
            <Button size="sm" variant="secondary" onClick={() => set("musicLibraryDirs", [...s.musicLibraryDirs, ""])}><Plus className="size-4" /> Add folder</Button>
          </div>
          <Input label="Upload folder" value={s.musicUploadDir} onChange={(e) => set("musicUploadDir", e.target.value)} hint="Must be inside a music folder (or it is indexed on upload only). Uploaded music stays until deleted." />
        </Card>

        <Card className="space-y-4">
          <h2 className="font-semibold">Spotify playlist import</h2>
          <p className="text-xs text-muted">Optional. Without credentials Rift reads the first 100 tracks of public playlists. With a client id/secret (free at developer.spotify.com) it imports whole playlists. Only metadata is imported: no Spotify audio is downloaded and no DRM is touched.</p>
          <Input label="Client id" value={s.spotifyClientId} onChange={(e) => set("spotifyClientId", e.target.value)} />
          <Input label="Client secret" type="password" autoComplete="new-password" value={s.spotifyClientSecret} onChange={(e) => set("spotifyClientSecret", e.target.value)} />
        </Card>
      </div>
      <ErrorNote msg={msg && !msg.ok ? msg.text : ""} />
    </>
  );
}
