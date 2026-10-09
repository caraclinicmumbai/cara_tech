-- CreateTable
CREATE TABLE "SeriesTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "anchorTypeId" TEXT,
    "packageName" TEXT,
    "autoStart" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeriesTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeriesStep" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "offsetValue" INTEGER NOT NULL,
    "offsetUnit" TEXT NOT NULL DEFAULT 'months',
    "toleranceDays" INTEGER NOT NULL DEFAULT 7,
    "sameDoctor" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "SeriesStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreatmentPlan" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "templateId" TEXT,
    "name" TEXT NOT NULL,
    "anchorAt" TIMESTAMP(3) NOT NULL,
    "anchorAppointmentId" TEXT,
    "branchId" TEXT NOT NULL,
    "doctorId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewNote" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TreatmentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlannedStep" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "offsetValue" INTEGER NOT NULL,
    "offsetUnit" TEXT NOT NULL DEFAULT 'months',
    "toleranceDays" INTEGER NOT NULL DEFAULT 7,
    "sameDoctor" BOOLEAN NOT NULL DEFAULT true,
    "targetAt" TIMESTAMP(3) NOT NULL,
    "dueFrom" TIMESTAMP(3) NOT NULL,
    "dueTo" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "appointmentId" TEXT,
    "recallStage" INTEGER NOT NULL DEFAULT 0,
    "lastRecallAt" TIMESTAMP(3),
    "callRequired" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlannedStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeriesStep_templateId_idx" ON "SeriesStep"("templateId");

-- CreateIndex
CREATE INDEX "TreatmentPlan_leadId_idx" ON "TreatmentPlan"("leadId");

-- CreateIndex
CREATE INDEX "TreatmentPlan_anchorAppointmentId_idx" ON "TreatmentPlan"("anchorAppointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PlannedStep_appointmentId_key" ON "PlannedStep"("appointmentId");

-- CreateIndex
CREATE INDEX "PlannedStep_planId_idx" ON "PlannedStep"("planId");

-- CreateIndex
CREATE INDEX "PlannedStep_status_dueFrom_idx" ON "PlannedStep"("status", "dueFrom");

-- AddForeignKey
ALTER TABLE "SeriesStep" ADD CONSTRAINT "SeriesStep_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "SeriesTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentPlan" ADD CONSTRAINT "TreatmentPlan_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentPlan" ADD CONSTRAINT "TreatmentPlan_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "SeriesTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentPlan" ADD CONSTRAINT "TreatmentPlan_anchorAppointmentId_fkey" FOREIGN KEY ("anchorAppointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedStep" ADD CONSTRAINT "PlannedStep_planId_fkey" FOREIGN KEY ("planId") REFERENCES "TreatmentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedStep" ADD CONSTRAINT "PlannedStep_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- §2.8.d: the recall message, worded from the spec's example. Editable in setup.
INSERT INTO "AppointmentMessageTemplate" ("id", "key", "name", "body", "whatsappParams", "updatedAt") VALUES
('tpl_recall_due', 'recall_due', 'Recall — a session is due',
 E'Hi {patient_name}, your {step} is due between {due_from} and {due_to}. Tap to choose a time: {recall_link}',
 ARRAY['patient_name','step','due_from','due_to','recall_link'], NOW())
ON CONFLICT ("key") DO NOTHING;
