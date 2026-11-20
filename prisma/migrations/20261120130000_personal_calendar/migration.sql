-- Personal calendar (/calendar): tasks, repeating-task ticks, and blocked time.
-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "assigneeId" TEXT NOT NULL,
    "createdById" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "repeat" TEXT NOT NULL DEFAULT 'none',
    "repeatUntil" DATE,
    "status" TEXT NOT NULL DEFAULT 'open',
    "doneAt" TIMESTAMP(3),
    "doneById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskDone" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "occurrence" TEXT NOT NULL,
    "doneAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneById" TEXT,

    CONSTRAINT "TaskDone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeBlock" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "timeOffId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "TimeBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_assigneeId_dueAt_idx" ON "Task"("assigneeId", "dueAt");

-- CreateIndex
CREATE INDEX "Task_createdById_idx" ON "Task"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "TaskDone_taskId_occurrence_key" ON "TaskDone"("taskId", "occurrence");

-- CreateIndex
CREATE UNIQUE INDEX "TimeBlock_timeOffId_key" ON "TimeBlock"("timeOffId");

-- CreateIndex
CREATE INDEX "TimeBlock_userId_startAt_idx" ON "TimeBlock"("userId", "startAt");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDone" ADD CONSTRAINT "TaskDone_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeBlock" ADD CONSTRAINT "TimeBlock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Managers may open a colleague's calendar (`calendar.viewOthers`). Roles an admin has
-- customised keep their own list verbatim, so the new capability is added to those that
-- get it by default — the same thing scripts/backfillRoleCapabilities.ts does, done here
-- so the deploy needs no extra step.
UPDATE "RolePermission"
SET "capabilities" = "capabilities" || '["calendar.viewOthers"]'::jsonb
WHERE "role" IN ('telecalling_head', 'branch_manager', 'sales_head')
  AND jsonb_typeof("capabilities") = 'array'
  AND NOT ("capabilities" ? 'calendar.viewOthers');
