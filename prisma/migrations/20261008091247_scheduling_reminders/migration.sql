-- AlterTable
ALTER TABLE "AppointmentType" ADD COLUMN     "selfServiceCutoffHours" INTEGER NOT NULL DEFAULT 4;

-- CreateTable
CREATE TABLE "AppointmentMessageTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "whatsappTemplateName" TEXT,
    "whatsappLanguage" TEXT NOT NULL DEFAULT 'en',
    "whatsappParams" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "smsDltTemplateId" TEXT,
    "emailSubject" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentMessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderRule" (
    "id" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "minutesBefore" INTEGER,
    "atMin" INTEGER,
    "templateId" TEXT NOT NULL,
    "channels" TEXT[] DEFAULT ARRAY['whatsapp']::TEXT[],
    "smsFallback" BOOLEAN NOT NULL DEFAULT true,
    "quietExempt" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ReminderRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentReminder" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "ruleId" TEXT,
    "templateId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "channels" TEXT[],
    "smsFallback" BOOLEAN NOT NULL DEFAULT true,
    "quietExempt" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sentAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "whatsapp" TEXT,
    "waId" TEXT,
    "sms" TEXT,
    "smsRef" TEXT,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentReminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentMessageTemplate_key_key" ON "AppointmentMessageTemplate"("key");

-- CreateIndex
CREATE INDEX "ReminderRule_typeId_idx" ON "ReminderRule"("typeId");

-- CreateIndex
CREATE INDEX "AppointmentReminder_status_dueAt_idx" ON "AppointmentReminder"("status", "dueAt");

-- CreateIndex
CREATE INDEX "AppointmentReminder_appointmentId_idx" ON "AppointmentReminder"("appointmentId");

-- CreateIndex
CREATE INDEX "AppointmentReminder_waId_idx" ON "AppointmentReminder"("waId");

-- AddForeignKey
ALTER TABLE "ReminderRule" ADD CONSTRAINT "ReminderRule_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "AppointmentType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderRule" ADD CONSTRAINT "ReminderRule_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "AppointmentMessageTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentReminder" ADD CONSTRAINT "AppointmentReminder_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentReminder" ADD CONSTRAINT "AppointmentReminder_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ReminderRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentReminder" ADD CONSTRAINT "AppointmentReminder_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "AppointmentMessageTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed: the default appointment messages, worded from the spec's examples (§2.4). The
-- clinic edits them in Scheduling setup → Messages; WhatsApp template names and DLT
-- ids are filled in once Meta / DLT have approved them.
INSERT INTO "AppointmentMessageTemplate" ("id", "key", "name", "body", "whatsappParams", "updatedAt") VALUES
('tpl_confirmation', 'confirmation', 'Booking confirmation',
 E'Hi {patient_name}, your {service} at {branch} is booked for {date} at {time} with {doctor}.\n\nTo confirm, reschedule or cancel: {link}',
 ARRAY['patient_name','service','branch','date','time','doctor','link'], NOW()),
('tpl_reminder_24h', 'reminder_24h', 'Reminder — day before',
 E'Reminder: your {service} is tomorrow, {date} at {time}, at {branch}. Directions: {map_link}\n\nReply 1 to confirm, 2 to reschedule — or use {link}',
 ARRAY['service','date','time','branch','map_link','link'], NOW()),
('tpl_reminder_2h', 'reminder_2h', 'Reminder — 2 hours before',
 E'See you soon, {patient_name}! Your {service} is today at {time} at {branch}. Directions: {map_link}\nRunning late? Call {branch_phone}.',
 ARRAY['patient_name','service','time','branch','map_link','branch_phone'], NOW()),
('tpl_surgery_7d', 'surgery_7d', 'Surgery — 7 days before (pre-op checklist)',
 E'Hi {patient_name}, your {service} is on {date} at {time}, {branch}, with {doctor}.\n\nYour pre-op checklist:\n{prep}\n\nPlease confirm: {link}',
 ARRAY['patient_name','service','date','time','branch','doctor','prep','link'], NOW()),
('tpl_surgery_3d', 'surgery_3d', 'Surgery — 3 days before',
 E'Your {service} is in 3 days ({date}, {time}). Please avoid alcohol and follow your medication instructions: {prep}\n\nReply 1 to confirm, 2 to reschedule.',
 ARRAY['service','date','time','prep'], NOW()),
('tpl_surgery_1d', 'surgery_1d', 'Surgery — day before',
 E'Tomorrow {time}, {branch}. Have a light breakfast, wear a button-down shirt and bring a companion. Directions: {map_link}',
 ARRAY['time','branch','map_link'], NOW()),
('tpl_surgery_morning', 'surgery_morning', 'Surgery — morning of',
 E'Good morning {patient_name}. See you at {time} at {branch}. Call {branch_phone} if you are running late.',
 ARRAY['patient_name','time','branch','branch_phone'], NOW())
ON CONFLICT ("key") DO NOTHING;
