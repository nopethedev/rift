"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronLeft, Cpu, FolderOpen, KeyRound, ShieldCheck, Server } from "lucide-react";
import { Button, Input, Select, api } from "@/components/ui";

const STEPS = [
  { id: "admin", label: "Administrator", icon: ShieldCheck },
  { id: "tmdb", label: "Metadata", icon: KeyRound },
  { id: "storage", label: "Storage", icon: FolderOpen },
  { id: "ffmpeg", label: "Transcoding", icon: Cpu },
] as const;

interface Check { ffmpeg: string | null; ffprobe: string | null; worker: { ok: true; ffmpeg: string; hwaccels: string[] } | null }

export function SetupWizard({ defaults }: { defaults: { mediaDir: string; downloadDir: string; hasEnvTmdb: boolean } }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tmdbState, setTmdbState] = useState<"idle" | "ok" | "bad">("idle");
  const [pathInfo, setPathInfo] = useState<{ path: string; ok: boolean; exists?: boolean; freeGB?: number; error?: string }[]>([]);
  const [ff, setFf] = useState<Check | null>(null);
  const [f, setF] = useState({
    username: "admin", password: "", confirm: "", serverName: "Rift", tmdbApiKey: "",
    libraryDir: defaults.mediaDir, downloadDir: defaults.mediaDir + "/downloads", storageLimitGB: 0, hwaccel: "none",
  });
  const set = (k: keyof typeof f, v: string | number) => setF((s) => ({ ...s, [k]: v }));

  async function next() {
    setError("");
    if (step === 0) {
      if (f.username.trim().length < 3) return setError("Username must be at least 3 characters");
      if (f.password.length < 8) return setError("Password must be at least 8 characters");
      if (f.password !== f.confirm) return setError("Passwords do not match");
    }
    if (step === 1 && f.tmdbApiKey) {
      setBusy(true);
      try {
        const r = await api("/api/setup/check", { method: "POST", body: { tmdbApiKey: f.tmdbApiKey } });
        setTmdbState(r.tmdb.ok ? "ok" : "bad");
        if (!r.tmdb.ok) { setBusy(false); return setError(r.tmdb.error); }
      } catch (e) { setBusy(false); return setError((e as Error).message); }
      setBusy(false);
    }
    if (step === 2) {
      setBusy(true);
      try {
        const r = await api("/api/setup/check", { method: "POST", body: { paths: [f.libraryDir, f.downloadDir] } });
        setPathInfo(r.paths);
        const bad = r.paths.find((p: { ok: boolean }) => !p.ok);
        if (bad) { setBusy(false); return setError(`${bad.path}: ${bad.error}`); }
        setFf((await api("/api/setup/check", { method: "POST", body: { ffmpeg: true } })).ffmpeg);
      } catch (e) { setBusy(false); return setError((e as Error).message); }
      setBusy(false);
    }
    setStep((s) => s + 1);
  }

  async function finish() {
    setBusy(true);
    setError("");
    try {
      await api("/api/setup", {
        method: "POST",
        body: {
          username: f.username, password: f.password, serverName: f.serverName, tmdbApiKey: f.tmdbApiKey,
          libraryDirs: [f.libraryDir], downloadDir: f.downloadDir, storageLimitGB: Number(f.storageLimitGB) || 0, hwaccel: f.hwaccel,
        },
      });
      router.replace("/profiles");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-line bg-surface/80 p-7 shadow-2xl backdrop-blur">
      <ol className="mb-7 flex items-center justify-between gap-2">
        {STEPS.map((s, i) => (
          <li key={s.id} className="flex flex-1 items-center gap-2 text-xs">
            <span className={`flex size-8 shrink-0 items-center justify-center rounded-full border transition ${i < step ? "border-accent bg-accent text-white" : i === step ? "border-accent text-accent" : "border-line text-muted"}`}>
              {i < step ? <Check className="size-4" /> : <s.icon className="size-4" />}
            </span>
            <span className={`hidden sm:block ${i === step ? "text-white" : "text-muted"}`}>{s.label}</span>
            {i < STEPS.length - 1 && <span className="h-px flex-1 bg-line" />}
          </li>
        ))}
      </ol>

      <AnimatePresence mode="wait">
        <motion.div key={step} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.18 }} className="space-y-4">
          {step === 0 && (
            <>
              <div>
                <h1 className="text-2xl font-bold">Welcome to Rift</h1>
                <p className="mt-1 text-sm text-muted">Create the administrator account. This account manages users, the library and downloads.</p>
              </div>
              <Input label="Server name" value={f.serverName} onChange={(e) => set("serverName", e.target.value)} />
              <Input label="Admin username" value={f.username} onChange={(e) => set("username", e.target.value)} autoComplete="username" />
              <Input label="Password" type="password" value={f.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" hint="At least 8 characters." />
              <Input label="Confirm password" type="password" value={f.confirm} onChange={(e) => set("confirm", e.target.value)} autoComplete="new-password" />
            </>
          )}
          {step === 1 && (
            <>
              <div>
                <h2 className="text-xl font-bold">TMDB metadata</h2>
                <p className="mt-1 text-sm text-muted">
                  Posters, backdrops, trailers and discovery come from TMDB. Paste a free API key (v3) or a read access token from themoviedb.org/settings/api.
                  {defaults.hasEnvTmdb && " A key is already provided through the TMDB_API_KEY environment variable."}
                </p>
              </div>
              <Input label="TMDB API key / read access token" value={f.tmdbApiKey} onChange={(e) => { set("tmdbApiKey", e.target.value); setTmdbState("idle"); }} placeholder={defaults.hasEnvTmdb ? "Using environment variable" : "Optional. You can add it later in Settings."} />
              {tmdbState === "ok" && <p className="text-sm text-emerald-300">✓ Key verified</p>}
              <p className="text-xs text-muted">Without a key Rift still plays your local files, but discovery rows and metadata matching stay empty.</p>
            </>
          )}
          {step === 2 && (
            <>
              <div>
                <h2 className="text-xl font-bold">Storage</h2>
                <p className="mt-1 text-sm text-muted">Absolute paths on the server (or container). Folders are created when missing.</p>
              </div>
              <Input label="Media library folder" value={f.libraryDir} onChange={(e) => set("libraryDir", e.target.value)} hint="Scanned for movies and TV shows. More folders can be added in Settings." />
              <Input label="Torrent download folder" value={f.downloadDir} onChange={(e) => set("downloadDir", e.target.value)} hint="Keep it inside a library folder so finished downloads are scanned automatically." />
              <Input label="Download storage limit (GB)" type="number" min={0} value={f.storageLimitGB} onChange={(e) => set("storageLimitGB", e.target.value)} hint="0 = unlimited." />
              {pathInfo.map((p) => p.ok && p.freeGB !== undefined && <p key={p.path} className="text-xs text-muted">{p.path}: {p.freeGB} GB free</p>)}
            </>
          )}
          {step === 3 && (
            <>
              <div>
                <h2 className="text-xl font-bold">Transcoding</h2>
                <p className="mt-1 text-sm text-muted">Compatible files direct-play. Dolby Digital Plus audio is converted live in your browser with Mediabunny; other incompatible video is transcoded by the FFmpeg worker.</p>
              </div>
              <div className="space-y-2 rounded-xl border border-line bg-bg/60 p-4 text-sm">
                <Row ok={!!ff?.ffmpeg} label="FFmpeg" value={ff?.ffmpeg ?? "not found on the web host"} />
                <Row ok={!!ff?.ffprobe} label="FFprobe" value={ff?.ffprobe ?? "not found on the web host"} />
                <Row ok={!!ff?.worker} label="Transcode worker" value={ff?.worker ? `online · hardware: ${ff.worker.hwaccels.join(", ") || "none"}` : "offline (start `npm run start:worker`)"} />
              </div>
              <Select label="Hardware acceleration" value={f.hwaccel} onChange={(e) => set("hwaccel", e.target.value)}>
                <option value="none">Software (CPU)</option>
                <option value="auto">Auto-detect</option>
                <option value="nvenc">NVIDIA NVENC</option>
                <option value="vaapi">VAAPI (Intel/AMD, Linux)</option>
                <option value="qsv">Intel Quick Sync</option>
                <option value="videotoolbox">Apple VideoToolbox</option>
              </Select>
              <div className="flex items-center gap-2 text-xs text-muted"><Server className="size-3.5" /> You can change all of this later under Admin → Settings.</div>
            </>
          )}
        </motion.div>
      </AnimatePresence>

      {error && <p role="alert" className="mt-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}

      <div className="mt-7 flex items-center justify-between">
        <Button variant="ghost" onClick={() => setStep((s) => s - 1)} className={step === 0 ? "invisible" : ""}><ChevronLeft className="size-4" /> Back</Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={next} loading={busy}>{step === 1 && !f.tmdbApiKey ? "Skip for now" : "Continue"}</Button>
        ) : (
          <Button onClick={finish} loading={busy}>Finish setup</Button>
        )}
      </div>
    </div>
  );
}

function Row({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${ok ? "bg-emerald-400" : "bg-amber-400"}`} />
      <span className="w-32 shrink-0 text-white/70">{label}</span>
      <span className="min-w-0 break-words text-white/90">{value}</span>
    </div>
  );
}
