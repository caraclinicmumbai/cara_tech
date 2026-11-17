-- Which inbound call holds a rep's ringing reservation, so the caller's hang-up can free it.
ALTER TABLE "SalesRep" ADD COLUMN "ringingCallId" TEXT;
CREATE INDEX "SalesRep_ringingCallId_idx" ON "SalesRep"("ringingCallId");
