-- AlterTable
ALTER TABLE "BookingPayment" ADD COLUMN     "confirmedVia" TEXT;

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "catalogItemId" TEXT;

-- CreateTable
CREATE TABLE "PatientCredit" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "paymentId" TEXT,
    "appointmentId" TEXT,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "appliedToId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "appliedById" TEXT,
    "refundedAt" TIMESTAMP(3),
    "refundedById" TEXT,
    "refundReason" TEXT,
    "refundRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueEvent" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'session_completed',
    "appointmentId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "quoteId" TEXT,
    "planId" TEXT,
    "sessionNo" INTEGER,
    "sessions" INTEGER,
    "amount" INTEGER,
    "branchId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "exportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevenueEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PatientCredit_paymentId_key" ON "PatientCredit"("paymentId");

-- CreateIndex
CREATE INDEX "PatientCredit_leadId_status_idx" ON "PatientCredit"("leadId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RevenueEvent_appointmentId_key" ON "RevenueEvent"("appointmentId");

-- CreateIndex
CREATE INDEX "RevenueEvent_exportedAt_occurredAt_idx" ON "RevenueEvent"("exportedAt", "occurredAt");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "CatalogItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientCredit" ADD CONSTRAINT "PatientCredit_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientCredit" ADD CONSTRAINT "PatientCredit_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "BookingPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
