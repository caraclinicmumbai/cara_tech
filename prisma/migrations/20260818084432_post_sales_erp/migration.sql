/*
  Warnings:

  - You are about to drop the column `journeyStage` on the `Quote` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "consentClinical" BOOLEAN,
ADD COLUMN     "preferredLanguage" TEXT;

-- AlterTable
ALTER TABLE "Quote" DROP COLUMN "journeyStage";

-- CreateTable
CREATE TABLE "PostSalesJourney" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'converted',
    "stageChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stageDueAt" TIMESTAMP(3),
    "overdueNotifiedAt" TIMESTAMP(3),
    "treatmentType" TEXT NOT NULL DEFAULT 'default',
    "doctorId" TEXT,
    "otLeadId" TEXT,
    "consultantId" TEXT,
    "surgeryAt" TIMESTAMP(3),
    "checkInsScheduledAt" TIMESTAMP(3),
    "branchId" TEXT,
    "handoverSummary" JSONB,
    "handoverGeneratedAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostSalesJourney_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostSalesCheckIn" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "dayOffset" INTEGER NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "originalFor" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sentAt" TIMESTAMP(3),
    "messageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "blockedReason" TEXT,
    "deferredReason" TEXT,
    "deferrals" INTEGER NOT NULL DEFAULT 0,
    "completedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostSalesCheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostSalesNote" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'clinical',
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostSalesNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreatmentStagePolicy" (
    "id" TEXT NOT NULL,
    "treatmentType" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "stageDays" JSONB NOT NULL DEFAULT '{}',
    "checkInDays" INTEGER[] DEFAULT ARRAY[1, 7, 30, 90]::INTEGER[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TreatmentStagePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PostSalesJourney_quoteId_key" ON "PostSalesJourney"("quoteId");

-- CreateIndex
CREATE INDEX "PostSalesJourney_stage_idx" ON "PostSalesJourney"("stage");

-- CreateIndex
CREATE INDEX "PostSalesJourney_stageDueAt_idx" ON "PostSalesJourney"("stageDueAt");

-- CreateIndex
CREATE INDEX "PostSalesJourney_leadId_idx" ON "PostSalesJourney"("leadId");

-- CreateIndex
CREATE INDEX "PostSalesJourney_branchId_idx" ON "PostSalesJourney"("branchId");

-- CreateIndex
CREATE INDEX "PostSalesJourney_consultantId_idx" ON "PostSalesJourney"("consultantId");

-- CreateIndex
CREATE INDEX "PostSalesJourney_doctorId_idx" ON "PostSalesJourney"("doctorId");

-- CreateIndex
CREATE INDEX "PostSalesJourney_otLeadId_idx" ON "PostSalesJourney"("otLeadId");

-- CreateIndex
CREATE INDEX "PostSalesCheckIn_status_scheduledFor_idx" ON "PostSalesCheckIn"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "PostSalesCheckIn_leadId_scheduledFor_idx" ON "PostSalesCheckIn"("leadId", "scheduledFor");

-- CreateIndex
CREATE INDEX "PostSalesCheckIn_journeyId_idx" ON "PostSalesCheckIn"("journeyId");

-- CreateIndex
CREATE UNIQUE INDEX "PostSalesCheckIn_journeyId_dayOffset_key" ON "PostSalesCheckIn"("journeyId", "dayOffset");

-- CreateIndex
CREATE INDEX "PostSalesNote_journeyId_createdAt_idx" ON "PostSalesNote"("journeyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TreatmentStagePolicy_treatmentType_key" ON "TreatmentStagePolicy"("treatmentType");

-- CreateIndex
CREATE INDEX "TreatmentStagePolicy_active_idx" ON "TreatmentStagePolicy"("active");

-- AddForeignKey
ALTER TABLE "PostSalesJourney" ADD CONSTRAINT "PostSalesJourney_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostSalesJourney" ADD CONSTRAINT "PostSalesJourney_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostSalesJourney" ADD CONSTRAINT "PostSalesJourney_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostSalesJourney" ADD CONSTRAINT "PostSalesJourney_otLeadId_fkey" FOREIGN KEY ("otLeadId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostSalesJourney" ADD CONSTRAINT "PostSalesJourney_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostSalesJourney" ADD CONSTRAINT "PostSalesJourney_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostSalesCheckIn" ADD CONSTRAINT "PostSalesCheckIn_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "PostSalesJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostSalesCheckIn" ADD CONSTRAINT "PostSalesCheckIn_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostSalesNote" ADD CONSTRAINT "PostSalesNote_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "PostSalesJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE;
