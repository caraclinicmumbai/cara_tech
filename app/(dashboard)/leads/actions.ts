"use server";

// Server Actions for staff edits to a lead's pipeline stage and tag (§3.1).
// Server Functions are reachable via direct POST, so EVERY action re-checks the
// session (see Next.js data-security guide) before touching the database.
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { isLeadStage, LOST_STAGE } from "@/lib/leadStages";
import { sendLeadText } from "@/lib/messages";
import { logger } from "@/lib/logger";

const TAG_MAX = 120;
const REASON_MAX = 300;
const MESSAGE_MAX = 4096; // WhatsApp text body limit

export async function setLeadStage(
  leadId: string,
  stage: string,
  reason?: string,
): Promise<void> {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
  if (!isLeadStage(stage)) throw new Error("Invalid stage");

  // Moving to "Lost" requires a reason; any other stage clears a prior one.
  const isLost = stage === LOST_STAGE;
  const lostReason = reason?.trim().slice(0, REASON_MAX);
  if (isLost && !lostReason) throw new Error("A reason is required to mark a lead lost");

  await prisma.lead.update({
    where: { id: leadId },
    data: {
      stage,
      lostReason: isLost ? lostReason : null,
      lostAt: isLost ? new Date() : null,
    },
  });
  logger.info(
    `Lead ${leadId} stage set to ${stage}${isLost ? ` (lost: ${lostReason})` : ""} by ${session.user.email ?? "?"}`,
  );

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
}

/// Manual WhatsApp reply from an agent (free-form, inside the 24h window). The
/// message is logged to the lead's thread stamped with the sending agent.
export async function sendLeadWhatsApp(
  leadId: string,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");

  const text = body.trim().slice(0, MESSAGE_MAX);
  if (!text) return { ok: false, error: "Message is empty" };

  const res = await sendLeadText(leadId, text, { sentBy: session.user.email ?? undefined });
  revalidatePath(`/leads/${leadId}`);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export async function setLeadTag(leadId: string, tag: string): Promise<void> {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");

  const trimmed = tag.trim().slice(0, TAG_MAX);
  await prisma.lead.update({
    where: { id: leadId },
    data: { tag: trimmed || null },
  });

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
}
