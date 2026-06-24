// Automated WhatsApp outreach (§3.1.3). Business-initiated messages that the CRM
// fires on lifecycle events (new lead, confirmed, unreachable, callback). Because
// these go out beyond the 24h window they MUST be approved templates.
//
// Every trigger is gated by an env template name → unset = the trigger is OFF, so
// nothing sends until you've configured (and approved) the template. Each send is
// best-effort (never throws into the calling flow) and respects opt-out.
import { isWhatsAppConfigured } from "@/lib/providers/whatsapp";
import { listApprovedTemplates, buildTemplateComponents } from "@/lib/whatsappTemplates";
import { sendLeadTemplate } from "@/lib/messages";
import { logger } from "@/lib/logger";

/// Env template name for each lifecycle trigger (undefined = trigger disabled).
export const outreachTemplate = {
  newLead: () => process.env.WHATSAPP_TEMPLATE_NEW_LEAD,
  confirmed: () => process.env.WHATSAPP_TEMPLATE_CONFIRMED,
  unreachable: () => process.env.WHATSAPP_TEMPLATE_UNREACHABLE,
  callback: () => process.env.WHATSAPP_TEMPLATE_CALLBACK,
};

/// First word of a name, for the common {{1}} = first-name template variable.
export function firstName(name: string): string {
  return (name ?? "").trim().split(/\s+/)[0] || "there";
}

/// Format a Date as an IST wall-clock string for a {{2}} = time template variable.
export function istTime(d: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

/// Fire a configured automated template for a lead. No-op (safe) when the trigger
/// is unset, WhatsApp isn't configured, or the template isn't approved. `vars` are
/// candidate body values in order, sliced to the template's actual parameter count.
export async function sendAutomatedTemplate(
  leadId: string,
  templateName: string | undefined,
  vars: string[],
): Promise<void> {
  try {
    if (!templateName) return; // trigger disabled
    if (!isWhatsAppConfigured()) return;

    const tpl = (await listApprovedTemplates()).find((t) => t.name === templateName);
    if (!tpl) {
      logger.warn(`Automated WA template "${templateName}" not approved/found — skip lead ${leadId}`);
      return;
    }

    const params = vars.slice(0, tpl.paramCount);
    if (params.filter(Boolean).length < tpl.paramCount) {
      logger.warn(
        `Automated WA "${templateName}" needs ${tpl.paramCount} var(s), have ${params.filter(Boolean).length} — skip lead ${leadId}`,
      );
      return;
    }

    // sendLeadTemplate handles lead-not-found + opt-out + logging the Message.
    const res = await sendLeadTemplate(
      leadId,
      tpl.name,
      tpl.language,
      buildTemplateComponents(params),
      { automated: true },
    );
    if (res.ok) logger.info(`Automated WA "${templateName}" sent to lead ${leadId}`);
    else logger.warn(`Automated WA "${templateName}" not sent (lead ${leadId}): ${res.error}`);
  } catch (err) {
    logger.error(`Automated WA "${templateName}" errored for lead ${leadId}: ${String(err)}`);
  }
}
