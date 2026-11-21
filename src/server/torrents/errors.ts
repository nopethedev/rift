/** Error with an HTTP-ish status code, thrown by the torrent manager and search. */
export class TorrentError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "TorrentError";
  }
}

/**
 * `instanceof` is unreliable here: the streamer singleton is created by the boot hook, whose bundle can carry its own copy of
 * this class, so errors it throws are not `instanceof` the copy used by route handlers. Match by name + status instead.
 */
export const isTorrentError = (e: unknown): e is TorrentError => e instanceof Error && e.name === "TorrentError" && typeof (e as TorrentError).status === "number";
