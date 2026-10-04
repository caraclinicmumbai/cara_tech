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
  | { ok: true; sid: string; provider: CallProvider }
  | { ok: false; error: string };

/// Ring `repPhone`; on answer the provider fetches our XML, which dials the lead, records
/// and bridges. `provider` comes back with the result so the caller can stamp it on the
/// `Call` row — which is what lets the recording be fetched or erased later.
///
/// The returned `sid` is the provider's own correlation id and they are NOT the same kind of
/// thing: Twilio hands back the CallSid of the leg it just created, Plivo hands back a
/// request uuid and assigns the real CallUUID when the leg goes up. Neither is relied on for
/// correlation — the webhooks carry the authoritative id — so this is for logging.
export async function startClickToCall(
  repPhone: string,
  leadId: string,
  repId?: string,
): Promise<ClickToCallResult> {
  const provider = activeProvider();
  if (provider === "plivo") {
    const res = await plivoClickToCall(repPhone, leadId, repId);
    return res.ok ? { ok: true, sid: res.requestUuid, provider } : { ok: false, error: res.error };
  }
  const res = await twilioClickToCall(repPhone, leadId, repId);
  return res.ok ? { ok: true, sid: res.sid, provider } : { ok: false, error: res.error };
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
