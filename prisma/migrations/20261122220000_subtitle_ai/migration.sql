-- AlterTable
ALTER TABLE "Subtitle" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE "Subtitle" ADD COLUMN "progress" REAL;
ALTER TABLE "Subtitle" ADD COLUMN "jobId" TEXT;
ALTER TABLE "Subtitle" ADD COLUMN "note" TEXT;
