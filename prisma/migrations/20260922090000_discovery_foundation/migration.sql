-- Discovery & intelligence foundation.
--
-- Additive by construction: no existing column is dropped or retyped, and no
-- row is deleted. The only change to an existing table's data contract is
-- Activity.createdByUserId becoming nullable (a widening, so every existing
-- row stays valid) and Lead gaining a nullable companyId.

-- CreateEnum
CREATE TYPE "ExtractionMethod" AS ENUM ('MANUAL', 'STRUCTURED_DATA', 'HTTP_HEADER', 'SITEMAP', 'FEED', 'META_TAG', 'HTML_SELECTOR', 'TEXT_HEURISTIC', 'INFERRED');

-- CreateEnum
CREATE TYPE "FetchOutcome" AS ENUM ('SUCCESS', 'NOT_FOUND', 'TIMEOUT', 'NETWORK_ERROR', 'PARSE_ERROR', 'BLOCKED', 'RATE_LIMITED', 'SERVER_ERROR');

-- CreateEnum
CREATE TYPE "SourceStatus" AS ENUM ('ACTIVE', 'PAUSED', 'FAILING', 'BLOCKED');

-- CreateEnum
CREATE TYPE "SignalType" AS ENUM ('WEBSITE_MISSING', 'WEBSITE_OUTDATED', 'WEBSITE_QUALITY_ISSUE', 'NEW_WEBSITE', 'MARKETING_ACTIVITY', 'ADVERTISING_ACTIVITY', 'CONTENT_ACTIVITY', 'LOW_CONTENT_ACTIVITY', 'HIRING_SIGNAL', 'MARKETING_JOB', 'SOCIAL_MEDIA_ACTIVITY', 'SOCIAL_MEDIA_ABSENT', 'NEW_LOCATION', 'BUSINESS_EXPANSION', 'NEW_PRODUCT', 'TECHNOLOGY_CHANGE', 'LEADERSHIP_CHANGE', 'DECISION_MAKER_FOUND', 'LANDING_PAGE_OPPORTUNITY', 'CONTENT_OPPORTUNITY', 'SOCIAL_MEDIA_OPPORTUNITY', 'OTHER');

-- CreateEnum
CREATE TYPE "SignalStatus" AS ENUM ('ACTIVE', 'STALE', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('OPEN', 'PURSUED', 'WON', 'LOST', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ResolutionState" AS ENUM ('RESOLVED', 'NEEDS_REVIEW', 'REJECTED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('DISCOVERY_RUN', 'CRAWL_SOURCE', 'RESEARCH_COMPANY', 'EXTRACT_SIGNALS', 'RESOLVE_ENTITY', 'UPDATE_CRM', 'KNOWLEDGE_INGESTION', 'KNOWLEDGE_PROCESSING', 'MARKET_ANALYSIS');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- AlterTable: allow system-generated activity (the discovery engine is not a user).
-- Widening only: every existing row already has an author and keeps it.
ALTER TABLE "Activity" DROP CONSTRAINT "Activity_createdByUserId_fkey";
ALTER TABLE "Activity" ALTER COLUMN "createdByUserId" DROP NOT NULL;

-- AlterTable: link a Lead to its canonical Company. Nullable, so every
-- existing and hand-entered lead remains valid without backfill.
ALTER TABLE "Lead" ADD COLUMN "companyId" TEXT;

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "status" "SourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "requestsPerMinute" INTEGER NOT NULL DEFAULT 20,
    "maxConcurrency" INTEGER NOT NULL DEFAULT 2,
    "freshnessMinutes" INTEGER NOT NULL DEFAULT 1440,
    "lastRunAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "blockedCount" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FetchLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceId" TEXT,
    "url" TEXT NOT NULL,
    "outcome" "FetchOutcome" NOT NULL,
    "statusCode" INTEGER,
    "durationMs" INTEGER,
    "bytes" INTEGER,
    "error" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FetchLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "canonicalDomain" TEXT,
    "website" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "country" TEXT,
    "region" TEXT,
    "city" TEXT,
    "language" TEXT,
    "timezone" TEXT,
    "currency" TEXT,
    "industry" TEXT,
    "companySize" TEXT,
    "description" TEXT,
    "linkedinUrl" TEXT,
    "instagramUrl" TEXT,
    "facebookUrl" TEXT,
    "youtubeUrl" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastResearchAt" TIMESTAMP(3),
    "resolutionState" "ResolutionState" NOT NULL DEFAULT 'RESOLVED',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Observation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceId" TEXT,
    "field" TEXT NOT NULL,
    "value" TEXT,
    "method" "ExtractionMethod" NOT NULL,
    "confidence" INTEGER NOT NULL,
    "sourceUrl" TEXT,
    "evidence" TEXT,
    "locator" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "SignalType" NOT NULL,
    "status" "SignalStatus" NOT NULL DEFAULT 'ACTIVE',
    "confidence" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "evidence" TEXT,
    "sourceUrl" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "serviceKey" TEXT NOT NULL,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'OPEN',
    "score" INTEGER NOT NULL DEFAULT 0,
    "rationale" JSONB,
    "summary" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_OpportunityToSignal" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "DiscoveryRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "trigger" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "pagesAttempted" INTEGER NOT NULL DEFAULT 0,
    "pagesSucceeded" INTEGER NOT NULL DEFAULT 0,
    "pagesFailed" INTEGER NOT NULL DEFAULT 0,
    "pagesBlocked" INTEGER NOT NULL DEFAULT 0,
    "companiesDiscovered" INTEGER NOT NULL DEFAULT 0,
    "companiesMatched" INTEGER NOT NULL DEFAULT 0,
    "duplicatesPrevented" INTEGER NOT NULL DEFAULT 0,
    "signalsDiscovered" INTEGER NOT NULL DEFAULT 0,
    "opportunitiesDiscovered" INTEGER NOT NULL DEFAULT 0,
    "contactsDiscovered" INTEGER NOT NULL DEFAULT 0,
    "leadsCreated" INTEGER NOT NULL DEFAULT 0,
    "leadsUpdated" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "DiscoveryRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "idempotencyKey" TEXT,
    "payload" JSONB,
    "result" JSONB,
    "error" TEXT,
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "discoveryRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Source_workspaceId_idx" ON "Source"("workspaceId");
CREATE INDEX "Source_workspaceId_status_idx" ON "Source"("workspaceId", "status");
CREATE INDEX "Source_workspaceId_enabled_nextRunAt_idx" ON "Source"("workspaceId", "enabled", "nextRunAt");
CREATE UNIQUE INDEX "Source_workspaceId_provider_name_key" ON "Source"("workspaceId", "provider", "name");

-- CreateIndex
CREATE INDEX "FetchLog_workspaceId_fetchedAt_idx" ON "FetchLog"("workspaceId", "fetchedAt");
CREATE INDEX "FetchLog_sourceId_fetchedAt_idx" ON "FetchLog"("sourceId", "fetchedAt");
CREATE INDEX "FetchLog_workspaceId_outcome_idx" ON "FetchLog"("workspaceId", "outcome");

-- CreateIndex
CREATE INDEX "Company_workspaceId_idx" ON "Company"("workspaceId");
CREATE INDEX "Company_workspaceId_canonicalName_idx" ON "Company"("workspaceId", "canonicalName");
CREATE INDEX "Company_workspaceId_archivedAt_idx" ON "Company"("workspaceId", "archivedAt");
CREATE INDEX "Company_workspaceId_lastResearchAt_idx" ON "Company"("workspaceId", "lastResearchAt");
CREATE INDEX "Company_workspaceId_resolutionState_idx" ON "Company"("workspaceId", "resolutionState");
CREATE UNIQUE INDEX "Company_workspaceId_canonicalDomain_key" ON "Company"("workspaceId", "canonicalDomain");

-- CreateIndex
CREATE INDEX "Observation_workspaceId_idx" ON "Observation"("workspaceId");
CREATE INDEX "Observation_companyId_field_observedAt_idx" ON "Observation"("companyId", "field", "observedAt");
CREATE INDEX "Observation_companyId_field_supersededAt_idx" ON "Observation"("companyId", "field", "supersededAt");
CREATE INDEX "Observation_workspaceId_observedAt_idx" ON "Observation"("workspaceId", "observedAt");

-- CreateIndex
CREATE INDEX "Signal_workspaceId_idx" ON "Signal"("workspaceId");
CREATE INDEX "Signal_workspaceId_type_idx" ON "Signal"("workspaceId", "type");
CREATE INDEX "Signal_workspaceId_status_idx" ON "Signal"("workspaceId", "status");
CREATE INDEX "Signal_companyId_status_idx" ON "Signal"("companyId", "status");
CREATE UNIQUE INDEX "Signal_companyId_type_key" ON "Signal"("companyId", "type");

-- CreateIndex
CREATE INDEX "Opportunity_workspaceId_idx" ON "Opportunity"("workspaceId");
CREATE INDEX "Opportunity_workspaceId_status_idx" ON "Opportunity"("workspaceId", "status");
CREATE INDEX "Opportunity_workspaceId_serviceKey_idx" ON "Opportunity"("workspaceId", "serviceKey");
CREATE INDEX "Opportunity_workspaceId_score_idx" ON "Opportunity"("workspaceId", "score");
CREATE UNIQUE INDEX "Opportunity_companyId_serviceKey_key" ON "Opportunity"("companyId", "serviceKey");

-- CreateIndex
CREATE UNIQUE INDEX "_OpportunityToSignal_AB_unique" ON "_OpportunityToSignal"("A", "B");
CREATE INDEX "_OpportunityToSignal_B_index" ON "_OpportunityToSignal"("B");

-- CreateIndex
CREATE INDEX "DiscoveryRun_workspaceId_startedAt_idx" ON "DiscoveryRun"("workspaceId", "startedAt");
CREATE INDEX "DiscoveryRun_workspaceId_status_idx" ON "DiscoveryRun"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Job_status_runAfter_priority_idx" ON "Job"("status", "runAfter", "priority");
CREATE INDEX "Job_workspaceId_status_idx" ON "Job"("workspaceId", "status");
CREATE INDEX "Job_workspaceId_type_status_idx" ON "Job"("workspaceId", "type", "status");
CREATE INDEX "Job_lockedUntil_idx" ON "Job"("lockedUntil");
CREATE UNIQUE INDEX "Job_workspaceId_idempotencyKey_key" ON "Job"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_companyId_idx" ON "Lead"("workspaceId", "companyId");

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FetchLog" ADD CONSTRAINT "FetchLog_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_OpportunityToSignal" ADD CONSTRAINT "_OpportunityToSignal_A_fkey" FOREIGN KEY ("A") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_OpportunityToSignal" ADD CONSTRAINT "_OpportunityToSignal_B_fkey" FOREIGN KEY ("B") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_discoveryRunId_fkey" FOREIGN KEY ("discoveryRunId") REFERENCES "DiscoveryRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
