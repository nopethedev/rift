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
};
interface Resp { settings: S; ffmpeg: { ffmpeg: string | null; ffprobe: string | null; worker: { hwaccels: string[] } | null } }

export default function SettingsPage() {
  const { data, loading } = usePoll<Resp>("/api/admin/settings");
  const providers = usePoll<{ providers: { name: string; available: boolean }[] }>("/api/admin/torrents/providers");
  const [s, setS] = useState<S | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ladderText, setLadderText] = useState("");
  useEffect(() => { if (data && !s) { setS(data.settings); setLadderText(data.settings.transcodeLadder.join(", ")); } }, [data, s]);

  const set = <K extends keyof S>(k: K, v: S[K]) => setS((cur) => (cur ? { ...cur, [k]: v } : cur));

  async function save() {
    if (!s) return;
    setSaving(true);
    setMsg(null);
    try {
      const ladder = ladderText.split(/[ ,]+/).map(Number).filter((n) => n >= 144);
      const r = await api<{ settings: S }>("/api/admin/settings", { method: "PUT", body: { ...s, transcodeLadder: ladder.length ? ladder : [1080, 720, 480] } });
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
          <h2 className="font-semibold">Security</h2>
          <Input label="Session lifetime (days)" type="number" min={1} max={365} value={s.sessionDays} onChange={num("sessionDays")} hint="Applies to new sign-ins." />
          <p className="text-sm text-muted">Passwords are hashed with scrypt, sessions are random 256-bit tokens stored hashed, login and PIN attempts are rate limited, and every media endpoint requires a valid session.</p>
        </Card>
      </div>
      <ErrorNote msg={msg && !msg.ok ? msg.text : ""} />
    </>
  );
}
