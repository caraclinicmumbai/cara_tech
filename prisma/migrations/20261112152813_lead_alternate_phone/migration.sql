-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "alternatePhone" TEXT;

-- Leads brought over from the previous CRM kept their alternate number only inside the
-- import's summary comment ("Alternate number: …"). Lift it into the new field.
UPDATE "Lead" l
SET "alternatePhone" = c.alt
FROM (
  SELECT DISTINCT ON ("leadId")
    "leadId",
    NULLIF(TRIM(SUBSTRING(body FROM 'Alternate number: ([^\n]+)')), '') AS alt
  FROM "LeadComment"
  WHERE "authorName" = 'Legacy import' AND body LIKE '%Alternate number:%'
  ORDER BY "leadId", "createdAt"
) c
WHERE l.id = c."leadId" AND l."alternatePhone" IS NULL AND c.alt IS NOT NULL;
