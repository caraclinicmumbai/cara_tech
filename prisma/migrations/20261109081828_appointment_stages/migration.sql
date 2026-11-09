-- CreateTable
CREATE TABLE "AppointmentStage" (
    "id" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tone" TEXT NOT NULL DEFAULT 'ink',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentStageDone" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "doneById" TEXT,
    "doneAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentStageDone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppointmentStage_typeId_order_idx" ON "AppointmentStage"("typeId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentStageDone_appointmentId_stageId_key" ON "AppointmentStageDone"("appointmentId", "stageId");

-- AddForeignKey
ALTER TABLE "AppointmentStage" ADD CONSTRAINT "AppointmentStage_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "AppointmentType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentStageDone" ADD CONSTRAINT "AppointmentStageDone_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentStageDone" ADD CONSTRAINT "AppointmentStageDone_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "AppointmentStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
