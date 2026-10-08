-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "overriddenById" TEXT,
ADD COLUMN     "overrideReason" TEXT;

-- AlterTable
ALTER TABLE "Resource" ADD COLUMN     "allowOverride" BOOLEAN NOT NULL DEFAULT false;
