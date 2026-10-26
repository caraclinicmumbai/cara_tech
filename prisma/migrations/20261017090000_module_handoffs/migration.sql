-- AlterTable
ALTER TABLE "Resource" ADD COLUMN     "externalRef" TEXT;

-- AlterTable
ALTER TABLE "ResourceTimeOff" ADD COLUMN     "externalId" TEXT;

-- CreateTable
CREATE TABLE "Encounter" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "doctorId" TEXT,
    "intakeResponseId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Encounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentTypeConsumable" (
    "id" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AppointmentTypeConsumable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsumableReservation" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsumableReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Encounter_appointmentId_key" ON "Encounter"("appointmentId");

-- CreateIndex
CREATE INDEX "Encounter_leadId_openedAt_idx" ON "Encounter"("leadId", "openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentTypeConsumable_typeId_sku_key" ON "AppointmentTypeConsumable"("typeId", "sku");

-- CreateIndex
CREATE INDEX "ConsumableReservation_status_createdAt_idx" ON "ConsumableReservation"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConsumableReservation_appointmentId_sku_key" ON "ConsumableReservation"("appointmentId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "Resource_externalRef_key" ON "Resource"("externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceTimeOff_externalId_key" ON "ResourceTimeOff"("externalId");

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentTypeConsumable" ADD CONSTRAINT "AppointmentTypeConsumable_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "AppointmentType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumableReservation" ADD CONSTRAINT "ConsumableReservation_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

