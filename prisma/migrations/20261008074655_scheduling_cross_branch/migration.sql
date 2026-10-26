-- CreateTable
CREATE TABLE "ResourceScheduleException" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "branchId" TEXT NOT NULL,
    "startMin" INTEGER NOT NULL,
    "endMin" INTEGER NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceScheduleException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchTravelTime" (
    "id" TEXT NOT NULL,
    "branchAId" TEXT NOT NULL,
    "branchBId" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BranchTravelTime_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResourceScheduleException_resourceId_date_idx" ON "ResourceScheduleException"("resourceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "BranchTravelTime_branchAId_branchBId_key" ON "BranchTravelTime"("branchAId", "branchBId");

-- AddForeignKey
ALTER TABLE "ResourceScheduleException" ADD CONSTRAINT "ResourceScheduleException_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceScheduleException" ADD CONSTRAINT "ResourceScheduleException_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchTravelTime" ADD CONSTRAINT "BranchTravelTime_branchAId_fkey" FOREIGN KEY ("branchAId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchTravelTime" ADD CONSTRAINT "BranchTravelTime_branchBId_fkey" FOREIGN KEY ("branchBId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
