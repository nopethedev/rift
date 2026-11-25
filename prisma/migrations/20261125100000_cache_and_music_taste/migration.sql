-- CreateTable
CREATE TABLE "CacheEntry" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "storedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "CacheEntry_storedAt_idx" ON "CacheEntry"("storedAt");

ALTER TABLE "Profile" ADD COLUMN "musicTaste" TEXT;
ALTER TABLE "Profile" ADD COLUMN "musicOnboardedAt" DATETIME;
