"use server";

// Server Actions for branch management (§branches). Gated to `branches.manage`
// (Admin-only by default). Creating/editing a branch sets the legal/tax/address/bank/
// QR details a quote renders for that location. The QR image itself is uploaded via
// /api/branches/[id]/qr (multipart) — kept out of these actions to avoid body limits.
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { writeAudit } from "@/lib/audit";
import { CAMPAIGNS, isCampaignType } from "@/lib/campaigns/types";
import { logger } from "@/lib/logger";

type Result = { ok: boolean; error?: string; id?: string };

// The editable fields (all optional except code + name).
export type BranchInput = {
  code: string;
  name: string;
  legalName?: string | null;
  gstin?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  pincode?: string | null;
  phone?: string | null;
  email?: string | null;
  bankAccountName?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
  bankName?: string | null;
  upiId?: string | null;
  managerId?: string | null;
  // Follow-up quiet hours (§follow-up) — IST wall-clock hours [0-23] as form strings.
  // Blank = use the global default (20:00–09:00).
  quietStartHour?: string | null;
  quietEndHour?: string | null;
};

function clean(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s.length ? s : null;
}

/// Parse a quiet-hour form field to an int hour [0-23], or null (blank/invalid = default).
function cleanHour(v: string | null | undefined): number | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
}

/// Validate + normalise the shared fields. Code is uppercased and must be short alnum.
function normalise(input: BranchInput): { ok: true; data: Prisma.BranchUncheckedCreateInput } | Result {
  const code = (input.code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(code)) return { ok: false, error: "Code must be 2–8 letters/numbers (e.g. SCZ, JUH)" };
  const name = (input.name ?? "").trim();
  if (!name) return { ok: false, error: "Branch name is required" };
  const gstin = clean(input.gstin);
  if (gstin && !/^[0-9A-Z]{15}$/.test(gstin)) return { ok: false, error: "GSTIN must be 15 characters (or leave blank)" };

  return {
    ok: true,
    data: {
      code,
      name,
      legalName: clean(input.legalName),
      gstin,
      addressLine1: clean(input.addressLine1),
      addressLine2: clean(input.addressLine2),
      city: clean(input.city),
      pincode: clean(input.pincode),
      phone: clean(input.phone),
      email: clean(input.email),
      bankAccountName: clean(input.bankAccountName),
      bankAccountNumber: clean(input.bankAccountNumber),
      bankIfsc: clean(input.bankIfsc) ? clean(input.bankIfsc)!.toUpperCase() : null,
      bankName: clean(input.bankName),
      upiId: clean(input.upiId),
      managerId: clean(input.managerId),
      quietStartHour: cleanHour(input.quietStartHour),
      quietEndHour: cleanHour(input.quietEndHour),
    },
  };
}

export async function createBranch(input: BranchInput): Promise<Result> {
  const actor = await requireCapability("branches.manage");
  const n = normalise(input);
  if (!("data" in n)) return n;
  try {
    const isFirst = (await prisma.branch.count()) === 0;
    const created = await prisma.branch.create({
      data: { ...n.data, isDefault: isFirst }, // the very first branch becomes the default
      select: { id: true },
    });
    await writeAudit({ actorId: actor.id, actorEmail: actor.email, action: "settings.branch.create", entityType: "setting", entityId: created.id, newValue: `${n.data.name} (${n.data.code})` });
    revalidatePath("/branches");
    revalidatePath("/", "layout");
    return { ok: true, id: created.id };
  } catch (err) {
    if (String(err).includes("Unique constraint")) return { ok: false, error: "That branch code is already in use" };
    logger.error(`createBranch failed: ${String(err)}`);
    return { ok: false, error: "Could not create the branch" };
  }
}

export async function updateBranch(id: string, input: BranchInput): Promise<Result> {
  const actor = await requireCapability("branches.manage");
  const n = normalise(input);
  if (!("data" in n)) return n;
  try {
    await prisma.branch.update({ where: { id }, data: n.data });
    await writeAudit({ actorId: actor.id, actorEmail: actor.email, action: "settings.branch.update", entityType: "setting", entityId: id, newValue: `${n.data.name} (${n.data.code})` });
    revalidatePath("/branches");
    return { ok: true };
  } catch (err) {
    if (String(err).includes("Unique constraint")) return { ok: false, error: "That branch code is already in use" };
    logger.error(`updateBranch failed: ${String(err)}`);
    return { ok: false, error: "Could not update the branch" };
  }
}

export async function setBranchActive(id: string, active: boolean): Promise<Result> {
  const actor = await requireCapability("branches.manage");
  const b = await prisma.branch.findUnique({ where: { id }, select: { isDefault: true } });
  if (active === false && b?.isDefault) return { ok: false, error: "Set another branch as default before deactivating this one" };
  await prisma.branch.update({ where: { id }, data: { active } });
  await writeAudit({ actorId: actor.id, actorEmail: actor.email, action: "settings.branch.update", entityType: "setting", entityId: id, field: "active", newValue: String(active) });
  revalidatePath("/branches");
  return { ok: true };
}

/// Make one branch the default (fallback). Clears the flag on all others atomically.
export async function setDefaultBranch(id: string): Promise<Result> {
  const actor = await requireCapability("branches.manage");
  const target = await prisma.branch.findUnique({ where: { id }, select: { active: true, name: true } });
  if (!target) return { ok: false, error: "Branch not found" };
  if (!target.active) return { ok: false, error: "Activate the branch before making it the default" };
  await prisma.$transaction([
    prisma.branch.updateMany({ where: { isDefault: true }, data: { isDefault: false } }),
    prisma.branch.update({ where: { id }, data: { isDefault: true } }),
  ]);
  await writeAudit({ actorId: actor.id, actorEmail: actor.email, action: "settings.branch.setDefault", entityType: "setting", entityId: id, newValue: target.name });
  revalidatePath("/branches");
  return { ok: true };
}

/// Turn a follow-up campaign on/off for a branch (§follow-up). Upserts a CampaignSetting
/// row; absence of a row means enabled, so this only writes when overriding. Audited.
export async function setCampaignEnabled(
  branchId: string,
  campaignType: string,
  enabled: boolean,
): Promise<Result> {
  const actor = await requireCapability("branches.manage");
  if (!isCampaignType(campaignType)) return { ok: false, error: "Unknown campaign" };
  const branch = await prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } });
  if (!branch) return { ok: false, error: "Branch not found" };
  await prisma.campaignSetting.upsert({
    where: { branchId_campaignType: { branchId, campaignType } },
    create: { branchId, campaignType, enabled },
    update: { enabled },
  });
  await writeAudit({
    actorId: actor.id, actorEmail: actor.email, action: "settings.campaign.toggle",
    entityType: "setting", entityId: branchId, field: campaignType,
    newValue: enabled ? "on" : "off", reason: `${CAMPAIGNS[campaignType].label} @ ${branch.name}`,
  });
  revalidatePath("/branches");
  return { ok: true };
}
