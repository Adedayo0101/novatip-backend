-- CreateIndex
-- Serves GET /notifications:
--   WHERE "creatorId" = ? ORDER BY "createdAt" DESC, id DESC LIMIT n
-- The creatorId prefix narrows the scan and the remaining columns provide the
-- newest-first order, allowing PostgreSQL to stop after the requested page.
CREATE INDEX "Notification_creatorId_createdAt_id_idx"
ON "Notification"("creatorId", "createdAt", id);

-- DropIndex
-- The composite's leading creatorId column serves the same creator lookup as
-- the old index, without maintaining a redundant second index per notification.
DROP INDEX "Notification_creatorId_idx";
