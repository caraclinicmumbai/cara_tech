"use server";

// Server Actions for the WhatsApp template builder. Both hit the WABA via our
// token, so each re-checks the session (server functions are reachable directly).
import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/authz";
import { writeAudit } from "@/lib/audit";
import {
  listAllTemplates,
  createTemplate,
  deleteTemplate,
  setTemplateDisabled,
  type WhatsAppTemplateRow,
  type CreateTemplateInput,
  type CreateTemplateResult,
} from "@/lib/whatsappTemplates";

export async function listTemplatesAction(): Promise<WhatsAppTemplateRow[]> {
  await requireCapability("templates.manage");
  return listAllTemplates();
}

export async function createTemplateAction(
  input: CreateTemplateInput,
): Promise<CreateTemplateResult> {
  const user = await requireCapability("templates.manage");
  const res = await createTemplate(input);
  if (res.ok) {
    await writeAudit({ actorId: user.id, actorEmail: user.email, action: "settings.template.create", entityType: "setting", entityId: res.id, newValue: `${input.name} (${input.language})` });
    revalidatePath("/templates");
  }
  return res;
}

/// Disable (or re-enable) a template in the CRM: hidden from pickers and refused at
/// send time. Every language of the name. Stays in the WABA.
export async function setTemplateDisabledAction(
  name: string,
  disabled: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireCapability("templates.manage");
  if (!name) return { ok: false, error: "No template given" };
  await setTemplateDisabled(name, disabled, user.id);
  await writeAudit({ actorId: user.id, actorEmail: user.email, action: disabled ? "settings.template.disable" : "settings.template.enable", entityType: "setting", entityId: name, newValue: disabled ? "disabled" : "enabled" });
  revalidatePath("/templates");
  return { ok: true };
}

/// Permanently delete one language version of a template from Meta.
export async function deleteTemplateAction(
  name: string,
  id: string,
  language: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireCapability("templates.manage");
  const res = await deleteTemplate(name, id);
  if (res.ok) {
    await writeAudit({ actorId: user.id, actorEmail: user.email, action: "settings.template.delete", entityType: "setting", entityId: id, oldValue: `${name} (${language})` });
    revalidatePath("/templates");
  }
  return res;
}
