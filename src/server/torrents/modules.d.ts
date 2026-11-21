// These packages ship no TypeScript declarations; the code using them declares the structural types it relies on.
declare module "webtorrent";
declare module "torrent-search-api";
declare module "bittorrent-tracker"; // used by scripts/test-torrents.ts (local tracker)
