import type { MetadataRoute } from "next";

// Installable on phones (Add to Home Screen): opens full screen with the Rift icon. Shortcuts jump straight into an app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Rift",
    short_name: "Rift",
    description: "Your media. Your server. Your rules.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0B0B12",
    theme_color: "#0B0B12",
    categories: ["entertainment", "music", "video"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // Android: Spotify → Share → Rift opens the importer with the link.
    share_target: { action: "/music/import", method: "GET", params: { title: "title", text: "text", url: "url" } },
    shortcuts: [
      { name: "Stream", short_name: "Stream", url: "/", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Music", short_name: "Music", url: "/music", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
