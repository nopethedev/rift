import path from "node:path";
import type { WorkerConfig } from "../config";
import { MusicCache } from "./cache";
import { ytdlpEngine } from "./engines/ytdlp";
import { lavalinkEngine } from "./engines/lavalink";
import { LavalinkPool } from "./lavalink";
import { loadSinkEnv, startSink } from "./sink-tls";
import type { VoiceSink } from "./voice-sink";
import type { MusicService } from "./routes";

export async function createMusic(cfg: WorkerConfig): Promise<MusicService> {
  const pool = new LavalinkPool();
  let sink: VoiceSink | null = null;
  const env = loadSinkEnv(cfg.transcodeDir);
  if (env.enabled) {
    try {
      sink = await startSink(env);
      console.log(`[music] Lavalink voice sink on ${sink.endpoint} (udp ${env.udpPort}), certificate in ${env.tlsDir}`);
    } catch (e) {
      console.warn("[music] voice sink unavailable (Lavalink engine will not work):", (e as Error).message);
    }
  }
  const engines = { ytdlp: ytdlpEngine, lavalink: lavalinkEngine(pool, () => sink) };
  const cache = new MusicCache({ engines, defaultDir: process.env.MUSIC_CACHE_DIR || path.join(cfg.transcodeDir, "music-cache") });
  return {
    cache,
    pool,
    engines,
    sink: () => sink,
    async stop() {
      await cache.shutdown();
      pool.close();
      await sink?.stop();
    },
  };
}
