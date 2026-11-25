import { beforeEach, describe, expect, it, vi } from "vitest";
import { LavalinkNode, LavalinkPool, RateLimitedError } from "./lavalink";
import { lookups } from "./lookup-cache";

const cfg = (id: string) => ({ id, name: id, url: `http://${id}.test`, password: "pw", searchPrefix: "ytsearch" });
let answers: Response[];
let calls = 0;
beforeEach(() => {
  lookups.clear();
  calls = 0;
  vi.stubGlobal("fetch", async () => { calls++; return answers.shift() ?? new Response("{}", { status: 500 }); });
});
const ok = (data: unknown) => new Response(JSON.stringify({ loadType: "search", data }), { status: 200, headers: { "content-type": "application/json" } });
const t = (title: string) => ({ encoded: `e-${title}`, info: { identifier: title, title, author: "A", length: 1000, isStream: false, sourceName: "youtube" } });

describe("Lavalink node cache + rate limits", () => {
  it("caches searches per node, so a repeat doesn't call the node", async () => {
    const n = new LavalinkNode(cfg("a"));
    answers = [ok([t("x")])];
    expect((await n.search("ytsearch", "song")).map((x) => x.info.title)).toEqual(["x"]);
    expect((await n.search("ytsearch", "song")).map((x) => x.info.title)).toEqual(["x"]);
    expect(calls).toBe(1);
  });

  it("a 429 parks the node (Retry-After), it sorts last, and an older cached answer is still used", async () => {
    const n = new LavalinkNode(cfg("a"));
    answers = [new Response("slow down", { status: 429, headers: { "retry-after": "120" } })];
    await expect(n.search("ytsearch", "other")).rejects.toBeInstanceOf(RateLimitedError);
    expect(n.limited).toBe(true);
    await expect(n.search("ytsearch", "other")).rejects.toThrow(/rate-limiting/);
    expect(calls).toBe(1); // the parked node isn't asked again

    const pool = new LavalinkPool();
    pool.sync([cfg("a"), cfg("b")]);
    pool.get("a")!.limitedUntil = Date.now() + 60_000;
    expect(pool.ordered().map((x) => x.cfg.id)).toEqual(["b", "a"]);
    pool.close();
  });
});
