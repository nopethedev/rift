// Minimal fake TMDB API for integration tests (set TMDB_BASE_URL to the returned url, TMDB_API_KEY=test).
import http from "node:http";
import type { AddressInfo } from "node:net";

const movies = [
  { id: 101, title: "Night of the Living Dead", original_title: "Night of the Living Dead", release_date: "1968-10-01", popularity: 20 },
  { id: 102, title: "Night of the Living Dead", original_title: "Night of the Living Dead", release_date: "1990-10-19", popularity: 10 },
  { id: 103, title: "The Big Lebowski", original_title: "The Big Lebowski", release_date: "1998-03-06", popularity: 30 },
];
const shows = [{ id: 202, name: "Test Show", original_name: "Test Show", first_air_date: "2020-01-01", popularity: 5 }];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function startFakeTmdb(): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    requests.push(u.pathname + u.search);
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (u.searchParams.get("api_key") !== "test") return send(401, { status_message: "Invalid API key" });
    const q = norm(u.searchParams.get("query") ?? "");
    let m: RegExpExecArray | null;
    if (u.pathname === "/search/movie") {
      const year = u.searchParams.get("year");
      return send(200, { results: movies.filter((x) => norm(x.title).includes(q) && (!year || x.release_date.startsWith(year))) });
    }
    if (u.pathname === "/search/tv") return send(200, { results: shows.filter((x) => norm(x.name).includes(q)) });
    if ((m = /^\/movie\/(\d+)$/.exec(u.pathname))) {
      const x = movies.find((mv) => mv.id === Number(m![1]));
      return x ? send(200, { ...x, overview: "A movie.", genres: [{ id: 27, name: "Horror" }], runtime: 96, vote_average: 7.5 }) : send(404, {});
    }
    if ((m = /^\/tv\/(\d+)$/.exec(u.pathname))) {
      const x = shows.find((s) => s.id === Number(m![1]));
      return x ? send(200, { ...x, overview: "A show.", genres: [], episode_run_time: [30], number_of_seasons: 2 }) : send(404, {});
    }
    if ((m = /^\/tv\/(\d+)\/season\/(\d+)$/.exec(u.pathname))) {
      const n = Number(m[2]);
      if (Number(m[1]) !== 202 || n > 2) return send(404, {});
      return send(200, {
        name: `Season ${n}`, overview: "", poster_path: null,
        episodes: [1, 2, 3].map((e) => ({ episode_number: e, name: `Episode ${e} name`, overview: "", still_path: null, runtime: 30, air_date: "2020-01-0" + e })),
      });
    }
    send(404, { status_message: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}
