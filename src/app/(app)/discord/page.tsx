"use client";
import { useEffect, useState } from "react";
import { Check, Copy, Gamepad2, KeyRound, Trash2 } from "lucide-react";
import { api, Button, Card, Skeleton } from "@/components/ui";
import { ErrorNote } from "@/app/admin/parts";
import { usePoll } from "@/lib/use-poll";

interface Activity { type: number; details: string; state: string }
interface State { available: boolean; token: string | null; music: boolean; stream: boolean; companionSeenAt: number | null; showing: Activity | null }

function Copyable({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-lg bg-black/40 p-3 font-mono text-xs">
      <code className="min-w-0 flex-1 break-all">{text}</code>
      <button aria-label="Copy" onClick={() => { void navigator.clipboard?.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); }} className="shrink-0 rounded p-1 text-white/60 hover:text-white">{ok ? <Check className="size-4 text-emerald-300" /> : <Copy className="size-4" />}</button>
    </div>
  );
}

export default function DiscordPage() {
  const { data, loading, error, reload } = usePoll<State>("/api/presence/settings", 5000);
  const [err, setErr] = useState("");
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(location.origin), []);
  const send = async (method: "PUT" | "POST" | "DELETE", body?: object) => {
    setErr("");
    try { await api("/api/presence/settings", { method, body }); window.dispatchEvent(new Event("rift:presence-changed")); reload(); } catch (e) { setErr((e as Error).message); }
  };
  if (loading) return <div className="mx-auto max-w-2xl p-6"><Skeleton className="h-64" /></div>;
  if (error || !data) return <p role="alert" className="p-6 text-red-300">{error || "Could not load"}</p>;
  const connected = !!data.companionSeenAt && Date.now() - data.companionSeenAt < 20_000;
  const cmd = `node rift-discord-presence.mjs --server ${origin} --token ${data.token}`;
  return (
    <div className="mx-auto max-w-2xl space-y-5 px-4 py-6 sm:py-10">
      <div className="flex items-center gap-3"><Gamepad2 className="size-7 text-accent" /><div><h1 className="text-2xl font-bold">Discord presence</h1><p className="text-sm text-muted">Show what this profile is playing on your Discord status.</p></div></div>
      <ErrorNote msg={err} />
      {!data.available && <p className="rounded-xl bg-amber-500/10 p-4 text-sm text-amber-200">An administrator needs to add a Discord Application ID first (Admin → Settings → Discord Rich Presence).</p>}
      <Card className="space-y-4">
        <h2 className="font-semibold">What to show</h2>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-violet-500" checked={data.music} onChange={(e) => send("PUT", { music: e.target.checked })} /> Music: “Listening to …” with the cover, title, artist and progress</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-violet-500" checked={data.stream} onChange={(e) => send("PUT", { stream: e.target.checked })} /> Movies and shows: “Watching …” with the poster and episode</label>
        <p className="text-xs text-muted">Only this profile is shown, and only while the companion below is running. Covers library files only exist on this server, so Discord shows a picture just for songs and titles whose artwork comes from a public source.</p>
      </Card>
      <Card className="space-y-4">
        <h2 className="font-semibold">Connect Discord</h2>
        <p className="text-sm text-white/80">Discord only lets the app on <em>your own computer</em> set a status, so a small script runs there and reads this profile&apos;s activity from Rift.</p>
        {!data.token ? (
          <Button onClick={() => send("POST")} disabled={!data.available}><KeyRound className="size-4" /> Create my link</Button>
        ) : (
          <>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-white/80">
              <li>Open Discord on your computer and install <a className="text-violet-300 underline" href="https://nodejs.org" target="_blank" rel="noreferrer">Node.js</a> (version 18 or newer) if you don&apos;t have it.</li>
              <li>Download <a className="text-violet-300 underline" href="/rift-discord-presence.mjs" download>rift-discord-presence.mjs</a> (one file, no installation).</li>
              <li>Run it in a terminal where you saved it:</li>
            </ol>
            <Copyable text={cmd} />
            <p className={connected ? "text-sm text-emerald-300" : "text-sm text-muted"}>{connected ? "Companion connected." : "Waiting for the companion to connect…"}{data.showing ? ` Showing: ${data.showing.details} · ${data.showing.state}` : connected ? " Nothing playing right now." : ""}</p>
            <p className="text-xs text-muted">Keep the link private: anyone with it can see what this profile is playing. <button className="underline hover:text-white" onClick={() => send("POST")}>Make a new link</button> (the old one stops working) · <button className="inline-flex items-center gap-1 underline hover:text-red-300" onClick={() => { if (confirm("Turn off Discord presence for this profile?")) void send("DELETE"); }}><Trash2 className="size-3" /> Turn off</button></p>
          </>
        )}
      </Card>
    </div>
  );
}
