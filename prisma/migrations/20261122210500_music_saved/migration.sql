-- CreateTable
CREATE TABLE "MusicSaved" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "extKey" TEXT NOT NULL,
    "trackId" TEXT,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "album" TEXT,
    "durationSec" REAL,
    "artworkUrl" TEXT,
    "candidate" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MusicSaved_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "MusicSaved_profileId_extKey_key" ON "MusicSaved"("profileId", "extKey");

-- CreateIndex
CREATE INDEX "MusicSaved_profileId_createdAt_idx" ON "MusicSaved"("profileId", "createdAt");
