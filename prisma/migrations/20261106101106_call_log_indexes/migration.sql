-- CreateIndex
CREATE INDEX "Call_createdAt_idx" ON "Call"("createdAt");

-- CreateIndex
CREATE INDEX "Call_handledById_createdAt_idx" ON "Call"("handledById", "createdAt");

-- CreateIndex
CREATE INDEX "LeadAccessGrant_granteeId_leadId_idx" ON "LeadAccessGrant"("granteeId", "leadId");
