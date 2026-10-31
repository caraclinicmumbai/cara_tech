// The call-log side of a patient ringing the clinic line (§presence) — one Call row per
// inbound call, from the first ring to the hang-up, whatever the carrier.
//
// Every inbound call shows in the log as one of two things:
//   IVR Incoming — a counsellor picked up (or the call is still ringing through the ladder)
//   IVR Missed   — nobody picked up: the caller hung up while it rang, or left a voicemail
//
// The row is created on the FIRST webhook, before anyone's phone rings, keyed on the
// carrier's call id (`providerSid`). Each later callback updates that row instead of filing
// its own — the same "incomplete in the log but never missing from it" rule as the outbound
// click-to-call (lib/clickToCallLog.ts). Before this, an inbound call that nobody answered
// and that left no voicemail left no trace in the CRM at all.
//
// A missed call is not just a log line: the lead's owner gets a "Return missed call" step at
// the top of their roadmap, a bell notification, and the counsellor channel on Slack.
import type { Call } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { notifyCounsellor } from "@/lib/counsellor";
import { notifyRep } from "@/lib/notifications";
import { pickOwnerRep, claimUnownedLead, TELECALLER_REP } from "@/lib/salesReps";
import type { CallProvider } from "@/lib/providers/recordings";
import { findPlivoRecordingForCall } from "@/lib/providers/plivo";
import { transcribeAndScoreCall } from "@/lib/callTranscription";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

/// Shorter than this is a caller hanging up at the tone, not a message.
export const MIN_VOICEMAIL_SECONDS = 1;

/// What the call log calls a call. Only the inbound kinds get a label of their own — the
/// rest keep their stored key, as they always have.
export function callTypeLabel(callType: string, outcome?: string | null): string {
  if (callType === "inbound_voicemail") return "IVR Missed";
  if (callType === "inbound") {
    return outcome === "missed" || outcome === "voicemail" ? "IVR Missed" : "IVR Incoming";
  }
  return callType;
}

/// Is this a call the patient placed to the clinic line?
export function isInboundCallType(callType: string): boolean {
  return callType === "inbound" || callType === "inbound_voicemail";
}

/// The Call row for this inbound call, creating it on the first webhook. Carriers retry and
/// every ladder hop arrives with the same call id, so this is find-or-create on
/// `providerSid` — and a race between two first hops resolves to the one row the unique
/// index allowed.
export async function startInboundCall(opts: {
  leadId: string;
  providerSid: string;
  provider: CallProvider;
}): Promise<Call | null> {
  const { leadId, providerSid, provider } = opts;
  if (!providerSid) return null;
  const existing = await prisma.call.findUnique({ where: { providerSid } });
  if (existing) return existing;
  try {
    return await prisma.call.create({
      data: { leadId, callType: "inbound", provider, outcome: "ringing", providerSid },
    });
  } catch {
    // P2002 — a concurrent hop created it first.
    return prisma.call.findUnique({ where: { providerSid } }).catch(() => null);
  }
}

/// A counsellor picked up. Authoritative: the call connected, whatever a hang-up callback
/// racing it may have thought.
export async function markInboundConnected(
  callId: string,
  data: { repId?: string; duration?: number },
): Promise<void> {
  await prisma.call
    .update({
      where: { id: callId },
      data: {
        outcome: "connected",
        ...(data.repId ? { handledById: data.repId } : {}),
        ...(data.duration != null && Number.isFinite(data.duration) ? { duration: data.duration } : {}),
      },
    })
    .catch((err) => logger.error(`Inbound call ${callId}: could not mark connected: ${String(err)}`));
}

/// A counsellor's leg "answered" — the whisper ran — but ended without a conversation:
/// their voicemail or a carrier announcement picked up, or they cut it straight away. Undo
/// what the whisper recorded on the strength of that answer, so the call doesn't read as
/// handled by them, and a first-time caller's lead isn't left with someone who never spoke
/// to the patient. Only state THIS call wrote is touched: the row's handler, and a claim
/// made since the call began (the lead was unowned before it, so every pending step it
/// holds for this rep came with that claim).
export async function undoInboundAnswer(callId: string, repId: string): Promise<void> {
  try {
    const call = await prisma.call.findUnique({ where: { id: callId }, select: { leadId: true, createdAt: true } });
    if (!call) return;
    await prisma.call.updateMany({
      where: { id: callId, handledById: repId, outcome: "connected" },
      data: { outcome: "ringing", handledById: null },
    });
    const released = await prisma.lead.updateMany({
      where: { id: call.leadId, assignedRepId: repId, assignedAt: { gte: call.createdAt } },
      data: { assignedRepId: null, assignedAt: null },
    });
    if (released.count === 0) return;
    await prisma.leadFollowUpStep.updateMany({
      where: { leadId: call.leadId, ownerKind: "rep", ownerRepId: repId, status: "pending" },
      data: { ownerRepId: null },
    });
    const rep = await prisma.salesRep.findUnique({ where: { id: repId }, select: { name: true } });
    await writeAudit({
      action: "lead.assign", entityType: "lead", entityId: call.leadId,
      oldValue: rep?.name ?? repId, newValue: "Unassigned",
      reason: "Their phone picked up for a moment but the call never connected",
      meta: { repId, system: true },
    });
  } catch (err) {
    logger.error(`Inbound call ${callId}: could not undo the brief answer by ${repId}: ${String(err)}`);
  }
}

/// Nobody picked up. Settles the row as missed — or as voicemail when the caller left a
/// message — and, the FIRST time only, puts the callback in front of the owner.
///
/// Only a row still "ringing" is settled, in one conditional update, so the alerts can't
/// fire twice however many callbacks arrive. A voicemail landing after the hang-up already
/// marked the call missed upgrades it to "voicemail" without alerting again.
export async function markInboundMissed(
  callId: string,
  opts: { voicemail?: { recordingUrl?: string; duration?: number }; reason: string },
): Promise<void> {
  const outcome = opts.voicemail ? "voicemail" : "missed";
  const recording = opts.voicemail?.recordingUrl
    ? {
        recordingUrl: opts.voicemail.recordingUrl,
        // The greeting told the caller the line is recorded before they left a message.
        recordingConsent: true,
        ...(opts.voicemail.duration != null && Number.isFinite(opts.voicemail.duration)
          ? { duration: opts.voicemail.duration }
          : {}),
      }
    : {};

  const settled = await prisma.call.updateMany({
    where: { id: callId, outcome: "ringing" },
    data: {
      outcome,
      ...recording,
      // A message is transcribed into this field; a silent miss gets the reason instead.
      ...(opts.voicemail ? {} : { transcript: opts.reason }),
    },
  });

  if (settled.count === 0) {
    if (opts.voicemail) {
      await prisma.call
        .updateMany({
          where: { id: callId, outcome: "missed", recordingUrl: null },
          data: { outcome, ...recording, transcript: null },
        })
        .catch((err) => logger.error(`Inbound call ${callId}: could not attach voicemail: ${String(err)}`));
    }
    return;
  }

  const call = await prisma.call.findUnique({
    where: { id: callId },
    select: {
      lead: {
        select: { id: true, name: true, phone: true, assignedRepId: true, assignedRep: { select: { name: true } } },
      },
    },
  });
  if (call) await raiseMissedCallFollowUp(call.lead, opts.reason, !!opts.voicemail);
}

/// Make a missed inbound call somebody's job: a "Return missed call" step due now on the
/// owner's roadmap, a bell for the owner, and a Slack post to the counsellor channel. If the
/// lead has no owner the step still exists (unowned), so it shows on the lead either way.
export async function raiseMissedCallFollowUp(
  lead: { id: string; name: string; phone: string; assignedRepId: string | null; assignedRep: { name: string } | null },
  reason: string,
  voicemail: boolean,
): Promise<void> {
  // A first-time caller nobody answered has no owner yet. The callback still has to be
  // somebody's job, so the next telecaller in the rota gets the lead.
  if (!lead.assignedRepId) {
    try {
      const rep = (await pickOwnerRep({ pool: TELECALLER_REP })) ?? (await pickOwnerRep());
      if (rep && (await claimUnownedLead(lead.id, rep.id, "Missed their first call to the clinic - next in the rota"))) {
        lead = { ...lead, assignedRepId: rep.id, assignedRep: { name: rep.name } };
      }
    } catch (err) {
      logger.error(`Missed first call on lead ${lead.id}: could not assign an owner: ${String(err)}`);
    }
  }

  try {
    const max = await prisma.leadFollowUpStep.aggregate({
      where: { leadId: lead.id },
      _max: { order: true },
    });
    await prisma.leadFollowUpStep.create({
      data: {
        leadId: lead.id,
        order: (max._max.order ?? -1) + 1,
        title: "Return missed call",
        channel: "call",
        status: "pending",
        dueAt: new Date(),
        ownerKind: "rep",
        ownerRepId: lead.assignedRepId,
        source: "auto",
        note: `Patient called the clinic line. ${reason}`,
      },
    });
  } catch (err) {
    logger.error(`Missed inbound call on lead ${lead.id}: could not add the roadmap step: ${String(err)}`);
  }

  logger.info(`Missed inbound call from ${lead.phone} on lead ${lead.id} — ${reason}`);

  void notifyRep(lead.assignedRepId, {
    kind: "missed_call",
    title: `📞 Missed call — ${lead.name}`,
    body: `${reason} Call them back.`,
    leadId: lead.id,
  }).catch((err) => logger.error(`Missed inbound call: bell failed: ${String(err)}`));

  void notifyCounsellor({
    kind: "missed_inbound",
    lead: { id: lead.id, name: lead.name, phone: lead.phone },
    reason,
    extra: [
      lead.assignedRep?.name ? `Owner: ${lead.assignedRep.name}` : "No owner assigned",
      voicemail ? "Voicemail left — transcript on the lead" : "",
    ].filter(Boolean),
  });
}

/// Collect the voicemail on a missed Plivo call straight from Plivo, in case its
/// callbacks never reached us. The voicemail route is the normal path; this runs after the
/// hang-up and retries for about a minute, because Plivo can take a few seconds to list a
/// recording after the call ends. Stops as soon as the call has a recording either way.
export async function collectPlivoVoicemail(callId: string, callUuid: string): Promise<void> {
  for (const waitMs of [3_000, 10_000, 20_000, 30_000]) {
    await new Promise((r) => setTimeout(r, waitMs));
    const row = await prisma.call
      .findUnique({ where: { id: callId }, select: { outcome: true, recordingUrl: true, transcript: true } })
      .catch(() => null);
    // Already filed by the voicemail route, or the call turned out to have connected.
    if (!row || row.recordingUrl || (row.outcome !== "missed" && row.outcome !== "ringing")) return;

    const rec = await findPlivoRecordingForCall(callUuid);
    if (!rec) continue;
    if (rec.durationSec < MIN_VOICEMAIL_SECONDS) return; // hung up at the tone

    await markInboundMissed(callId, {
      voicemail: { recordingUrl: rec.url, duration: rec.durationSec },
      reason: "Nobody was free — they left a voicemail.",
    });
    logger.info(`Inbound call ${callId}: voicemail collected from Plivo (${rec.durationSec}s)`);
    void transcribeAndScoreCall(callId, rec.url);
    return;
  }
}
