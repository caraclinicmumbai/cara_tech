-- The clinic's own colour for a lead stage or quote status (Settings → Colours). Null = default.
ALTER TABLE "PipelineStatus" ADD COLUMN "color" TEXT;
