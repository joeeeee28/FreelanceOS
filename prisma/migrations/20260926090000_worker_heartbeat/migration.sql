-- Worker liveness.
--
-- Purely additive: one new table, no existing table or column is touched, so
-- this migration is safe to apply to a live database and needs no backfill.
--
-- A row is written by each running worker process and refreshed on its own
-- timer. Nothing in the application depends on the row existing: a workspace
-- with no worker simply has no row, which is reported as "no worker has
-- reported in" rather than as zero activity.

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "workerId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("workerId")
);

-- CreateIndex
CREATE INDEX "WorkerHeartbeat_lastSeenAt_idx" ON "WorkerHeartbeat"("lastSeenAt");
