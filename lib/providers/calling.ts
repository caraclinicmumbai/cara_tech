// Which provider places outbound calls, and the one call site the rest of the app uses.
//
// `CALL_PROVIDER` is the switch, defaulting to twilio so that deploying this code changes
// NOTHING until somebody sets it deliberately. That default is the rollback: if Plivo
// misbehaves on a Monday morning, flipping one variable puts every counsellor back on a
// provider that was working an hour earlier, with no deploy.
//
// Note what this does NOT dispatch: recordings. A recording belongs to the provider that
// made it, forever, so it dispatches on `Call.provider` (lib/providers/recordings.ts) and
// not on this setting. Switching provider must not orphan yesterday's audio.
import { clickToCall as twilioClickToCall, isTwilioConfigured } from "@/lib/providers/twilio";
import { plivoClickToCall, isPlivoConfigured } from "@/lib/providers/plivo";
import { asProvider, type CallProvider } from "@/lib/providers/recordings";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

/// The provider that will place calls made from now on.
export function activeProvider(): CallProvider {
  return asProvider(process.env.CALL_PROVIDER?.trim().toLowerCase());
}

/// Is outbound calling usable at all right now?
export function isCallingConfigured(): boolean {
  return activeProvider() === "plivo" ? isPlivoConfigured() : isTwilioConfigured();
}

export type ClickToCallResult =
  | { ok: true; sid: string; provider: CallProvider; callId: string }
  | { ok: false; error: string };

/// Ring `repPhone`; on answer the provider fetches our XML, which dials the lead, records
/// and bridges.
///
/// The Call row is created HERE, before anything rings, with outcome "ringing" — and its id
/// is threaded onto every callback URL so each callback updates this row rather than filing
/// its own (lib/clickToCallLog.ts). That is what makes every press of the button show up in
/// the call log, including the ones where nobody ever picked up.
///
/// The returned `sid` is the provider's own correlation id and they are NOT the same kind of
/// thing: Twilio hands back the CallSid of the leg it just created, Plivo hands back a
/// request uuid and assigns the real CallUUID when the leg goes up. Neither is relied on for
/// correlation — `callId` is — so this is for logging.
export async function startClickToCall(
  repPhone: string,
  leadId: string,
  repId?: string,
  actor?: { id?: string; email?: string | null },
): Promise<ClickToCallResult> {
  const provider = activeProvider();
  const call = await prisma.call.create({
    data: { leadId, callType: "human_handover", provider, outcome: "ringing", handledById: repId },
  });

  const res =
    provider === "plivo"
      ? await plivoClickToCall(repPhone, leadId, repId, call.id).then((r) =>
          r.ok ? { ok: true as const, sid: r.requestUuid } : r,
        )
      : await twilioClickToCall(repPhone, leadId, repId, call.id);

  if (!res.ok) {
    await prisma.call
      .update({ where: { id: call.id }, data: { outcome: "failed", transcript: "The call could not be started." } })
      .catch((err) => logger.error(`Click-to-call: could not mark call ${call.id} failed: ${String(err)}`));
    return { ok: false, error: res.error };
  }

  // Put the attempt on the lead's change history too, so the two views of "what happened
  // to this lead" agree. Best-effort: the call is already ringing.
  const rep = repId
    ? await prisma.salesRep.findUnique({ where: { id: repId }, select: { name: true } }).catch(() => null)
    : null;
  void writeAudit({
    actorId: actor?.id,
    actorEmail: actor?.email,
    action: "lead.call",
    entityType: "lead",
    entityId: leadId,
    newValue: rep ? `Called by ${rep.name}` : "Call placed",
    meta: { callId: call.id, provider },
  });

  return { ok: true, sid: res.sid, provider, callId: call.id };
}

/// Log the active provider once at startup, so a call that goes out on the wrong one is
/// visible in the logs rather than only on a patient's handset.
export function logActiveProvider(): void {
  const p = activeProvider();
  const ready = isCallingConfigured();
  const msg = `Calling provider: ${p}${ready ? "" : " — NOT CONFIGURED, click-to-call will be refused"}`;
  if (ready) logger.info(msg);
  else logger.warn(msg);
}
