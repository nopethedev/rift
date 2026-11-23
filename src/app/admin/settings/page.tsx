"use client";
import { useEffect, useState } from "react";
import { Check, Plus, Save, X } from "lucide-react";
import { usePoll } from "@/lib/use-poll";
import { Badge, Button, Card, Input, Select, Skeleton, api } from "@/components/ui";
import { ErrorNote, PageHeader } from "../parts";

type S = {
  serverName: string; tmdbApiKey: string; tmdbLanguage: string; libraryDirs: string[]; downloadDir: string; uploadDir: string;
  storageLimitGB: number; maxActiveDownloads: number; downloadLimitKBps: number; uploadLimitKBps: number; autoImportDownloads: boolean;
  hwaccel: string; transcodeLadder: number[]; maxTranscodeJobs: number; enforceMediabunnyAudio: boolean;
  torrentSearchProviders: string[]; torznabUrl: string; torznabApiKey: string; sessionDays: number;
  onDemandMaxStreams: number; onDemandAccess: "admins" | "everyone";
  opensubtitlesApiKey: string; opensubtitlesUsername: string; opensubtitlesPassword: string; subtitleLanguages: string[];
  whisperEnabled: boolean; whisperAuto: boolean; whisperModel: string; whisperLanguage: string; whisperTranslate: boolean; whisperAccess: "admins" | "everyone"; discordClientId: string;
};
interface Resp { settings: S; ffmpeg: { ffmpeg: string | null; ffprobe: string | null; worker: { hwaccels: string[] } | null } }

const WHISPER_LANGS: [string, string][] = [["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"], ["nl", "Dutch"], ["ru", "Russian"], ["pl", "Polish"], ["tr", "Turkish"], ["ar", "Arabic"], ["hi", "Hindi"], ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"], ["sv", "Swedish"], ["uk", "Ukrainian"], ["id", "Indonesian"]];

export default function SettingsPage() {
  const { data, loading } = usePoll<Resp>("/api/admin/settings");
  const providers = usePoll<{ providers: { name: string; available: boolean }[] }>("/api/admin/torrents/providers");
  const [s, setS] = useState<S | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ladderText, setLadderText] = useState("");
  const [langText, setLangText] = useState("");
  const [osTest, setOsTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [osBusy, setOsBusy] = useState(false);
  useEffect(() => { if (data && !s) { setS(data.settings); setLadderText(data.settings.transcodeLadder.join(", ")); setLangText(data.settings.subtitleLanguages.join(", ")); } }, [data, s]);

  const { data: ai } = usePoll<{ installed?: boolean; error?: string; running: number; queued: number }>("/api/admin/subtitles/ai");
  const set = <K extends keyof S>(k: K, v: S[K]) => setS((cur) => (cur ? { ...cur, [k]: v } : cur));

  const langList = () => { const l = langText.split(/[ ,]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z]{2,3}(-[a-z]{2,4})?$/.test(x)); return l.length ? l : ["en"]; };

  async function testOs() {
    if (!s) return;
    setOsBusy(true); setOsTest(null);
    try {
      // Save the subtitle fields first so the test uses what is on screen.
      await api("/api/admin/settings", { method: "PUT", body: { opensubtitlesApiKey: s.opensubtitlesApiKey, opensubtitlesUsername: s.opensubtitlesUsername, opensubtitlesPassword: s.opensubtitlesPassword, subtitleLanguages: langList() } });
      const r = await api<{ result: { loggedIn: boolean; remaining?: number; level?: string } }>("/api/admin/subtitles/test", { method: "POST" });
      setOsTest({ ok: true, text: r.result.loggedIn ? `Connected${r.result.level ? ` (${r.result.level})` : ""}${r.result.remaining !== undefined ? ` · ${r.result.remaining} downloads left today` : ""}.` : "API key accepted. Add your username and password to download subtitles." });
    } catch (e) { setOsTest({ ok: false, text: (e as Error).message }); }
    setOsBusy(false);
  }

  async function save() {
    if (!s) return;
    setSaving(true);
    setMsg(null);
    try {
      const ladder = ladderText.split(/[ ,]+/).map(Number).filter((n) => n >= 144);
      const r = await api<{ settings: S }>("/api/admin/settings", { method: "PUT", body: { ...s, transcodeLadder: ladder.length ? ladder : [1080, 720, 480], subtitleLanguages: langList() } });
      setS(r.settings);
      setLadderText(r.settings.transcodeLadder.join(", "));
      setMsg({ ok: true, text: "Settings saved." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
    setSaving(false);
  }

  if (loading || !s) return <><PageHeader title="Settings" /><Skeleton className="h-96" /></>;
  const num = (k: keyof S) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) as never);

  return (
    <>
      <PageHeader title="Settings" subtitle="Metadata, storage, transcoding, torrents and security." actions={<Button onClick={save} loading={saving}><Save className="size-4" /> Save changes</Button>} />
      {msg && <div className={`mb-4 rounded-lg px-3 py-2 text-sm ${msg.ok ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300"}`}>{msg.text}</div>}
      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="space-y-4">
          <h2 className="font-semibold">General &amp; TMDB</h2>
          <Input label="Server name" value={s.serverName} onChange={(e) => set("serverName", e.target.value)} />
          <Input label="TMDB API key / read access token" value={s.tmdbApiKey} onChange={(e) => set("tmdbApiKey", e.target.value)} hint="Stored on the server; shown masked. Leave the masked value to keep it." />
          <Input label="Metadata language" value={s.tmdbLanguage} onChange={(e) => set("tmdbLanguage", e.target.value)} hint="e.g. en-US, de-DE, fr-FR" />
        </Card>

        <Card className="space-y-4">
          <h2 className="font-semibold">Storage</h2>
          <div>
            <p className="mb-1.5 text-sm font-medium text-white/80">Library folders</p>
            <div className="space-y-2">
              {s.libraryDirs.map((d, i) => (
                <div key={i} className="flex gap-2">
                  <Input aria-label={`Library folder ${i + 1}`} value={d} onChange={(e) => set("libraryDirs", s.libraryDirs.map((x, j) => (j === i ? e.target.value : x)))} />
                  {s.libraryDirs.length > 1 && <Button variant="ghost" onClick={() => set("libraryDirs", s.libraryDirs.filter((_, j) => j !== i))} aria-label="Remove folder"><X className="size-4" /></Button>}
                </div>
              ))}
              <Button variant="secondary" size="sm" onClick={() => set("libraryDirs", [...s.libraryDirs, ""])}><Plus className="size-4" /> Add folder</Button>
            </div>
          </div>
          <Input label="Download folder" value={s.downloadDir} onChange={(e) => set("downloadDir", e.target.value)} />
          <Input label="Upload folder" value={s.uploadDir} onChange={(e) => set("uploadDir", e.target.value)} />
          <Input label="Download storage limit (GB, 0 = none)" type="number" min={0} value={s.storageLimitGB} onChange={num("storageLimitGB")} />
        </Card>

        <Card className="space-y-4">
          <h2 className="font-semibold">Transcoding &amp; playback</h2>
          <div className="flex flex-wrap gap-2 text-xs text-muted">
            <Badge tone={data?.ffmpeg.ffmpeg ? "green" : "red"}>ffmpeg {data?.ffmpeg.ffmpeg ? "found" : "missing"}</Badge>
            <Badge tone={data?.ffmpeg.worker ? "green" : "amber"}>worker {data?.ffmpeg.worker ? "online" : "offline"}</Badge>
            {data?.ffmpeg.worker?.hwaccels.map((h) => <Badge key={h} tone="accent">{h}</Badge>)}
          </div>
          <Select label="Hardware acceleration" value={s.hwaccel} onChange={(e) => set("hwaccel", e.target.value)}>
            <option value="none">Software (CPU)</option><option value="auto">Auto-detect</option><option value="nvenc">NVIDIA NVENC</option>
            <option value="vaapi">VAAPI</option><option value="qsv">Intel Quick Sync</option><option value="videotoolbox">Apple VideoToolbox</option>
          </Select>
          <Input label="Quality ladder (heights)" value={ladderText} onChange={(e) => setLadderText(e.target.value)} hint="Comma separated, e.g. 1080, 720, 480. Used for adaptive HLS." />
          <Input label="Max concurrent transcodes" type="number" min={1} value={s.maxTranscodeJobs} onChange={num("maxTranscodeJobs")} hint="The worker enforces its own MAX_SESSIONS environment value." />
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" checked={s.enforceMediabunnyAudio} onChange={(e) => set("enforceMediabunnyAudio", e.target.checked)} className="mt-1 size-4 accent-violet-500" />
            <span><span className="font-medium">Convert Dolby Digital / Digital Plus in the browser (Mediabunny)</span><span className="block text-muted">Recommended. DD/DD+ audio is decoded on the viewer&apos;s device and re-encoded to AAC or Opus, so the server never transcodes it for compatible video.</span></span>
          </label>
        </Card>

        <Card className="space-y-4">
          <h2 className="font-semibold">Downloads (WebTorrent)</h2>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Max active downloads" type="number" min={1} value={s.maxActiveDownloads} onChange={num("maxActiveDownloads")} />
            <Input label="Download limit (KB/s)" type="number" min={0} value={s.downloadLimitKBps} onChange={num("downloadLimitKBps")} hint="0 = unlimited" />
            <Input label="Upload limit (KB/s)" type="number" min={0} value={s.uploadLimitKBps} onChange={num("uploadLimitKBps")} hint="0 = unlimited" />
          </div>
          <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={s.autoImportDownloads} onChange={(e) => set("autoImportDownloads", e.target.checked)} className="size-4 accent-violet-500" /> Automatically scan &amp; match finished downloads</label>
          <div>
            <p className="mb-1.5 text-sm font-medium text-white/80">Torrent search providers</p>
            <div className="flex flex-wrap gap-2">
              {providers.data?.providers.map((p) => {
                const on = s.torrentSearchProviders.includes(p.name);
                return (
                  <button key={p.name} type="button" onClick={() => set("torrentSearchProviders", on ? s.torrentSearchProviders.filter((x) => x !== p.name) : [...s.torrentSearchProviders, p.name])}
                    className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-sm transition ${on ? "bg-accent/30 text-white" : "bg-white/10 text-muted hover:text-white"}`}>
                    {on && <Check className="size-3.5" />}{p.name}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-muted">Internet Archive (public-domain media) is always available. Public indexers vary in reliability.</p>
          </div>
          <Input label="Torznab URL (Jackett / Prowlarr)" value={s.torznabUrl} onChange={(e) => set("torznabUrl", e.target.value)} placeholder="http://prowlarr:9696/1/api" />
          <Input label="Torznab API key" value={s.torznabApiKey} onChange={(e) => set("torznabApiKey", e.target.value)} />
          <p className="text-xs text-muted">Only download content you own or are licensed to use. You are responsible for what you add.</p>
        </Card>

        <Card className="space-y-4">
          <h2 className="font-semibold">On-demand streaming</h2>
          <p className="text-xs text-muted">Play a title that isn&apos;t in your library: Rift finds a torrent, buffers a few MB and streams it, then deletes the data a minute after the viewer leaves. Each active stream keeps a temporary copy on disk, so cap how many can run at once if storage is tight.</p>
          <Input label="Max simultaneous streams" type="number" min={0} max={50} value={s.onDemandMaxStreams} onChange={num("onDemandMaxStreams")} hint="0 turns on-demand streaming off. Anyone starting a stream beyond the limit is asked to try again shortly." />
          <Select label="Who can start a stream" value={s.onDemandAccess} onChange={(e) => set("onDemandAccess", e.target.value as "admins" | "everyone")}>
            <option value="admins">Administrators only</option>
            <option value="everyone">Everyone with an account</option>
          </Select>
          <p className="text-xs text-muted">Only enable &ldquo;Everyone&rdquo; if you are comfortable with what your users may stream: you are responsible for the content that passes through your server.</p>
        </Card>

        <Card className="space-y-4">
          <h2 className="font-semibold">Subtitles · OpenSubtitles.com</h2>
          <p className="text-xs text-muted">Uses the current <span className="text-white/80">opensubtitles.com</span> REST API (not the old opensubtitles.org). Create a free account, then an API consumer at <span className="text-violet-300">opensubtitles.com → Profile → API consumers</span> to get a key.</p>
          <Input label="API key" value={s.opensubtitlesApiKey} onChange={(e) => set("opensubtitlesApiKey", e.target.value)} hint="Stored on the server; shown masked." />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Username" autoComplete="off" value={s.opensubtitlesUsername} onChange={(e) => set("opensubtitlesUsername", e.target.value)} />
            <Input label="Password" type="password" autoComplete="new-password" value={s.opensubtitlesPassword} onChange={(e) => set("opensubtitlesPassword", e.target.value)} />
          </div>
          <Input label="Preferred languages" value={langText} onChange={(e) => setLangText(e.target.value)} hint="ISO codes in order, e.g. en, es, pt-br. Used by “Auto-fetch missing” and as the default search languages." />
          <div className="flex items-center gap-3">
            <Button variant="secondary" size="sm" onClick={testOs} loading={osBusy} disabled={!s.opensubtitlesApiKey}>Save &amp; test connection</Button>
            {osTest && <span className={`text-sm ${osTest.ok ? "text-emerald-300" : "text-red-300"}`}>{osTest.text}</span>}
          </div>
          <p className="text-xs text-muted">Downloads need the account login; free accounts have a small daily quota. Admins can add subtitles from Media → title → file, or from the player&apos;s subtitle menu.</p>
        </Card>

        <Card className="space-y-4">
          <h2 className="font-semibold">Automatic subtitles · Whisper</h2>
          <p className="text-xs text-muted">Generates subtitles from the film&apos;s own audio with OpenAI Whisper, running on the worker&apos;s CPU. Nothing leaves your server. Cues appear while it works (it starts at the viewer&apos;s position), so you can watch with subtitles after a few seconds.</p>
          {ai && (ai.error && !("installed" in ai)
            ? <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-200">Worker unreachable: {ai.error}</p>
            : ai.installed
              ? <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">Speech engine ready on the worker · {ai.running} running, {ai.queued} waiting. The model downloads once on first use (about 40 MB for tiny).</p>
              : <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{ai.error ?? "The speech engine is not installed on the worker."}</p>)}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-violet-500" checked={s.whisperEnabled} onChange={(e) => set("whisperEnabled", e.target.checked)} /> Enable automatic subtitles</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-violet-500" checked={s.whisperAuto} disabled={!s.whisperEnabled} onChange={(e) => set("whisperAuto", e.target.checked)} /> Generate automatically when a title without subtitles is played</label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Model" value={s.whisperModel} disabled={!s.whisperEnabled} onChange={(e) => set("whisperModel", e.target.value)}>
              <option value="Xenova/whisper-tiny">Tiny (fastest, ~40 MB) · recommended</option>
              <option value="Xenova/whisper-tiny.en">Tiny, English only</option>
              <option value="Xenova/whisper-base">Base (better, ~80 MB)</option>
              <option value="Xenova/whisper-base.en">Base, English only</option>
              <option value="Xenova/whisper-small">Small (best here, ~250 MB, slow on weak CPUs)</option>
              <option value="Xenova/whisper-small.en">Small, English only</option>
            </Select>
            <Select label="Spoken language" value={s.whisperLanguage} disabled={!s.whisperEnabled} onChange={(e) => set("whisperLanguage", e.target.value)}>
              <option value="auto">Detect automatically</option>
              {WHISPER_LANGS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-violet-500" checked={s.whisperTranslate} disabled={!s.whisperEnabled} onChange={(e) => set("whisperTranslate", e.target.checked)} /> Translate foreign speech to English (instead of subtitling in the spoken language)</label>
          <Select label="Who can generate" value={s.whisperAccess} disabled={!s.whisperEnabled} onChange={(e) => set("whisperAccess", e.target.value as S["whisperAccess"])}>
            <option value="everyone">Everyone with an account</option><option value="admins">Administrators only</option>
          </Select>
          <p className="text-xs text-muted">One file is transcribed at a time (a 2-hour film takes roughly 10 to 20 minutes on 4 CPU cores with the tiny model). Tiny is fast but makes mistakes with accents, music and noise; treat it as a good-enough fallback when no real subtitles exist. Save changes to apply.</p>
        </Card>

        <Card className="space-y-4">
          <h2 className="font-semibold">Discord Rich Presence</h2>
          <Input label="Discord Application ID" value={s.discordClientId} onChange={(e) => set("discordClientId", e.target.value.replace(/\D/g, ""))} hint="Create an application at discord.com/developers, name it “Rift” (the name Discord shows after “Listening to”) and paste its Application ID here. Optional: upload an art asset called “rift” under Rich Presence. Then each profile can switch presence on under Account menu → Discord presence." />
        </Card>

        <Card className="space-y-4">
          <h2 className="font-semibold">Security</h2>
          <Input label="Session lifetime (days)" type="number" min={1} max={365} value={s.sessionDays} onChange={num("sessionDays")} hint="Applies to new sign-ins." />
          <p className="text-sm text-muted">Passwords are hashed with scrypt, sessions are random 256-bit tokens stored hashed, login and PIN attempts are rate limited, and every media endpoint requires a valid session.</p>
        </Card>
      </div>
      <ErrorNote msg={msg && !msg.ok ? msg.text : ""} />
    </>
  );
}
