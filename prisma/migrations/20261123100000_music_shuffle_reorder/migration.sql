-- Shuffle now reorders the queue itself instead of keeping a hidden play order next to it.
-- Existing queues are already stored in their normal order, so shuffle is simply switched off for them.
UPDATE "MusicQueueState" SET "shuffle" = false, "shuffleOrder" = NULL;
-- The column now holds the order to restore when shuffle is switched off.
ALTER TABLE "MusicQueueState" RENAME COLUMN "shuffleOrder" TO "originalOrder";
