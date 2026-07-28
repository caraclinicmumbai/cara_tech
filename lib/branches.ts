// Branch management (§branches). A CRM Admin creates one branch per physical clinic.
// A branch carries the legal/tax/address/bank/QR details a quote renders for THAT
// location. `isDefault` is the fallback used when a user/quote has no branch yet.
//
// Lead routing by branch is NOT wired here — round-robin stays global (lib/salesReps.ts).
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

/// The branch fields safe to send to the client (everything except the QR bytes).
export type BranchView = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  isDefault: boolean;
  legalName: string | null;
  gstin: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  upiId: string | null;
  quietStartHour: number | null;
  quietEndHour: number | null;
  hasQr: boolean;
  managerId: string | null;
  managerName: string | null;
  /// Per-campaign on/off state for this branch (campaignType → enabled). A campaign
  /// absent from the map is enabled by default (opt-out model).
  campaignSettings: Record<string, boolean>;
};

/// The subset the quote PDF needs to render a branch's identity + pay-to block.
export type BranchQuoteInfo = {
  name: string;
  legalName: string | null;
  gstin: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  upiId: string | null;
  qrImage: Buffer | null;
};

const BRANCH_SELECT = {
  id: true,
  code: true,
  name: true,
  active: true,
  isDefault: true,
  legalName: true,
  gstin: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  pincode: true,
  phone: true,
  email: true,
  bankAccountName: true,
  bankAccountNumber: true,
  bankIfsc: true,
  bankName: true,
  upiId: true,
  quietStartHour: true,
  quietEndHour: true,
  managerId: true,
} satisfies Prisma.BranchSelect;

function toView(
  b: Prisma.BranchGetPayload<{ select: typeof BRANCH_SELECT }> & {
    qrImage?: Uint8Array | null;
    manager?: { name: string | null } | null;
    campaignSettings?: { campaignType: string; enabled: boolean }[];
  },
): BranchView {
  return {
    id: b.id,
    code: b.code,
    name: b.name,
    active: b.active,
    isDefault: b.isDefault,
    legalName: b.legalName,
    gstin: b.gstin,
    addressLine1: b.addressLine1,
    addressLine2: b.addressLine2,
    city: b.city,
    pincode: b.pincode,
    phone: b.phone,
    email: b.email,
    bankAccountName: b.bankAccountName,
    bankAccountNumber: b.bankAccountNumber,
    bankIfsc: b.bankIfsc,
    bankName: b.bankName,
    upiId: b.upiId,
    quietStartHour: b.quietStartHour,
    quietEndHour: b.quietEndHour,
    hasQr: false, // set by callers that also read qrImage presence
    managerId: b.managerId,
    managerName: b.manager?.name ?? null,
    campaignSettings: Object.fromEntries((b.campaignSettings ?? []).map((s) => [s.campaignType, s.enabled])),
  };
}

/// All branches for the admin screen (active first, then by name). Includes whether a
/// QR image is present (without shipping the bytes), the manager's name, and each
/// branch's per-campaign on/off settings.
export async function listBranches(): Promise<BranchView[]> {
  const rows = await prisma.branch.findMany({
    orderBy: [{ active: "desc" }, { isDefault: "desc" }, { name: "asc" }],
    select: {
      ...BRANCH_SELECT,
      qrImage: true,
      manager: { select: { name: true } },
      campaignSettings: { select: { campaignType: true, enabled: true } },
    },
  });
  return rows.map((r) => ({ ...toView(r), hasQr: !!r.qrImage }));
}

/// The default (fallback) branch, or null if none is configured yet.
export async function getDefaultBranch(): Promise<{ id: string } | null> {
  return prisma.branch.findFirst({ where: { isDefault: true }, select: { id: true } });
}

/// Resolve which branch a user's new quote belongs to: their home branch, else the
/// default branch, else null (single-branch installs with no branch configured).
export async function branchIdForUser(userId: string | undefined | null): Promise<string | null> {
  if (userId) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { branchId: true } });
    if (u?.branchId) return u.branchId;
  }
  const def = await getDefaultBranch();
  return def?.id ?? null;
}

/// The quote-render info for a branch (incl. QR bytes), or null. Used by the PDF.
export async function getBranchQuoteInfo(branchId: string | null): Promise<BranchQuoteInfo | null> {
  if (!branchId) return null;
  const b = await prisma.branch.findUnique({
    where: { id: branchId },
    select: {
      name: true,
      legalName: true,
      gstin: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      pincode: true,
      phone: true,
      email: true,
      bankAccountName: true,
      bankAccountNumber: true,
      bankIfsc: true,
      bankName: true,
      upiId: true,
      qrImage: true,
    },
  });
  if (!b) return null;
  return { ...b, qrImage: b.qrImage ? Buffer.from(b.qrImage) : null };
}
