-- One follow-up per lead (clinic decision, 2026-11-09). Data only, no schema change.
--
-- Leads used to be seeded with a six-step ladder whose first two steps were AI calls,
-- and AI calling has stopped. For every lead with pending follow-ups:
--   1. Keep ONE: the soonest pending dated step owned by a person, or failing that the
--      soonest pending dated step at all.
--   2. Retire (status 'skipped', with a note) the other pending steps that came from the
--      old ladder or belong to the AI. Follow-ups staff added by hand are left alone.
--   3. A kept step still owned by the AI becomes the lead's telecaller's call, so it
--      reminds a person.
-- Nothing is deleted: retired rows can be put back by resetting their status.

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "leadId"
      ORDER BY ("ownerKind" = 'ai') ASC, "dueAt" ASC, "order" ASC
    ) AS rn
  FROM "LeadFollowUpStep"
  WHERE status = 'pending' AND "dueAt" IS NOT NULL
)
UPDATE "LeadFollowUpStep" s
SET status = 'skipped',
    "completedAt" = NOW(),
    note = 'Retired 2026-11-09: one follow-up per lead',
    "updatedAt" = NOW()
FROM ranked r
WHERE s.id = r.id
  AND r.rn > 1
  AND (s.source = 'template' OR s."ownerKind" = 'ai');

-- Undated AI steps can never become a lead's follow-up date; retire them too.
UPDATE "LeadFollowUpStep"
SET status = 'skipped',
    "completedAt" = NOW(),
    note = 'Retired 2026-11-09: AI calling stopped',
    "updatedAt" = NOW()
WHERE status = 'pending' AND "ownerKind" = 'ai' AND "dueAt" IS NULL;

UPDATE "LeadFollowUpStep" s
SET "ownerKind" = 'rep',
    "ownerRepId" = l."assignedRepId",
    channel = 'call',
    title = CASE WHEN s.title = 'AI first call' THEN 'First call' ELSE 'Call' END,
    "updatedAt" = NOW()
FROM "Lead" l
WHERE s."leadId" = l.id
  AND s.status = 'pending'
  AND s."ownerKind" = 'ai';
