// Rift transcoding worker entry point: `npx tsx --env-file-if-exists=.env worker/index.ts`
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, type WorkerConfig } from "./config";
import { detectHwAccels, ffmpegVersion, hasToneMapping } from "./hwaccel";
import { createServer } from "./server";
import { SessionManager } from "./sessions";
import { createMusic } from "./music";
import type { MusicService } from "./music/routes";
import { createWhisper } from "./whisper";
import type { WhisperService } from "./whisper/routes";

export interface RunningWorker {
  server: Server;
  sessions: SessionManager;
  music: MusicService;
  whisper: WhisperService;
  port: number;
  hwaccels: string[];
  stop(): Promise<void>;
}

export async function startWorker(cfg: WorkerConfig = loadConfig()): Promise<RunningWorker> {
  if (!cfg.token) throw new Error("WORKER_TOKEN must be set");
  const [version, hwaccels, toneMapping] = await Promise.all([ffmpegVersion(), detectHwAccels(cfg.vaapiDevice), hasToneMapping()]);
  const sessions = new SessionManager(cfg, { hwaccels, toneMapping });
  await sessions.init();
  const music = await createMusic(cfg);
  const whisper = createWhisper(cfg);
  const server = createServer({ cfg, sessions, ffmpegVersion: version, hwaccels, music, whisper });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  console.log(
    `[worker] listening on ${cfg.host}:${port} | ${version} | hw: ${hwaccels.join(", ") || "none"} | tonemap: ${toneMapping} | ` +
      `max ${cfg.maxSessions} sessions, idle ${cfg.idleSeconds}s | dir ${cfg.transcodeDir}`,
  );
  let stopping: Promise<void> | undefined;
  return {
    server,
    sessions,
    music,
    whisper,
    port,
    hwaccels,
    stop() {
      stopping ??= (async () => {
        server.close();
        server.closeAllConnections();
        await sessions.shutdown();
        await music.stop();
        await whisper.stop();
      })();
      return stopping;
    },
  };
}

function isEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  startWorker()
    .then((w) => {
      const shutdown = (sig: string) => {
        console.log(`[worker] ${sig}: stopping ffmpeg processes`);
        const force = setTimeout(() => process.exit(1), 10_000);
        force.unref();
        void w.stop().then(() => process.exit(0));
      };
      process.once("exit", () => w.sessions.killAllSync());
      process.once("SIGINT", () => shutdown("SIGINT"));
      process.once("SIGTERM", () => shutdown("SIGTERM"));
    })
    .catch((err: unknown) => {
      console.error("[worker] failed to start:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
