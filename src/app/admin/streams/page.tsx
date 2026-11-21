"use client";
import { Activity, Cpu, Square } from "lucide-react";
import { usePoll } from "@/lib/use-poll";
import { fmtDuration } from "@/lib/types";
import { Avatar } from "@/components/brand";
import { Badge, Button, Card, ProgressBar, api } from "@/components/ui";
import { PageHeader, ago } from "../parts";

interface S { id: string; user: string; profile: string; avatar: string; mode: string; detail: string | null; ip: string | null; startedAt: string; positionSec: number; durationSec: number | null; title: string }
interface T { sessionId: string; inputPath: string; state: string; startedAt: number; speed?: number; fps?: number; hwaccel: string; segmentsReady: number; segmentsTotal: number; variants: { height: number }[] }

export default function StreamsPage() {
  const { data, reload } = usePoll<{ streams: S[]; transcodes: T[] }>("/api/admin/streams", 3000);
  return (
    <>
      <PageHeader title="Active streams" subtitle="Live playback sessions and transcodes on the FFmpeg worker." />
      <div className="space-y-3">
        {data?.streams.map((s) => (
          <Card key={s.id} className="flex flex-wrap items-center gap-4">
            <Avatar avatar={s.avatar} size={44} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{s.title}</p>
              <p className="text-sm text-muted">{s.profile} <span className="text-white/30">({s.user})</span> · {s.ip ?? "?"} · started {ago(s.startedAt)}</p>
              <div className="mt-2 flex items-center gap-3">
                <ProgressBar value={s.durationSec ? s.positionSec / s.durationSec : 0} className="max-w-xs flex-1" />
                <span className="text-xs text-muted">{fmtDuration(s.positionSec)}{s.durationSec ? ` / ${fmtDuration(s.durationSec)}` : ""}</span>
              </div>
            </div>
            <div className="text-right">
              <Badge tone={s.mode === "direct" ? "green" : s.mode === "mediabunny" ? "accent" : "amber"}>{s.mode === "mediabunny" ? "in-browser" : s.mode}</Badge>
              {s.detail && <p className="mt-1 max-w-xs truncate text-xs text-muted">{s.detail}</p>}
            </div>
          </Card>
        ))}
        {data && !data.streams.length && (
          <Card className="flex flex-col items-center gap-2 py-12 text-center text-muted"><Activity className="size-8" /> Nobody is watching right now.</Card>
        )}
      </div>

      <h2 className="mb-3 mt-10 flex items-center gap-2 text-lg font-semibold"><Cpu className="size-5 text-accent" /> Worker transcodes</h2>
      <div className="space-y-3">
        {data?.transcodes.map((t) => (
          <Card key={t.sessionId} className="flex flex-wrap items-center gap-4">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{t.inputPath.split("/").pop()}</p>
              <p className="text-xs text-muted">
                {t.variants.map((v) => `${v.height}p`).join(" / ")} · {t.hwaccel === "none" ? "software" : t.hwaccel} · {t.speed ? `${t.speed.toFixed(1)}× realtime` : "starting"} · segment {t.segmentsReady}/{t.segmentsTotal}
              </p>
            </div>
            <Badge tone={t.state === "error" ? "red" : t.state === "running" ? "green" : "default"}>{t.state}</Badge>
            <Button size="sm" variant="secondary" onClick={async () => { await api(`/api/admin/streams?session=${encodeURIComponent(t.sessionId)}`, { method: "DELETE" }); reload(); }}><Square className="size-3.5" /> Stop</Button>
          </Card>
        ))}
        {data && !data.transcodes.length && <p className="text-sm text-muted">No server-side transcodes running. Direct play and in-browser Mediabunny sessions use no server CPU.</p>}
      </div>
    </>
  );
}
