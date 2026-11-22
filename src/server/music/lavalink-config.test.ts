import { describe, expect, it } from "vitest";
import { renderLavalinkConfig } from "./lavalink-config";

const node = (password: string) => ({ id: "bundled", name: "Bundled", url: "http://lavalink:2333", password, searchPrefix: "scsearch" });

describe("renderLavalinkConfig", () => {
  it("writes the password, sources and no plugin block when none are configured", () => {
    const y = renderLavalinkConfig({ musicLavalinkNodes: [node("s3cret")], musicLavalinkPlugins: [] });
    expect(y).toContain('password: "s3cret"');
    expect(y).toContain("http: true");
    expect(y).not.toContain("plugins:");
  });
  it("lists plugins with optional repositories", () => {
    const y = renderLavalinkConfig({ musicLavalinkNodes: [node("p")], musicLavalinkPlugins: [{ dependency: "dev.lavalink.youtube:youtube-plugin:1.13.3", repository: "" }, { dependency: "com.github.topi314.lavasrc:lavasrc-plugin:4.8.1", repository: "https://maven.lavalink.dev/releases" }] });
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
});
