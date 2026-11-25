"use client";
import { SpotifyImporter } from "@/components/music/spotify-import";

export function ImportView({ shared }: { shared: string }) {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold">Import from Spotify</h1>
      <p className="mb-5 mt-1 text-sm text-muted">
        Rift copies the song list (titles, artists, order and covers) and plays each song from your library or an on-demand source. Nothing is downloaded from Spotify.
        On Android you can also share a playlist from the Spotify app straight to Rift.
      </p>
      <SpotifyImporter initialText={shared} autoPreview={!!shared} />
    </div>
  );
}
