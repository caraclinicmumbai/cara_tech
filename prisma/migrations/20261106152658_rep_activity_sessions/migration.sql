-- CreateTable
CREATE TABLE "RepActivitySession" (
    "id" TEXT NOT NULL,
    "repId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepActivitySession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RepActivitySession_repId_lastSeenAt_idx" ON "RepActivitySession"("repId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "RepActivitySession_startedAt_idx" ON "RepActivitySession"("startedAt");

-- AddForeignKey
ALTER TABLE "RepActivitySession" ADD CONSTRAINT "RepActivitySession_repId_fkey" FOREIGN KEY ("repId") REFERENCES "SalesRep"("id") ON DELETE CASCADE ON UPDATE CASCADE;
