"use server";

// Server Actions for the WhatsApp template builder. Both hit the WABA via our
// token, so each re-checks the session (server functions are reachable directly).
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import {
  listAllTemplates,
  createTemplate,
  type WhatsAppTemplateRow,
  type CreateTemplateInput,
  type CreateTemplateResult,
} from "@/lib/whatsappTemplates";

export async function listTemplatesAction(): Promise<WhatsAppTemplateRow[]> {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
  return listAllTemplates();
}

export async function createTemplateAction(
  input: CreateTemplateInput,
): Promise<CreateTemplateResult> {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
  const res = await createTemplate(input);
  if (res.ok) revalidatePath("/templates");
  return res;
}
