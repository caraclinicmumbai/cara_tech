"use server";

// Server Actions for branch management (§branches). Gated to `branches.manage`
// (Admin-only by default). Creating/editing a branch sets the legal/tax/address/bank/
// QR details a quote renders for that location. The QR image itself is uploaded via
// /api/branches/[id]/qr (multipart) — kept out of these actions to avoid body limits.
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
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
};

function clean(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s.length ? s : null;
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
    },
  };
}

export async function createBranch(input: BranchInput): Promise<Result> {
  await requireCapability("branches.manage");
  const n = normalise(input);
  if (!("data" in n)) return n;
  try {
    const isFirst = (await prisma.branch.count()) === 0;
    const created = await prisma.branch.create({
      data: { ...n.data, isDefault: isFirst }, // the very first branch becomes the default
      select: { id: true },
    });
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
  await requireCapability("branches.manage");
  const n = normalise(input);
  if (!("data" in n)) return n;
  try {
    await prisma.branch.update({ where: { id }, data: n.data });
    revalidatePath("/branches");
    return { ok: true };
  } catch (err) {
    if (String(err).includes("Unique constraint")) return { ok: false, error: "That branch code is already in use" };
    logger.error(`updateBranch failed: ${String(err)}`);
    return { ok: false, error: "Could not update the branch" };
  }
}

export async function setBranchActive(id: string, active: boolean): Promise<Result> {
  await requireCapability("branches.manage");
  const b = await prisma.branch.findUnique({ where: { id }, select: { isDefault: true } });
  if (active === false && b?.isDefault) return { ok: false, error: "Set another branch as default before deactivating this one" };
  await prisma.branch.update({ where: { id }, data: { active } });
  revalidatePath("/branches");
  return { ok: true };
}

/// Make one branch the default (fallback). Clears the flag on all others atomically.
export async function setDefaultBranch(id: string): Promise<Result> {
  await requireCapability("branches.manage");
  const target = await prisma.branch.findUnique({ where: { id }, select: { active: true } });
  if (!target) return { ok: false, error: "Branch not found" };
  if (!target.active) return { ok: false, error: "Activate the branch before making it the default" };
  await prisma.$transaction([
    prisma.branch.updateMany({ where: { isDefault: true }, data: { isDefault: false } }),
    prisma.branch.update({ where: { id }, data: { isDefault: true } }),
  ]);
  revalidatePath("/branches");
  return { ok: true };
}
