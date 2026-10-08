-- CreateTable
CREATE TABLE "BranchHours" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "openMin" INTEGER NOT NULL,
    "closeMin" INTEGER NOT NULL,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BranchHours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchClosure" (
    "id" TEXT NOT NULL,
    "branchId" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "startMin" INTEGER,
    "endMin" INTEGER,
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BranchClosure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subtype" TEXT,
    "name" TEXT NOT NULL,
    "branchId" TEXT,
    "userId" TEXT,
    "color" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceSchedule" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMin" INTEGER NOT NULL,
    "endMin" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceTimeOff" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceTimeOff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "category" TEXT,
    "durationMin" INTEGER NOT NULL,
    "bufferAfterMin" INTEGER NOT NULL DEFAULT 0,
    "catalogItemId" TEXT,
    "onlineBookable" BOOLEAN NOT NULL DEFAULT false,
    "prepInstructions" TEXT,
    "color" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentTypeRequirement" (
    "id" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subtype" TEXT,
    "resourceId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AppointmentTypeRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'booked',
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'front_desk',
    "notes" TEXT,
    "bookedById" TEXT,
    "holdExpiresAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "checkedInAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "noShowAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelledBy" TEXT,
    "doctorOverbooked" BOOLEAN NOT NULL DEFAULT false,
    "rescheduledFromId" TEXT,
    "quoteId" TEXT,
    "journeyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentResource" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "blocking" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AppointmentResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlagDefinition" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT NOT NULL DEFAULT 'star',
    "tone" TEXT NOT NULL DEFAULT 'citric',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlagDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadFlag" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "flagId" TEXT NOT NULL,
    "note" TEXT,
    "setById" TEXT,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BranchHours_branchId_weekday_key" ON "BranchHours"("branchId", "weekday");

-- CreateIndex
CREATE INDEX "BranchClosure_startDate_endDate_idx" ON "BranchClosure"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "BranchClosure_branchId_idx" ON "BranchClosure"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "Resource_userId_key" ON "Resource"("userId");

-- CreateIndex
CREATE INDEX "Resource_kind_active_idx" ON "Resource"("kind", "active");

-- CreateIndex
CREATE INDEX "Resource_branchId_idx" ON "Resource"("branchId");

-- CreateIndex
CREATE INDEX "ResourceSchedule_resourceId_weekday_idx" ON "ResourceSchedule"("resourceId", "weekday");

-- CreateIndex
CREATE INDEX "ResourceSchedule_branchId_weekday_idx" ON "ResourceSchedule"("branchId", "weekday");

-- CreateIndex
CREATE INDEX "ResourceTimeOff_resourceId_startAt_idx" ON "ResourceTimeOff"("resourceId", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentType_name_key" ON "AppointmentType"("name");

-- CreateIndex
CREATE INDEX "AppointmentType_active_idx" ON "AppointmentType"("active");

-- CreateIndex
CREATE INDEX "AppointmentTypeRequirement_typeId_idx" ON "AppointmentTypeRequirement"("typeId");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_rescheduledFromId_key" ON "Appointment"("rescheduledFromId");

-- CreateIndex
CREATE INDEX "Appointment_branchId_startAt_idx" ON "Appointment"("branchId", "startAt");

-- CreateIndex
CREATE INDEX "Appointment_leadId_idx" ON "Appointment"("leadId");

-- CreateIndex
CREATE INDEX "Appointment_status_idx" ON "Appointment"("status");

-- CreateIndex
CREATE INDEX "Appointment_startAt_idx" ON "Appointment"("startAt");

-- CreateIndex
CREATE INDEX "Appointment_holdExpiresAt_idx" ON "Appointment"("holdExpiresAt");

-- CreateIndex
CREATE INDEX "AppointmentResource_resourceId_startAt_idx" ON "AppointmentResource"("resourceId", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentResource_appointmentId_resourceId_key" ON "AppointmentResource"("appointmentId", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "FlagDefinition_key_key" ON "FlagDefinition"("key");

-- CreateIndex
CREATE INDEX "LeadFlag_flagId_idx" ON "LeadFlag"("flagId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadFlag_leadId_flagId_key" ON "LeadFlag"("leadId", "flagId");

-- AddForeignKey
ALTER TABLE "BranchHours" ADD CONSTRAINT "BranchHours_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchClosure" ADD CONSTRAINT "BranchClosure_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceSchedule" ADD CONSTRAINT "ResourceSchedule_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceSchedule" ADD CONSTRAINT "ResourceSchedule_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceTimeOff" ADD CONSTRAINT "ResourceTimeOff_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentType" ADD CONSTRAINT "AppointmentType_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "CatalogItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentTypeRequirement" ADD CONSTRAINT "AppointmentTypeRequirement_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "AppointmentType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentTypeRequirement" ADD CONSTRAINT "AppointmentTypeRequirement_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "AppointmentType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_bookedById_fkey" FOREIGN KEY ("bookedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_rescheduledFromId_fkey" FOREIGN KEY ("rescheduledFromId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "PostSalesJourney"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentResource" ADD CONSTRAINT "AppointmentResource_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentResource" ADD CONSTRAINT "AppointmentResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadFlag" ADD CONSTRAINT "LeadFlag_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadFlag" ADD CONSTRAINT "LeadFlag_flagId_fkey" FOREIGN KEY ("flagId") REFERENCES "FlagDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadFlag" ADD CONSTRAINT "LeadFlag_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed: the one flag the clinic named on day one (★ Priority, from Zenoti). Others
-- are added from the Scheduling setup screen.
INSERT INTO "FlagDefinition" ("id", "key", "label", "description", "icon", "tone", "active", "sortOrder", "createdAt", "updatedAt")
VALUES ('flag_priority', 'priority', 'Priority', 'Priority patient — give them extra attention at the desk.', 'star', 'citric', true, 0, NOW(), NOW())
ON CONFLICT ("key") DO NOTHING;
