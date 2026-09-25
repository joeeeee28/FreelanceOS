-- Research history, decision-maker staging, knowledge engine.
--
-- Entirely additive. No existing column is dropped or retyped and no row is
-- deleted. The three columns added to existing tables are all nullable or
-- carry defaults, so every existing row remains valid without backfill.

-- CreateEnum
CREATE TYPE "ResearchStatus" AS ENUM ('NEVER', 'PARTIAL', 'RESEARCHED', 'STALE', 'BLOCKED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "ResearchAspect" AS ENUM ('WEBSITE', 'COMPANY_INFO', 'GEOGRAPHY', 'INDUSTRY', 'MARKETING', 'ADVERTISING', 'CONTENT', 'HIRING', 'TECHNOLOGY', 'DECISION_MAKERS', 'PUBLIC_CONTACTS', 'SERVICE_OPPORTUNITIES');

-- CreateEnum
CREATE TYPE "ContactVerification" AS ENUM ('UNVERIFIED', 'NAME_AND_ROLE', 'CONTACTABLE', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "KnowledgeSourceType" AS ENUM ('ARTICLE', 'BLOG', 'DOCUMENTATION', 'RESEARCH', 'NEWS', 'VIDEO', 'PODCAST', 'REPOSITORY', 'TUTORIAL', 'COMMUNITY', 'INDUSTRY_RESOURCE', 'OTHER');

-- AlterTable: aggregate research state, defaulted so existing rows are valid.
ALTER TABLE "Company" ADD COLUMN "researchStatus" "ResearchStatus" NOT NULL DEFAULT 'NEVER';

-- AlterTable: the concrete next step and when the mapping fired.
ALTER TABLE "Opportunity" ADD COLUMN "recommendedAction" TEXT;
ALTER TABLE "Opportunity" ADD COLUMN "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "ResearchRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "aspect" "ResearchAspect" NOT NULL,
    "status" "ResearchStatus" NOT NULL,
    "factsFound" INTEGER NOT NULL DEFAULT 0,
    "factsChanged" INTEGER NOT NULL DEFAULT 0,
    "sourceUrl" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "freshUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveredContact" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceId" TEXT,
    "fullName" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "jobTitle" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "linkedinUrl" TEXT,
    "isDecisionMaker" BOOLEAN NOT NULL DEFAULT false,
    "verification" "ContactVerification" NOT NULL DEFAULT 'UNVERIFIED',
    "confidence" INTEGER NOT NULL,
    "method" "ExtractionMethod" NOT NULL,
    "sourceUrl" TEXT,
    "evidence" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promotedContactId" TEXT,
    "promotedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveredContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeResource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "sourceName" TEXT,
    "sourceType" "KnowledgeSourceType" NOT NULL DEFAULT 'OTHER',
    "author" TEXT,
    "publishedAt" TIMESTAMP(3),
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary" TEXT,
    "excerpt" TEXT,
    "language" TEXT,
    "entities" JSONB,
    "tags" JSONB,
    "serviceRelevance" JSONB,
    "relevanceScore" INTEGER NOT NULL DEFAULT 0,
    "rationale" JSONB,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeTopic" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeTopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeResourceTopic" (
    "resourceId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeResourceTopic_pkey" PRIMARY KEY ("resourceId","topicId")
);

-- CreateIndex
CREATE INDEX "Company_workspaceId_researchStatus_idx" ON "Company"("workspaceId", "researchStatus");

-- CreateIndex
CREATE INDEX "ResearchRun_workspaceId_idx" ON "ResearchRun"("workspaceId");
CREATE INDEX "ResearchRun_companyId_aspect_startedAt_idx" ON "ResearchRun"("companyId", "aspect", "startedAt");
CREATE INDEX "ResearchRun_workspaceId_status_idx" ON "ResearchRun"("workspaceId", "status");
CREATE INDEX "ResearchRun_companyId_aspect_freshUntil_idx" ON "ResearchRun"("companyId", "aspect", "freshUntil");

-- CreateIndex
CREATE INDEX "DiscoveredContact_workspaceId_idx" ON "DiscoveredContact"("workspaceId");
CREATE INDEX "DiscoveredContact_workspaceId_verification_idx" ON "DiscoveredContact"("workspaceId", "verification");
CREATE INDEX "DiscoveredContact_companyId_isDecisionMaker_idx" ON "DiscoveredContact"("companyId", "isDecisionMaker");
CREATE INDEX "DiscoveredContact_workspaceId_promotedAt_idx" ON "DiscoveredContact"("workspaceId", "promotedAt");
CREATE UNIQUE INDEX "DiscoveredContact_companyId_canonicalName_key" ON "DiscoveredContact"("companyId", "canonicalName");

-- CreateIndex
CREATE INDEX "KnowledgeResource_workspaceId_idx" ON "KnowledgeResource"("workspaceId");
CREATE INDEX "KnowledgeResource_workspaceId_sourceType_idx" ON "KnowledgeResource"("workspaceId", "sourceType");
CREATE INDEX "KnowledgeResource_workspaceId_publishedAt_idx" ON "KnowledgeResource"("workspaceId", "publishedAt");
CREATE INDEX "KnowledgeResource_workspaceId_relevanceScore_idx" ON "KnowledgeResource"("workspaceId", "relevanceScore");
CREATE INDEX "KnowledgeResource_workspaceId_archivedAt_idx" ON "KnowledgeResource"("workspaceId", "archivedAt");
CREATE UNIQUE INDEX "KnowledgeResource_workspaceId_canonicalUrl_key" ON "KnowledgeResource"("workspaceId", "canonicalUrl");

-- CreateIndex
CREATE INDEX "KnowledgeTopic_workspaceId_idx" ON "KnowledgeTopic"("workspaceId");
CREATE UNIQUE INDEX "KnowledgeTopic_workspaceId_slug_key" ON "KnowledgeTopic"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "KnowledgeResourceTopic_topicId_idx" ON "KnowledgeResourceTopic"("topicId");

-- AddForeignKey
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveredContact" ADD CONSTRAINT "DiscoveredContact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoveredContact" ADD CONSTRAINT "DiscoveredContact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoveredContact" ADD CONSTRAINT "DiscoveredContact_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeResource" ADD CONSTRAINT "KnowledgeResource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeTopic" ADD CONSTRAINT "KnowledgeTopic_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeResourceTopic" ADD CONSTRAINT "KnowledgeResourceTopic_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "KnowledgeResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeResourceTopic" ADD CONSTRAINT "KnowledgeResourceTopic_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "KnowledgeTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
