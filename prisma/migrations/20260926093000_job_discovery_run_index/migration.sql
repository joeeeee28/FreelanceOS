-- Run-scoped job queries.
--
-- Purely additive: one index on an existing column, no data change, no rewrite
-- of the table beyond building the index. It backs the two read paths the
-- automation views use — every job belonging to one run, and the per-run job
-- counts behind the run list — both of which filter or group on
-- `discoveryRunId`. PostgreSQL does not index a foreign-key column by itself,
-- so without this those queries scan the whole job table, which grows with
-- every cycle.

-- CreateIndex
CREATE INDEX "Job_discoveryRunId_idx" ON "Job"("discoveryRunId");
