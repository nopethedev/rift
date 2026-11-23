ALTER TABLE "Profile" ADD COLUMN "presenceToken" TEXT;
ALTER TABLE "Profile" ADD COLUMN "presenceMusic" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Profile" ADD COLUMN "presenceStream" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "Profile_presenceToken_key" ON "Profile"("presenceToken");
