// WhatsApp conversation service (§3.1.3). One place that persists every message
// (inbound replies, automated sends, manual agent sends) against a lead so the
// profile shows ONE continuous thread, and that enforces WhatsApp's 24h
// customer-service window before a free-form text can go out.
//
// The low-level Graph API call lives in lib/providers/whatsapp.ts; this module
// adds the lead lookup + persistence + window logic on top.
import type { Message, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { publishLeadMessageEvent } from "@/lib/realtime";
import { pickOwnerRep, assignLeadToRep } from "@/lib/salesReps";
import { extractBodyParams, renderTemplateBody } from "@/lib/whatsappTemplates";
import {
  sendWhatsAppText,
  sendWhatsAppTemplate,
  uploadWhatsAppMedia,
  sendWhatsAppDocument,
  sendWhatsAppDocumentTemplate,
  sendWhatsAppButtons,
  sendWhatsAppList,
  sendWhatsAppImageLink,
} from "@/lib/providers/whatsapp";
import { logger } from "@/lib/logger";

// Meta's customer-service window: once a lead messages us, we may send free-form
// text for 24h. Outside it, only an approved TEMPLATE can re-open the thread.
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/// Find the canonical lead for an inbound WhatsApp number (last-10-digit match,
/// oldest record — mirrors lib/leadIntake dedupe). Returns null if unknown.
export async function findLeadByPhone(phone: string) {
  const last10 = (phone.match(/\d/g)?.join("") ?? "").slice(-10);
  if (last10.length < 7) return null;
  return prisma.lead.findFirst({
    where: { phone: { contains: last10 } },
    orderBy: { createdAt: "asc" },
  });
}

/// Find the lead for an inbound WhatsApp number, or create one when an unknown
/// number messages cold (Phase 2). New leads come in as source "whatsapp",
/// manual_followup, and are NEVER auto-called (a human triages the chat first).
/// `waName` is the sender's WhatsApp profile name, if the webhook provided it.
export async function findOrCreateLeadByPhone(
  phone: string,
  waName?: string,
): Promise<{ lead: NonNullable<Awaited<ReturnType<typeof findLeadByPhone>>>; created: boolean }> {
  const existing = await findLeadByPhone(phone);
  if (existing) return { lead: existing, created: false };

  const digits = phone.match(/\d/g)?.join("") ?? "";
  const lead = await prisma.lead.create({
    data: {
      name: waName?.trim() || "WhatsApp lead",
      phone: digits ? `+${digits}` : phone,
      source: "whatsapp",
      status: "manual_followup",
    },
  });
  logger.info(`Created lead ${lead.id} from inbound WhatsApp ${phone} (${waName ?? "no name"})`);

  // Ownership (§3.1 RBAC) — a cold WhatsApp enquiry is a lead like any other, so it
  // gets a counsellor round-robin the same way intake does. Without this the chat
  // would sit in nobody's "my leads" and there'd be no owner to hand over to.
  // Best-effort: an assignment failure must not lose the inbound message.
  try {
    const owner = await pickOwnerRep();
    if (owner) await assignLeadToRep(lead.id, owner.id);
    else logger.warn(`WhatsApp lead ${lead.id} has no owner — no active sales rep on the roster`);
  } catch (err) {
    logger.error(`Failed to assign owner for WhatsApp lead ${lead.id}: ${String(err)}`);
  }

  return { lead, created: true };
}

/// Persist a message and nudge any open chat window for that lead (§realtime).
/// Every write to the thread goes through here so the live stream can't miss one.
async function saveMessage(data: Prisma.MessageUncheckedCreateInput): Promise<Message> {
  const message = await prisma.message.create({ data });
  void publishLeadMessageEvent(message.leadId);
  return message;
}

/// Is the 24h free-form window currently open for this lead? True iff the lead's
/// most recent INBOUND message arrived within the last 24h.
export async function isServiceWindowOpen(leadId: string, now = new Date()): Promise<boolean> {
  const last = await prisma.message.findFirst({
    where: { leadId, direction: "inbound" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!last) return false;
  return now.getTime() - last.createdAt.getTime() < SERVICE_WINDOW_MS;
}

type RecordInboundInput = {
  leadId: string;
  waId?: string;
  type?: string;
  body?: string;
  mediaId?: string;
};

/// Persist an inbound reply. Idempotent on waId (Meta retries webhooks).
export async function recordInbound(input: RecordInboundInput): Promise<Message> {
  const data = {
    leadId: input.leadId,
    direction: "inbound",
    waId: input.waId,
    type: input.type ?? "text",
    body: input.body,
    mediaId: input.mediaId,
    status: "received",
    automated: false,
  };
  if (input.waId) {
    const message = await prisma.message.upsert({
      where: { waId: input.waId },
      create: data,
      update: {},
    });
    void publishLeadMessageEvent(message.leadId);
    return message;
  }
  return saveMessage(data);
}

/// Update an outbound message's delivery status from a status webhook.
export async function updateMessageStatus(
  waId: string,
  status: string,
  error?: string,
): Promise<void> {
  await prisma.message.updateMany({ where: { waId }, data: { status, error } });
  // Push the sent→delivered→read tick to any open chat window (§realtime).
  const row = await prisma.message.findFirst({ where: { waId }, select: { leadId: true } });
  if (row) void publishLeadMessageEvent(row.leadId);
}

type SendOpts = {
  /// true = system/AI-sent (automated outreach); false/omitted = manual agent send.
  automated?: boolean;
  /// agent email for manual sends (shown in the thread; null for automated).
  sentBy?: string;
  /// true = a MEDICAL CARE message, not marketing (§post-sales check-ins). Care
  /// messages are governed by CLINICAL consent, so they are exempt from the
  /// `optedOut` marketing suppression — a patient who unsubscribed from promotions
  /// still gets their day-7 post-op check-in. An explicit `consentClinical === false`
  /// still refuses. Only lib/postSales/ sets this; nothing else should.
  clinical?: boolean;
};

/// Log a blocked/undelivered outbound so it's VISIBLE in the thread instead of
/// silently vanishing (e.g. a chatbot reply that couldn't go out because the 24h
/// window was closed). Returns the standard error result.
async function logBlocked(
  leadId: string,
  type: string,
  body: string,
  error: string,
  opts: SendOpts,
): Promise<{ ok: false; error: string }> {
  await saveMessage({
    leadId, direction: "outbound", type, body,
    status: "failed", error,
    automated: opts.automated ?? false, sentBy: opts.sentBy,
  }).catch(() => {});
  return { ok: false, error };
}

/// Send a free-form text to a lead and log it. Enforces the 24h window — returns
/// an error result (no send) if the window is closed; use a template instead.
export async function sendLeadText(
  leadId: string,
  body: string,
  opts: SendOpts = {},
): Promise<{ ok: true; message: Message } | { ok: false; error: string }> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false, error: "Lead not found" };
  if (lead.optedOut) return { ok: false, error: "Lead has opted out of messaging" };
  if (!(await isServiceWindowOpen(leadId))) {
    return logBlocked(leadId, "text", body, "Outside the 24h window — needs an approved template", opts);
  }

  const res = await sendWhatsAppText(lead.phone, body);
  const message = await saveMessage({
    leadId,
    direction: "outbound",
    waId: res.ok ? res.waId : undefined,
    type: "text",
    body,
    status: res.ok ? "sent" : "failed",
    error: res.ok ? undefined : res.error,
    automated: opts.automated ?? false,
    sentBy: opts.sentBy,
  });
  if (!res.ok) {
    logger.error(`WhatsApp text to lead ${leadId} failed: ${res.error}`);
    return { ok: false, error: res.error };
  }
  return { ok: true, message };
}

/// Send a PDF (or other document) to a lead over WhatsApp and log it. Like free
/// text this is a session message — enforces the 24h window. Uploads the bytes to
/// Meta, then sends by media id.
export async function sendLeadDocument(
  leadId: string,
  file: { buffer: Buffer; filename: string; mime?: string },
  caption?: string,
  opts: SendOpts & {
    /// Approved document-header template used to send PROACTIVELY when the 24h
    /// window is closed. Omit to require an open window (fails otherwise).
    fallbackTemplate?: { name: string; lang: string; bodyParams?: string[] };
  } = {},
): Promise<{ ok: true; message: Message } | { ok: false; error: string }> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false, error: "Lead not found" };
  if (lead.optedOut) return { ok: false, error: "Lead has opted out of messaging" };

  const windowOpen = await isServiceWindowOpen(leadId);
  if (!windowOpen && !opts.fallbackTemplate) {
    return { ok: false, error: "Outside the 24h window — an approved document template is needed to send proactively" };
  }

  const mediaId = await uploadWhatsAppMedia(file.buffer, file.mime ?? "application/pdf", file.filename);
  if (!mediaId) return { ok: false, error: "Could not upload the document to WhatsApp" };

  // Inside the window → plain document message; outside → approved template.
  const res = windowOpen
    ? await sendWhatsAppDocument(lead.phone, mediaId, file.filename, caption)
    : await sendWhatsAppDocumentTemplate(
        lead.phone,
        opts.fallbackTemplate!.name,
        opts.fallbackTemplate!.lang,
        mediaId,
        file.filename,
        opts.fallbackTemplate!.bodyParams,
      );

  const message = await saveMessage({
    leadId,
    direction: "outbound",
    waId: res.ok ? res.waId : undefined,
    type: windowOpen ? "document" : "template",
    body: caption ? `[document] ${file.filename} — ${caption}` : `[document] ${file.filename}`,
    templateName: windowOpen ? undefined : opts.fallbackTemplate!.name,
    status: res.ok ? "sent" : "failed",
    error: res.ok ? undefined : res.error,
    automated: opts.automated ?? false,
    sentBy: opts.sentBy,
  });
  if (!res.ok) {
    logger.error(`WhatsApp document to lead ${leadId} failed: ${res.error}`);
    return { ok: false, error: res.error };
  }
  return { ok: true, message };
}

/// Send interactive reply buttons to a lead and log it (chatbot runtime, Phase 3).
/// 24h-window only, like free text.
export async function sendLeadButtons(
  leadId: string,
  text: string,
  buttons: { id: string; title: string }[],
  opts: SendOpts = {},
): Promise<{ ok: true; message: Message } | { ok: false; error: string }> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false, error: "Lead not found" };
  if (lead.optedOut) return { ok: false, error: "Lead has opted out of messaging" };
  if (!(await isServiceWindowOpen(leadId)))
    return logBlocked(leadId, "interactive", `${text}  [${buttons.map((x) => x.title).join(" / ")}]`, "Outside the 24h window — needs an approved template", opts);

  const res = await sendWhatsAppButtons(lead.phone, text, buttons);
  const message = await saveMessage({
    leadId, direction: "outbound", waId: res.ok ? res.waId : undefined,
    type: "interactive", body: `${text}  [${buttons.map((b) => b.title).join(" / ")}]`,
    status: res.ok ? "sent" : "failed", error: res.ok ? undefined : res.error,
    automated: opts.automated ?? true, sentBy: opts.sentBy,
  });
  return res.ok ? { ok: true, message } : { ok: false, error: res.error };
}

/// Send an interactive list to a lead and log it (chatbot runtime). 24h-window only.
export async function sendLeadList(
  leadId: string,
  text: string,
  buttonText: string,
  rows: { id: string; title: string; description?: string }[],
  opts: SendOpts = {},
): Promise<{ ok: true; message: Message } | { ok: false; error: string }> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false, error: "Lead not found" };
  if (lead.optedOut) return { ok: false, error: "Lead has opted out of messaging" };
  if (!(await isServiceWindowOpen(leadId)))
    return logBlocked(leadId, "interactive", `${text}  [list: ${rows.map((r) => r.title).join(", ")}]`, "Outside the 24h window — needs an approved template", opts);

  const res = await sendWhatsAppList(lead.phone, text, buttonText, rows);
  const message = await saveMessage({
    leadId, direction: "outbound", waId: res.ok ? res.waId : undefined,
    type: "interactive", body: `${text}  [list: ${rows.map((r) => r.title).join(", ")}]`,
    status: res.ok ? "sent" : "failed", error: res.ok ? undefined : res.error,
    automated: opts.automated ?? true, sentBy: opts.sentBy,
  });
  return res.ok ? { ok: true, message } : { ok: false, error: res.error };
}

/// Send an image (by link) to a lead and log it (chatbot runtime). 24h-window only.
export async function sendLeadImage(
  leadId: string,
  url: string,
  caption: string | undefined,
  opts: SendOpts = {},
): Promise<{ ok: true; message: Message } | { ok: false; error: string }> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false, error: "Lead not found" };
  if (lead.optedOut) return { ok: false, error: "Lead has opted out of messaging" };
  if (!(await isServiceWindowOpen(leadId)))
    return logBlocked(leadId, "image", caption ? `[image] ${caption}` : "[image]", "Outside the 24h window — needs an approved template", opts);

  const res = await sendWhatsAppImageLink(lead.phone, url, caption);
  const message = await saveMessage({
    leadId, direction: "outbound", waId: res.ok ? res.waId : undefined,
    type: "image", body: caption ? `[image] ${caption}` : "[image]",
    status: res.ok ? "sent" : "failed", error: res.ok ? undefined : res.error,
    automated: opts.automated ?? true, sentBy: opts.sentBy,
  });
  return res.ok ? { ok: true, message } : { ok: false, error: res.error };
}

/// Send an approved template to a lead and log it. Templates may be sent any time
/// (they're how you re-open a closed window / start business-initiated outreach).
export async function sendLeadTemplate(
  leadId: string,
  templateName: string,
  languageCode = "en_US",
  components?: unknown[],
  opts: SendOpts = {},
): Promise<{ ok: true; message: Message } | { ok: false; error: string }> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false, error: "Lead not found" };
  // A clinical care message is exempt from the marketing opt-out (§post-sales), but
  // never from clinical consent being explicitly withheld.
  if (opts.clinical) {
    if (lead.consentClinical === false)
      return { ok: false, error: "Clinical consent withheld — care messages are not permitted" };
  } else if (lead.optedOut) {
    return { ok: false, error: "Lead has opted out of messaging" };
  }

  const res = await sendWhatsAppTemplate(lead.phone, templateName, languageCode, components);
  // Log what the PATIENT actually received — the approved body with its {{n}}
  // variables filled in — not just the template's internal name. `templateName`
  // is kept alongside it so the thread can still label the bubble. Falls back to
  // the name when the template can't be resolved (WABA down / not approved).
  const rendered = await renderTemplateBody(
    templateName,
    languageCode,
    extractBodyParams(components),
  ).catch(() => null);

  const message = await saveMessage({
    leadId,
    direction: "outbound",
    waId: res.ok ? res.waId : undefined,
    type: "template",
    body: rendered ?? `[template] ${templateName}`,
    templateName,
    status: res.ok ? "sent" : "failed",
    error: res.ok ? undefined : res.error,
    automated: opts.automated ?? true,
    sentBy: opts.sentBy,
  });
  if (!res.ok) {
    logger.error(`WhatsApp template "${templateName}" to lead ${leadId} failed: ${res.error}`);
    return { ok: false, error: res.error };
  }
  return { ok: true, message };
}
