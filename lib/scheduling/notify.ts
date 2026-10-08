// Telling a patient their appointment changed (§2.9 "patient communication"). One
// entry point so every caller — the rebooking worklist today, reminders and the
// self-service link in 2.4 — sends the same way and records the same outcome.
//
// TODAY: WhatsApp free text, which Meta allows only inside the 24-hour window after
// the patient last wrote to us. Outside it, nothing is sent and the caller is told
// to call — never silently. Feature 2.4 adds the approved templates (any time), the
// rescheduling link and the SMS fallback here, behind the same function.
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { sendLeadText } from "@/lib/messages";

export type PatientMessageResult = { sent: boolean; channel: "whatsapp" | null; reason?: string };

export async function messagePatient(appointmentId: string, text: string, sentBy?: string | null): Promise<PatientMessageResult> {
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId }, select: { leadId: true } });
  if (!appt) return { sent: false, channel: null, reason: "Appointment not found" };
  try {
    const r = await sendLeadText(appt.leadId, text, { automated: !sentBy, sentBy: sentBy ?? undefined });
    if (r.ok) return { sent: true, channel: "whatsapp" };
    return { sent: false, channel: null, reason: `${r.error} — please call the patient` };
  } catch (err) {
    logger.error(`messagePatient failed for ${appointmentId}: ${String(err)}`);
    return { sent: false, channel: null, reason: "Message failed — please call the patient" };
  }
}
