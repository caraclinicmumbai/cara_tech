-- One remark history per lead (lib/leadRemarks.ts). The leads dashboard's Remark
-- (`Lead.remark`) and the lead page's Notes & comments (`LeadComment`) were separate:
-- neither showed what was typed in the other. From now on the comment thread is the
-- history and `Lead.remark` mirrors its newest entry. Data only — no schema change.

-- 1. A dashboard remark that isn't in the thread yet becomes a comment, credited to
--    whoever last set it (from the audit trail) at that time.
INSERT INTO "LeadComment" ("id", "leadId", "authorId", "authorName", "body", "createdAt", "updatedAt")
SELECT
  'rmk_' || md5(l."id"),
  l."id",
  a."actorId",
  COALESCE(u."name", a."actorEmail"),
  btrim(l."remark"),
  COALESCE(a."at", l."updatedAt"),
  COALESCE(a."at", l."updatedAt")
FROM "Lead" l
LEFT JOIN LATERAL (
  SELECT "actorId", "actorEmail", "at"
  FROM "AuditLog"
  WHERE "entityType" = 'lead' AND "entityId" = l."id"
    AND "action" = 'lead.field.update' AND "field" = 'remark'
  ORDER BY "at" DESC
  LIMIT 1
) a ON true
LEFT JOIN "User" u ON u."id" = a."actorId"
WHERE l."remark" IS NOT NULL AND btrim(l."remark") <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "LeadComment" c
    WHERE c."leadId" = l."id" AND btrim(c."body") = btrim(l."remark")
  );

-- 2. The dashboard shows each lead's newest remark. The previous-CRM import's summary
--    comment restates old fields and isn't a remark.
UPDATE "Lead" l
SET "remark" = latest."body"
FROM (
  SELECT DISTINCT ON ("leadId") "leadId", "body"
  FROM "LeadComment"
  WHERE "authorName" IS DISTINCT FROM 'Legacy import'
  ORDER BY "leadId", "createdAt" DESC, "id" DESC
) latest
WHERE l."id" = latest."leadId" AND l."remark" IS DISTINCT FROM latest."body";

-- 3. A blank remark left over from the old inline editor means "none".
UPDATE "Lead" SET "remark" = NULL WHERE "remark" IS NOT NULL AND btrim("remark") = ''
  AND NOT EXISTS (SELECT 1 FROM "LeadComment" c WHERE c."leadId" = "Lead"."id");
