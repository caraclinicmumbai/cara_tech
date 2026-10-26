-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "href" TEXT;

-- AlterTable
ALTER TABLE "Resource" ADD COLUMN     "availableFrom" DATE,
ADD COLUMN     "availableUntil" DATE;

-- AlterTable
ALTER TABLE "ResourceTimeOff" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decidedById" TEXT,
ADD COLUMN     "decisionNote" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'leave',
ADD COLUMN     "requestedById" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'approved';

-- CreateTable
CREATE TABLE "RebookingCase" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "timeOffId" TEXT,
    "branchId" TEXT NOT NULL,
    "ownerId" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'open',
    "newAppointmentId" TEXT,
    "resolutionNote" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "patientNotifiedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RebookingCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RebookingCase_status_dueAt_idx" ON "RebookingCase"("status", "dueAt");

-- CreateIndex
CREATE INDEX "RebookingCase_branchId_status_idx" ON "RebookingCase"("branchId", "status");

-- CreateIndex
CREATE INDEX "RebookingCase_appointmentId_idx" ON "RebookingCase"("appointmentId");

-- CreateIndex
CREATE INDEX "ResourceTimeOff_status_idx" ON "ResourceTimeOff"("status");

-- AddForeignKey
ALTER TABLE "RebookingCase" ADD CONSTRAINT "RebookingCase_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RebookingCase" ADD CONSTRAINT "RebookingCase_timeOffId_fkey" FOREIGN KEY ("timeOffId") REFERENCES "ResourceTimeOff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
