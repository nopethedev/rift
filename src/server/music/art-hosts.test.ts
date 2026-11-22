import { afterEach, describe, expect, it } from "vitest";
import { artUrlAllowed } from "./art-hosts";

afterEach(() => { delete process.env.MUSIC_ART_HOSTS; });

describe("artUrlAllowed", () => {
  it.each([
    "https://e-cdns-images.dzcdn.net/images/cover/abc/1000x1000-000000-80-0-0.jpg",
    "https://cdn-images.dzcdn.net/images/artist/x/500x500.jpg",
    "https://is1-ssl.mzstatic.com/image/thumb/Music/600x600bb.jpg",
    "https://i.scdn.co/image/ab67616d0000b273",
    "https://upload.wikimedia.org/wikipedia/commons/a/ab/x.jpg",
  ])("allows %s", (u) => expect(artUrlAllowed(u)).not.toBeNull());

  it.each([
    "http://e-cdns-images.dzcdn.net/x.jpg", // plain http
    "https://example.com/x.jpg",
    "https://dzcdn.net.evil.com/x.jpg", // suffix trick
    "https://evildzcdn.net/x.jpg",
    "https://user:pw@cdn-images.dzcdn.net/x.jpg",
    "http://127.0.0.1:4100/health",
    "http://localhost:3100/api/music/home",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
    "",
  ])("refuses %s", (u) => expect(artUrlAllowed(u)).toBeNull());

  it("only allows extra hosts that were configured, with their port", () => {
    expect(artUrlAllowed("http://localhost:8098/img/a.jpg")).toBeNull();
    process.env.MUSIC_ART_HOSTS = "localhost:8098, art.example.org";
    expect(artUrlAllowed("http://localhost:8098/img/a.jpg")).not.toBeNull();
    expect(artUrlAllowed("http://localhost:9999/img/a.jpg")).toBeNull();
    expect(artUrlAllowed("https://art.example.org/a.jpg")).not.toBeNull();
    expect(artUrlAllowed("ftp://art.example.org/a.jpg")).toBeNull();
  });
});
