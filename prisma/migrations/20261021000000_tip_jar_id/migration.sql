-- Add jarId column to Tip
ALTER TABLE "Tip" ADD COLUMN "jarId" TEXT;

-- Create index on jarId for lookups when attaching tips to claimed creators
CREATE INDEX "Tip_jarId_idx" ON "Tip"("jarId");
