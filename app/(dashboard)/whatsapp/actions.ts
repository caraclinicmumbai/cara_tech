"use server";

// Server Action behind the WhatsApp inbox (§whatsapp inbox): catching a
// conversation up. Session- and scope-checked like every other lead action —
// a read marker is small, but it's still a statement about a lead this person
// must be allowed to see.
import { requireCapability, userCanAccessLead } from "@/lib/authz";
import { markConversationRead } from "@/lib/whatsappInbox";

export async function readConversation(leadId: string): Promise<{ ok: boolean }> {
  const user = await requireCapability("leads.whatsapp");
  if (!user.id || !leadId) return { ok: false };
  if (!(await userCanAccessLead(user, leadId))) return { ok: false };
  await markConversationRead(user.id, leadId);
  return { ok: true };
}
