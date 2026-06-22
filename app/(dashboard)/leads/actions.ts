"use server";

// Server Actions for staff edits to a lead's pipeline stage and tag (§3.1).
// Server Functions are reachable via direct POST, so EVERY action re-checks the
// session (see Next.js data-security guide) before touching the database.
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { isLeadStage } from "@/lib/leadStages";
import { logger } from "@/lib/logger";

const TAG_MAX = 120;

export async function setLeadStage(leadId: string, stage: string): Promise<void> {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
  if (!isLeadStage(stage)) throw new Error("Invalid stage");

  await prisma.lead.update({ where: { id: leadId }, data: { stage } });
  logger.info(`Lead ${leadId} stage set to ${stage} by ${session.user.email ?? "?"}`);

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
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
