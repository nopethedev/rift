import { describe, expect, it } from "vitest";
import { renderLavalinkConfig } from "./lavalink-config";

const off = { musicLavalinkYoutube: { enabled: false, oauth: false, refreshToken: "", poToken: "", visitorData: "", cipherUrl: "", cipherPassword: "" }, musicLavalinkLyricsPlugins: false };
const node = (password: string) => ({ id: "bundled", name: "Bundled", url: "http://lavalink:2333", password, searchPrefix: "scsearch" });

describe("renderLavalinkConfig", () => {
  it("writes the password, sources and no plugin block when none are configured", () => {
    const y = renderLavalinkConfig({ musicLavalinkNodes: [node("s3cret")], musicLavalinkPlugins: [], ...off });
    expect(y).toContain('password: "s3cret"');
    expect(y).toContain("http: true");
    expect(y).not.toContain("plugins:");
  });
  it("lists plugins with optional repositories", () => {
    const y = renderLavalinkConfig({ musicLavalinkNodes: [node("p")], musicLavalinkPlugins: [{ dependency: "dev.lavalink.youtube:youtube-plugin:1.13.3", repository: "" }, { dependency: "com.github.topi314.lavasrc:lavasrc-plugin:4.8.1", repository: "https://maven.lavalink.dev/releases" }], ...off });
    expect(y).toContain('- dependency: "dev.lavalink.youtube:youtube-plugin:1.13.3"');
    expect(y).toContain('repository: "https://maven.lavalink.dev/releases"');
    expect(y.match(/repository:/g)).toHaveLength(1);
  });
  it("escapes quotes in passwords so the YAML stays valid", () => {
    const y = renderLavalinkConfig({ musicLavalinkNodes: [node('a"b\\c')], musicLavalinkPlugins: [] });
    expect(y).toContain('password: "a\\"b\\\\c"');
  });
  it("omits the password line when there is no bundled node (env default applies)", () => {
    expect(renderLavalinkConfig({ musicLavalinkNodes: [], musicLavalinkPlugins: [] })).not.toContain("password:");
  });

  it("YouTube by default: the youtube-source plugin, built-in source off, remote cipher, no sign-in", () => {
    const y = renderLavalinkConfig({ musicLavalinkNodes: [node("p")], musicLavalinkPlugins: [] });
    expect(y).toContain('- dependency: "dev.lavalink.youtube:youtube-plugin:');
    expect(y).toMatch(/sources:\n {6}youtube: false/);
    expect(y).toMatch(/^plugins:\n {2}youtube:\n {4}enabled: true/m);
    expect(y).toContain("      - ANDROID_VR");
    expect(y).not.toContain("      - TV\n");
    expect(y).toContain('url: "https://cipher.kikkia.dev/"');
    expect(y).not.toContain("oauth:");
  });
  it("YouTube sign-in: oauth block, refresh token, TV client, logger for the device code; poToken needs both parts", () => {
    const y = renderLavalinkConfig({ musicLavalinkNodes: [node("p")], musicLavalinkPlugins: [], musicLavalinkLyricsPlugins: false, musicLavalinkYoutube: { enabled: true, oauth: true, refreshToken: "1//tok", poToken: "pot", visitorData: "", cipherUrl: "", cipherPassword: "" } });
    expect(y).toMatch(/oauth:\n {6}enabled: true\n {6}refreshToken: "1\/\/tok"/);
    expect(y).toContain("      - TV\n");
    expect(y).toContain("YoutubeOauth2Handler: INFO");
    expect(y).not.toContain("pot:");
    expect(y).not.toContain("remoteCipher");
  });
  it("lyrics: LavaLyrics + LavaSrc with only keyless lyrics sources; the admin's pinned version wins", () => {
    const y = renderLavalinkConfig({ musicLavalinkNodes: [node("p")], musicLavalinkPlugins: [{ dependency: "com.github.topi314.lavasrc:lavasrc-plugin:4.0.0", repository: "" }], musicLavalinkYoutube: { ...off.musicLavalinkYoutube }, musicLavalinkLyricsPlugins: true });
    expect(y).toContain("lavalyrics-plugin:");
    expect(y.match(/lavasrc-plugin/g)).toHaveLength(1);
    expect(y).toContain("lavasrc-plugin:4.0.0");
    expect(y).toMatch(/lyrics-sources:[\s\S]*youtube: true[\s\S]*lrcLib: true/);
    expect(y).toMatch(/lavalyrics:\n {4}sources:\n {6}- lrclib/);
    expect(y).not.toMatch(/spotify: true|deezer: true/);
  });
});
