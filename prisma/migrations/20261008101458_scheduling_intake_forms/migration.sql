-- AlterTable
ALTER TABLE "AppointmentType" ADD COLUMN     "intakeFormId" TEXT;

-- CreateTable
CREATE TABLE "IntakeForm" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "currentVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeFormVersion" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "schema" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntakeFormVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeResponse" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "formId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "answers" JSONB NOT NULL,
    "redFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "verifiedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "verifiedPhone" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntakeResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakePhoto" (
    "id" TEXT NOT NULL,
    "responseId" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntakePhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntakeForm_key_key" ON "IntakeForm"("key");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeFormVersion_formId_version_key" ON "IntakeFormVersion"("formId", "version");

-- CreateIndex
CREATE INDEX "IntakeResponse_leadId_idx" ON "IntakeResponse"("leadId");

-- CreateIndex
CREATE INDEX "IntakeResponse_appointmentId_idx" ON "IntakeResponse"("appointmentId");

-- CreateIndex
CREATE INDEX "IntakePhoto_responseId_idx" ON "IntakePhoto"("responseId");

-- AddForeignKey
ALTER TABLE "AppointmentType" ADD CONSTRAINT "AppointmentType_intakeFormId_fkey" FOREIGN KEY ("intakeFormId") REFERENCES "IntakeForm"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeFormVersion" ADD CONSTRAINT "IntakeFormVersion_formId_fkey" FOREIGN KEY ("formId") REFERENCES "IntakeForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeResponse" ADD CONSTRAINT "IntakeResponse_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeResponse" ADD CONSTRAINT "IntakeResponse_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeResponse" ADD CONSTRAINT "IntakeResponse_formId_fkey" FOREIGN KEY ("formId") REFERENCES "IntakeForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeResponse" ADD CONSTRAINT "IntakeResponse_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "IntakeFormVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakePhoto" ADD CONSTRAINT "IntakePhoto_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "IntakeResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- §2.7: the confirmation and day-before reminder carry the intake-form link. The
-- {intake_link} line disappears when there's no form or it's already done (the filler
-- drops a line whose only placeholder is empty). Only messages still exactly as seeded
-- are updated — anything the clinic edited is left alone.
UPDATE "AppointmentMessageTemplate"
SET "body" = E'Hi {patient_name}, your {service} at {branch} is booked for {date} at {time} with {doctor}.\n\nPlease complete your health form before your visit: {intake_link}\n\nTo confirm, reschedule or cancel: {link}',
    "updatedAt" = NOW()
WHERE "key" = 'confirmation'
  AND "body" = E'Hi {patient_name}, your {service} at {branch} is booked for {date} at {time} with {doctor}.\n\nTo confirm, reschedule or cancel: {link}';

UPDATE "AppointmentMessageTemplate"
SET "body" = E'Reminder: your {service} is tomorrow, {date} at {time}, at {branch}. Directions: {map_link}\n\nPlease complete your health form if you haven\'t yet: {intake_link}\n\nReply 1 to confirm, 2 to reschedule — or use {link}',
    "updatedAt" = NOW()
WHERE "key" = 'reminder_24h'
  AND "body" = E'Reminder: your {service} is tomorrow, {date} at {time}, at {branch}. Directions: {map_link}\n\nReply 1 to confirm, 2 to reschedule — or use {link}';
