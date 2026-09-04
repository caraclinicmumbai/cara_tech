-- AlterTable
ALTER TABLE "LeadFollowUpStep" ADD COLUMN     "remindedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "LeadFollowUpStep_status_dueAt_remindedAt_idx" ON "LeadFollowUpStep"("status", "dueAt", "remindedAt");
