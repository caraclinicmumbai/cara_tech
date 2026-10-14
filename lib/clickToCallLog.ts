// The one Call row a click-to-call writes, from the click to the hang-up (§3.1).
//
// It used to be the other way round: nothing was written when the counsellor pressed Call,
// and the row only appeared at the END — from the dial-result callback if the patient leg
// failed, or from the recording callback if it connected. Every gap between those two
// produced a call the CRM never heard of: the counsellor's own phone ringing out (no
// callback at all was subscribed for that leg), a connected call whose recording callback
// was lost, a carrier that reported "completed" for a voicemail. Field testing hit all of
// them in one afternoon.
//
// Now the row is created at the click with outcome "ringing" and its id rides on every
// provider callback URL (`callId=`). Each callback UPDATES that row instead of creating one,
// so a call can be incomplete in the log but never missing from it.
//
// Precedence between callbacks, because their arrival order is not guaranteed:
//   • dial-result and recording are authoritative about the PATIENT leg — they always write.
//   • the counsellor-leg hang-up only writes while the row is still "ringing", i.e. when
//     nothing better has reported. It is the safety net, not the source of truth.
import { prisma } from "@/lib/prisma";
import type { Call } from "@prisma/client";

/// Outcome values a click-to-call row moves through. Stored in `Call.outcome`, which AI
/// calls also use (confirmed / rescheduled / not_interested / no_answer) — the human-call
/// values are deliberately distinct so the AI funnel never counts them.
export const CLICK_TO_CALL_OUTCOMES = {
  ringing: "Ringing",
  connected: "Connected",
  no_answer: "Patient didn't answer",
  unreachable: "Couldn't connect",
  cancelled: "Ended before the patient answered",
  rep_missed: "Counsellor's phone not answered",
  failed: "Couldn't start the call",
} as const;

/// A click-to-call still "ringing" after this long never heard back from the provider —
/// most likely its callbacks are being refused (signature, wrong public url). Saying so in
/// the log is more useful than a call that rings forever.
const STALE_RINGING_MS = 15 * 60_000;

/// Human label for any stored call outcome — the click-to-call ones above, plus the AI
/// outcome keys, which read fine as they are once the underscore goes.
export function callOutcomeLabel(outcome: string | null | undefined, createdAt?: Date): string {
  if (!outcome) return "—";
  if (outcome === "ringing" && createdAt && Date.now() - createdAt.getTime() > STALE_RINGING_MS) {
    return "No result from the phone provider";
  }
  return (
    (CLICK_TO_CALL_OUTCOMES as Record<string, string>)[outcome] ?? outcome.replace(/_/g, " ")
  );
}

/// The row a callback refers to — only if it really is a click-to-call on that lead. The
/// callId arrives in a URL; the signature check proves the provider sent it, and this
/// proves it points where the leadId beside it says.
export async function findClickToCall(callId: string | null, leadId: string): Promise<Call | null> {
  if (!callId) return null;
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call || call.leadId !== leadId || call.callType !== "human_handover") return null;
  return call;
}

/// Ring time for the patient leg, in seconds. Without it Twilio waits 30s and Plivo
/// longer — and on Indian networks a REJECTED call often keeps playing ringback until
/// that timeout, which is what had a counsellor listening to ten rings for a patient who
/// declined after three.
export function patientRingSeconds(): number {
  const n = Number(process.env.CLICK_TO_CALL_RING_SECONDS ?? 25);
  return Number.isFinite(n) && n >= 5 && n <= 120 ? Math.round(n) : 25;
}

/// `k=v&…` for the ids threaded through callback urls, skipping the ones not set. Both
/// providers build their callback urls with it, so the routes read the same names.
export function callbackQuery(ids: { leadId?: string; repId?: string; callId?: string }): string {
  return Object.entries(ids)
    .filter(([, v]) => !!v)
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join("&");
}
