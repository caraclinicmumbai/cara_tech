// WhatsApp conversation service (§3.1.3). One place that persists every message
// (inbound replies, automated sends, manual agent sends) against a lead so the
// profile shows ONE continuous thread, and that enforces WhatsApp's 24h
// customer-service window before a free-form text can go out.
//
// The low-level Graph API call lives in lib/providers/whatsapp.ts; this module
// adds the lead lookup + persistence + window logic on top.
import type { Message } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  sendWhatsAppText,
  sendWhatsAppTemplate,
  uploadWhatsAppMedia,
  sendWhatsAppDocument,
  sendWhatsAppDocumentTemplate,
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
  return { lead, created: true };
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
    return prisma.message.upsert({ where: { waId: input.waId }, create: data, update: {} });
  }
  return prisma.message.create({ data });
}

/// Update an outbound message's delivery status from a status webhook.
export async function updateMessageStatus(
  waId: string,
  status: string,
  error?: string,
): Promise<void> {
  await prisma.message.updateMany({ where: { waId }, data: { status, error } });
}

type SendOpts = {
  /// true = system/AI-sent (automated outreach); false/omitted = manual agent send.
  automated?: boolean;
  /// agent email for manual sends (shown in the thread; null for automated).
  sentBy?: string;
};

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
    return { ok: false, error: "Outside the 24h window — send an approved template to re-open the chat" };
  }

  const res = await sendWhatsAppText(lead.phone, body);
  const message = await prisma.message.create({
    data: {
      leadId,
      direction: "outbound",
      waId: res.ok ? res.waId : undefined,
      type: "text",
      body,
      status: res.ok ? "sent" : "failed",
      error: res.ok ? undefined : res.error,
      automated: opts.automated ?? false,
      sentBy: opts.sentBy,
    },
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

  const message = await prisma.message.create({
    data: {
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
    },
  });
  if (!res.ok) {
    logger.error(`WhatsApp document to lead ${leadId} failed: ${res.error}`);
    return { ok: false, error: res.error };
  }
  return { ok: true, message };
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
  if (lead.optedOut) return { ok: false, error: "Lead has opted out of messaging" };

  const res = await sendWhatsAppTemplate(lead.phone, templateName, languageCode, components);
  const message = await prisma.message.create({
    data: {
      leadId,
      direction: "outbound",
      waId: res.ok ? res.waId : undefined,
      type: "template",
      body: `[template] ${templateName}`,
      templateName,
      status: res.ok ? "sent" : "failed",
      error: res.ok ? undefined : res.error,
      automated: opts.automated ?? true,
      sentBy: opts.sentBy,
    },
  });
  if (!res.ok) {
    logger.error(`WhatsApp template "${templateName}" to lead ${leadId} failed: ${res.error}`);
    return { ok: false, error: res.error };
  }
  return { ok: true, message };
}
