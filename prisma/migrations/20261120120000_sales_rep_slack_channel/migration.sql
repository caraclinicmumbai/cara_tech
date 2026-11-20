-- A rep's own Slack channel for their alerts (Users → Sales reps). Null = DM as before.
ALTER TABLE "SalesRep" ADD COLUMN "slackChannelId" TEXT;
