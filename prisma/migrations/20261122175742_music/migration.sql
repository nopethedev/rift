-- CreateTable
CREATE TABLE "MusicTrack" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "path" TEXT NOT NULL,
    "size" BIGINT NOT NULL DEFAULT 0,
    "mtimeMs" BIGINT NOT NULL DEFAULT 0,
    "container" TEXT,
    "codec" TEXT,
    "bitrate" INTEGER,
    "sampleRate" INTEGER,
    "channels" INTEGER,
    "durationSec" REAL NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL DEFAULT 'Unknown artist',
    "albumArtist" TEXT,
    "album" TEXT,
    "albumKey" TEXT NOT NULL,
    "genre" TEXT,
    "year" INTEGER,
    "trackNo" INTEGER,
    "discNo" INTEGER,
    "coverHash" TEXT,
    "source" TEXT NOT NULL DEFAULT 'import',
    "status" TEXT NOT NULL DEFAULT 'ready',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MusicPlaylist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceUrl" TEXT,
    "sourceId" TEXT,
    "artworkUrl" TEXT,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MusicPlaylist_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MusicPlaylistItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playlistId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "trackId" TEXT,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "album" TEXT,
    "durationSec" REAL,
    "artworkUrl" TEXT,
    "externalId" TEXT,
    "isrc" TEXT,
    CONSTRAINT "MusicPlaylistItem_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "MusicPlaylist" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MusicPlaylistItem_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "MusicTrack" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MusicQueueItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "trackId" TEXT,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "album" TEXT,
    "durationSec" REAL,
    "artworkUrl" TEXT,
    "candidate" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    CONSTRAINT "MusicQueueItem_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MusicQueueState" (
    "profileId" TEXT NOT NULL PRIMARY KEY,
    "currentItemId" TEXT,
    "shuffle" BOOLEAN NOT NULL DEFAULT false,
    "repeat" TEXT NOT NULL DEFAULT 'off',
    "autoplay" BOOLEAN NOT NULL DEFAULT true,
    "positionSec" REAL NOT NULL DEFAULT 0,
    "shuffleOrder" TEXT,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MusicQueueState_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MusicPlay" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "trackId" TEXT,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "album" TEXT,
    "genre" TEXT,
    "durationSec" REAL,
    "playedSec" REAL NOT NULL DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'local',
    "playedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MusicPlay_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "MusicTrack_path_key" ON "MusicTrack"("path");

-- CreateIndex
CREATE INDEX "MusicTrack_artist_idx" ON "MusicTrack"("artist");

-- CreateIndex
CREATE INDEX "MusicTrack_albumKey_idx" ON "MusicTrack"("albumKey");

-- CreateIndex
CREATE INDEX "MusicTrack_genre_idx" ON "MusicTrack"("genre");

-- CreateIndex
CREATE INDEX "MusicTrack_status_createdAt_idx" ON "MusicTrack"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MusicPlaylist_profileId_updatedAt_idx" ON "MusicPlaylist"("profileId", "updatedAt");

-- CreateIndex
CREATE INDEX "MusicPlaylistItem_playlistId_position_idx" ON "MusicPlaylistItem"("playlistId", "position");

-- CreateIndex
CREATE INDEX "MusicQueueItem_profileId_position_idx" ON "MusicQueueItem"("profileId", "position");

-- CreateIndex
CREATE INDEX "MusicPlay_profileId_playedAt_idx" ON "MusicPlay"("profileId", "playedAt");
