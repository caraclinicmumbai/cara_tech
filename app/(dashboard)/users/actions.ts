"use server";

// Admin actions: manage staff logins (users + roles + rep links) and the sales-rep
// roster. Every action re-checks the caller's capability (server functions are
// reachable via direct POST). User ops need `users.manage` (CRM Admin); roster ops
// need `reps.manage` (Branch Manager / Sales Head / CRM Admin).
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { hashPassword } from "@/lib/password";
import { isRole } from "@/lib/rbac";
import { SPECIALITIES, isSpeciality } from "@/lib/specialities";
import { logger } from "@/lib/logger";

type Result = { ok: boolean; error?: string };

function normEmail(v: string): string {
  return v.trim().toLowerCase();
}

/// Create a staff login. Optionally links to a sales-rep identity.
export async function createUser(input: {
  email: string;
  name?: string;
  password: string;
  role: string;
  salesRepId?: string | null;
}): Promise<Result> {
  await requireCapability("users.manage");
  const email = normEmail(input.email);
  if (!email || !email.includes("@")) return { ok: false, error: "Valid email required" };
  if (!isRole(input.role)) return { ok: false, error: "Invalid role" };
  if (!input.password || input.password.length < 8)
    return { ok: false, error: "Password must be at least 8 characters" };

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) return { ok: false, error: "A user with that email already exists" };

  // A rep can be linked to only one login (salesRepId is unique).
  if (input.salesRepId) {
    const taken = await prisma.user.findFirst({
      where: { salesRepId: input.salesRepId },
      select: { id: true },
    });
    if (taken) return { ok: false, error: "That sales rep is already linked to another login" };
  }

  await prisma.user.create({
    data: {
      email,
      name: input.name?.trim() || null,
      role: input.role,
      passwordHash: hashPassword(input.password),
      salesRepId: input.salesRepId || null,
    },
  });
  logger.info(`User ${email} created (${input.role})`);
  revalidatePath("/users");
  return { ok: true };
}

export async function setUserRole(userId: string, role: string): Promise<Result> {
  const me = await requireCapability("users.manage");
  if (!isRole(role)) return { ok: false, error: "Invalid role" };

  // Don't let the last CRM Admin be demoted (or you'd lock everyone out of admin).
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!target) return { ok: false, error: "User not found" };
  if (target.role === "crm_admin" && role !== "crm_admin") {
    const admins = await prisma.user.count({ where: { role: "crm_admin" } });
    if (admins <= 1) return { ok: false, error: "Can't demote the last CRM Admin" };
    if (me.id === userId) return { ok: false, error: "You can't demote yourself" };
  }

  await prisma.user.update({ where: { id: userId }, data: { role } });
  revalidatePath("/users");
  return { ok: true };
}

export async function setUserRep(userId: string, salesRepId: string | null): Promise<Result> {
  await requireCapability("users.manage");
  if (salesRepId) {
    const taken = await prisma.user.findFirst({
      where: { salesRepId, NOT: { id: userId } },
      select: { id: true },
    });
    if (taken) return { ok: false, error: "That rep is already linked to another login" };
  }
  await prisma.user.update({ where: { id: userId }, data: { salesRepId: salesRepId || null } });
  revalidatePath("/users");
  return { ok: true };
}

/// Set a staff login's home branch (§branches) — a quote they raise inherits it.
export async function setUserBranch(userId: string, branchId: string | null): Promise<Result> {
  await requireCapability("users.manage");
  await prisma.user.update({ where: { id: userId }, data: { branchId: branchId || null } });
  revalidatePath("/users");
  return { ok: true };
}

/// Set a sales rep's home branch (§branches) — used later for branch-scoped routing.
export async function setRepBranch(repId: string, branchId: string | null): Promise<Result> {
  await requireCapability("reps.manage");
  await prisma.salesRep.update({ where: { id: repId }, data: { branchId: branchId || null } });
  revalidatePath("/users");
  return { ok: true };
}

export async function resetUserPassword(userId: string, password: string): Promise<Result> {
  await requireCapability("users.manage");
  if (!password || password.length < 8)
    return { ok: false, error: "Password must be at least 8 characters" };
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: hashPassword(password) } });
  logger.info(`Password reset for user ${userId}`);
  revalidatePath("/users");
  return { ok: true };
}

export async function deleteUser(userId: string): Promise<Result> {
  const me = await requireCapability("users.manage");
  if (me.id === userId) return { ok: false, error: "You can't delete your own login" };
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!target) return { ok: false, error: "User not found" };
  if (target.role === "crm_admin") {
    const admins = await prisma.user.count({ where: { role: "crm_admin" } });
    if (admins <= 1) return { ok: false, error: "Can't delete the last CRM Admin" };
  }
  await prisma.user.delete({ where: { id: userId } });
  revalidatePath("/users");
  return { ok: true };
}

// ── Sales-rep roster ────────────────────────────────────────────────

/// Add a sales-rep identity (assignable owner / handover + click-to-call target).
export async function createRep(input: {
  name: string;
  phone: string;
  slackUserId?: string;
  salesHead?: boolean;
  speciality?: string;
}): Promise<Result> {
  await requireCapability("reps.manage");
  const name = input.name?.trim();
  const phone = input.phone?.trim();
  if (!name) return { ok: false, error: "Name required" };
  if (!phone) return { ok: false, error: "Phone (E.164) required" };
  const speciality = input.speciality?.trim() || "";
  if (speciality && !isSpeciality(speciality)) {
    return { ok: false, error: `Speciality must be one of: ${SPECIALITIES.join(", ")}` };
  }
  await prisma.salesRep.create({
    data: {
      name,
      phone,
      slackUserId: input.slackUserId?.trim() || null,
      salesHead: !!input.salesHead,
      speciality: speciality || null,
      active: true,
    },
  });
  logger.info(`Sales rep ${name} created`);
  revalidatePath("/users");
  return { ok: true };
}

export async function setRepActive(repId: string, active: boolean): Promise<Result> {
  await requireCapability("reps.manage");
  await prisma.salesRep.update({ where: { id: repId }, data: { active } });
  revalidatePath("/users");
  return { ok: true };
}

export async function setRepSalesHead(repId: string, salesHead: boolean): Promise<Result> {
  await requireCapability("reps.manage");
  await prisma.salesRep.update({ where: { id: repId }, data: { salesHead } });
  revalidatePath("/users");
  return { ok: true };
}

/// Set a rep's speciality/skill (§presence) — an offline counsellor's leads prefer a
/// colleague with the same speciality. One of SPECIALITIES; blank = generalist.
/// Validated here as well as in the dropdown: the action is reachable by direct POST.
export async function setRepSpeciality(repId: string, speciality: string): Promise<Result> {
  await requireCapability("reps.manage");
  const value = speciality.trim();
  if (value && !isSpeciality(value)) {
    return { ok: false, error: `Speciality must be one of: ${SPECIALITIES.join(", ")}` };
  }
  await prisma.salesRep.update({
    where: { id: repId },
    data: { speciality: value || null },
  });
  revalidatePath("/users");
  return { ok: true };
}
