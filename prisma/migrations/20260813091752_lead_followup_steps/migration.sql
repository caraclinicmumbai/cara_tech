-- CreateTable
CREATE TABLE "LeadFollowUpStep" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'custom',
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "ownerKind" TEXT NOT NULL DEFAULT 'rep',
    "ownerRepId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'template',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadFollowUpStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadFollowUpStep_leadId_order_idx" ON "LeadFollowUpStep"("leadId", "order");

-- CreateIndex
CREATE INDEX "LeadFollowUpStep_ownerRepId_idx" ON "LeadFollowUpStep"("ownerRepId");

-- AddForeignKey
ALTER TABLE "LeadFollowUpStep" ADD CONSTRAINT "LeadFollowUpStep_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadFollowUpStep" ADD CONSTRAINT "LeadFollowUpStep_ownerRepId_fkey" FOREIGN KEY ("ownerRepId") REFERENCES "SalesRep"("id") ON DELETE SET NULL ON UPDATE CASCADE;
