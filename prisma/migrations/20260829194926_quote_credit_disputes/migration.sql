-- CreateTable
CREATE TABLE "QuoteCreditDispute" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "claimantBranchId" TEXT NOT NULL,
    "creditedBranchId" TEXT NOT NULL,
    "raisedById" TEXT,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "windowEndsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "QuoteCreditDispute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuoteCreditDispute_quoteId_key" ON "QuoteCreditDispute"("quoteId");

-- CreateIndex
CREATE INDEX "QuoteCreditDispute_status_idx" ON "QuoteCreditDispute"("status");

-- CreateIndex
CREATE INDEX "QuoteCreditDispute_claimantBranchId_idx" ON "QuoteCreditDispute"("claimantBranchId");

-- AddForeignKey
ALTER TABLE "QuoteCreditDispute" ADD CONSTRAINT "QuoteCreditDispute_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteCreditDispute" ADD CONSTRAINT "QuoteCreditDispute_claimantBranchId_fkey" FOREIGN KEY ("claimantBranchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteCreditDispute" ADD CONSTRAINT "QuoteCreditDispute_creditedBranchId_fkey" FOREIGN KEY ("creditedBranchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
