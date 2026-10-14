-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "QuoteVersion" ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1;
