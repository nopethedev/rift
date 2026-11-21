/** Error with an HTTP-ish status code, thrown by the torrent manager and search. */
export class TorrentError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "TorrentError";
  }
}
