import "server-only";
import path from "node:path";

const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(/*turbopackIgnore: true*/ process.cwd(), p));

export const env = {
  dataDir: abs(process.env.DATA_DIR || "./data"),
  mediaDir: abs(process.env.MEDIA_DIR || "./media"),
  downloadDir: abs(process.env.DOWNLOAD_DIR || "./downloads"),
  workerUrl: (process.env.WORKER_URL || "http://localhost:4100").replace(/\/$/, ""),
  workerToken: process.env.WORKER_TOKEN || "dev-worker-token",
  tmdbKey: process.env.TMDB_API_KEY || "",
  tmdbBase: (process.env.TMDB_BASE_URL || "https://api.themoviedb.org/3").replace(/\/$/, ""),
  secureCookies: process.env.COOKIE_SECURE === "true",
};

export const paths = {
  subtitles: path.join(env.dataDir, "subtitles"),
  torrents: path.join(env.dataDir, "torrents"),
};
