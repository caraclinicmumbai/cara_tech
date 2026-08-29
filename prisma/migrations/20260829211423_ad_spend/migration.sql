-- CreateTable
CREATE TABLE "AdSpend" (
    "id" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "campaign" TEXT NOT NULL DEFAULT '',
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "branchId" TEXT,
    "importedFrom" TEXT NOT NULL DEFAULT 'csv',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdSpend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdSpend_day_idx" ON "AdSpend"("day");

-- CreateIndex
CREATE INDEX "AdSpend_source_day_idx" ON "AdSpend"("source", "day");

-- CreateIndex
CREATE UNIQUE INDEX "AdSpend_day_source_campaign_key" ON "AdSpend"("day", "source", "campaign");

-- AddForeignKey
ALTER TABLE "AdSpend" ADD CONSTRAINT "AdSpend_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
