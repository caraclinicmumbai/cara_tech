// Lead remarks (§notes). There is ONE remark history per lead: the LeadComment thread
// ("Notes & comments" on the lead page). `Lead.remark` — the leads dashboard's Remark
// column — is a copy of the newest entry, kept so the list can show, filter and search
// it without reading every thread. Anything that adds or deletes a comment calls
// syncLeadRemark; nothing writes `Lead.remark` directly.
//
// They used to be two unrelated stores — a remark typed on the dashboard never reached
// the lead, and a note on the lead never reached the dashboard.
import { prisma } from "@/lib/prisma";

/// The summary comment the previous-CRM import wrote on each lead. It restates the old
/// CRM's fields, not a remark anyone made, so it never counts as one.
export const IMPORT_SUMMARY_AUTHOR = "Legacy import";

/// Point the dashboard's Remark at the lead's newest comment (null when there's none).
export async function syncLeadRemark(leadId: string): Promise<void> {
  const latest = await prisma.leadComment.findFirst({
    // `authorName: { not }` alone would also drop comments with no author (SQL NULL).
    where: { leadId, OR: [{ authorName: null }, { authorName: { not: IMPORT_SUMMARY_AUTHOR } }] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { body: true },
  });
  await prisma.lead.update({ where: { id: leadId }, data: { remark: latest?.body ?? null } });
}
