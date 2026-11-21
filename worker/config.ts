// Worker configuration from environment variables.
import path from "node:path";

export interface WorkerConfig {
  port: number;
  host: string;
  token: string;
  transcodeDir: string;
  maxSessions: number;
  idleSeconds: number;
  vaapiDevice: string;
}

function intEnv(name: string, def: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be an integer >= ${min} (got "${raw}")`);
  return n;
}

export function loadConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const cfg: WorkerConfig = {
    port: intEnv("WORKER_PORT", 4100, 0),
    host: process.env.WORKER_HOST || "0.0.0.0",
    token: process.env.WORKER_TOKEN ?? "",
    transcodeDir: path.resolve(process.env.TRANSCODE_DIR || "./transcode"),
    maxSessions: intEnv("MAX_SESSIONS", 2, 1),
    idleSeconds: intEnv("SESSION_IDLE_SECONDS", 300, 5),
    vaapiDevice: process.env.VAAPI_DEVICE || "/dev/dri/renderD128",
    ...overrides,
  };
  cfg.transcodeDir = path.resolve(cfg.transcodeDir);
  return cfg;
}
