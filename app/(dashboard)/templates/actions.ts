"use server";

// Server Actions for the WhatsApp template builder. Both hit the WABA via our
// token, so each re-checks the session (server functions are reachable directly).
import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/authz";
import { writeAudit } from "@/lib/audit";
import {
  listAllTemplates,
  createTemplate,
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
