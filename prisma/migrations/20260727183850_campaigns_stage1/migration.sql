-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "quietEndHour" INTEGER,
ADD COLUMN     "quietStartHour" INTEGER;

-- CreateTable
CREATE TABLE "CampaignEnrollment" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "campaignType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "step" INTEGER NOT NULL DEFAULT 0,
    "branchId" TEXT,
    "drivingQuoteId" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "messagesSent" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),
    "stopReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignSetting" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "campaignType" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignEnrollment_status_nextRunAt_idx" ON "CampaignEnrollment"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "CampaignEnrollment_leadId_idx" ON "CampaignEnrollment"("leadId");

-- CreateIndex
CREATE INDEX "CampaignEnrollment_campaignType_idx" ON "CampaignEnrollment"("campaignType");

-- CreateIndex
CREATE INDEX "CampaignSetting_branchId_idx" ON "CampaignSetting"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignSetting_branchId_campaignType_key" ON "CampaignSetting"("branchId", "campaignType");

-- CreateIndex (partial unique): a lead may hold AT MOST ONE active enrollment at a
-- time — the core "one campaign per person, never per quote" guardrail (§follow-up),
-- enforced by the database itself. Prisma can't express a partial unique index
-- declaratively, so it's added here by hand; enrollLead() catches the P2002 it raises.
CREATE UNIQUE INDEX "CampaignEnrollment_one_active_per_lead" ON "CampaignEnrollment"("leadId") WHERE "status" = 'active';

-- AddForeignKey
ALTER TABLE "CampaignEnrollment" ADD CONSTRAINT "CampaignEnrollment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSetting" ADD CONSTRAINT "CampaignSetting_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
