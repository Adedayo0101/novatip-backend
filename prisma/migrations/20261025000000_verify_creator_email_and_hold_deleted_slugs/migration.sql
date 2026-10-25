ALTER TABLE "Creator" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

ALTER TABLE "ReleasedSlug" DROP CONSTRAINT "ReleasedSlug_previousOwnerId_fkey";
ALTER TABLE "ReleasedSlug" ALTER COLUMN "previousOwnerId" DROP NOT NULL;
ALTER TABLE "ReleasedSlug"
  ADD CONSTRAINT "ReleasedSlug_previousOwnerId_fkey"
  FOREIGN KEY ("previousOwnerId") REFERENCES "Creator"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
