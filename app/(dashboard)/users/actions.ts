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
import { SALES_TEAMS, SALES_TEAM_LABELS, DEFAULT_SALES_TEAM, isSalesTeam } from "@/lib/salesTeams";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { removeRep as removeRepFromRoster } from "@/lib/salesReps";
import { isAddressableSlackTarget, probeSlackTarget } from "@/lib/slack";

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
  slackChannelId?: string;
  salesHead?: boolean;
  speciality?: string;
  team?: string;
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
  const team = input.team?.trim() || DEFAULT_SALES_TEAM;
  if (!isSalesTeam(team)) return { ok: false, error: teamError };
  const slack = checkSlack(input.slackUserId, input.slackChannelId);
  if ("error" in slack) return { ok: false, error: slack.error };
  const unreachable = await proveSlack(name, slack);
  if (unreachable) return { ok: false, error: unreachable };
  await prisma.salesRep.create({
    data: {
      name,
      phone,
      ...slack,
      salesHead: !!input.salesHead,
      speciality: speciality || null,
      team,
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

const teamError = `Team must be one of: ${SALES_TEAMS.map((t) => SALES_TEAM_LABELS[t]).join(", ")}`;

/// Put a rep on the pre- or post-consultation team (lib/salesTeams.ts). Only the
/// pre-consultation team is in the automatic rota; the post-consultation team gets leads
/// by handover. Moving a rep doesn't move the leads they already own. Audited, since it
/// decides who new patients go to.
export async function setRepTeam(repId: string, team: string): Promise<Result> {
  const me = await requireCapability("reps.manage");
  if (!isSalesTeam(team)) return { ok: false, error: teamError };
  const before = await prisma.salesRep.findUnique({ where: { id: repId }, select: { team: true, name: true } });
  if (!before) return { ok: false, error: "Rep not found" };
  if (before.team === team) return { ok: true };
  await prisma.salesRep.update({ where: { id: repId }, data: { team } });
  await writeAudit({
    actorId: me.id,
    actorEmail: me.email,
    action: "rep.team",
    entityType: "rep",
    entityId: repId,
    field: "team",
    oldValue: SALES_TEAM_LABELS[isSalesTeam(before.team) ? before.team : DEFAULT_SALES_TEAM],
    newValue: SALES_TEAM_LABELS[team],
  });
  logger.info(`Sales rep ${before.name} moved to the ${team} team by ${me.email ?? "?"}`);
  revalidatePath("/users");
  return { ok: true };
}

/// A rep's Slack member id (U…, for the DM and @-mentions) and own channel (C…/G… or
/// #name, where their alerts go when set), trimmed, blank = none — or why they won't work.
function checkSlack(
  userId: string | undefined,
  channelId: string | undefined,
): { slackUserId: string | null; slackChannelId: string | null } | { error: string } {
  const slackUserId = userId?.trim() || null;
  const slackChannelId = channelId?.trim() || null;
  if (slackUserId && !/^[UW][A-Z0-9]{6,}$/.test(slackUserId)) {
    return { error: "Slack member ID looks like U0123ABCD (Slack profile → ⋮ → Copy member ID)" };
  }
  if (slackChannelId && (!isAddressableSlackTarget(slackChannelId) || /^[UWD]/.test(slackChannelId))) {
    return { error: "Slack channel looks like C0123ABCD (channel details → bottom of the About tab) or #channel-name" };
  }
  return { slackUserId, slackChannelId };
}

/// Post a hello to a newly entered member id / channel, so a wrong id or a private channel
/// the bot isn't in is caught here — not weeks later as alerts quietly landing elsewhere.
async function proveSlack(
  repName: string,
  slack: { slackUserId: string | null; slackChannelId: string | null },
  before?: { slackUserId: string | null; slackChannelId: string | null },
): Promise<string | null> {
  if (slack.slackChannelId && slack.slackChannelId !== before?.slackChannelId) {
    const r = await probeSlackTarget(
      slack.slackChannelId,
      `✅ Cara CRM will post ${repName}'s lead alerts in this channel. Everyone in it will see them.`,
    );
    if (!r.ok) {
      return r.error === "channel_not_found" || r.error === "not_in_channel"
        ? `Cara can't post in ${slack.slackChannelId} (${r.error}). If it's a private channel, open it in Slack and type /invite @cara_crm, then save again. Check the ID is from the Cara CRM workspace.`
        : `Cara can't post in ${slack.slackChannelId} (${r.error})`;
    }
  }
  if (slack.slackUserId && slack.slackUserId !== before?.slackUserId) {
    const r = await probeSlackTarget(slack.slackUserId, `✅ Cara CRM has linked your Slack to ${repName}'s sales profile.`);
    if (!r.ok) return `Cara can't message ${slack.slackUserId} (${r.error}). Check the member ID is from the Cara CRM workspace.`;
  }
  return null;
}

/// Set where a rep's Slack alerts go: their member id (DM + @-mention) and, optionally,
/// their own channel (e.g. #sales_mandira) so the colleagues in it see the alerts too.
/// Audited, since it decides who sees a counsellor's leads in Slack.
export async function setRepSlack(
  repId: string,
  input: { slackUserId?: string; slackChannelId?: string },
): Promise<Result> {
  const me = await requireCapability("reps.manage");
  const slack = checkSlack(input.slackUserId, input.slackChannelId);
  if ("error" in slack) return { ok: false, error: slack.error };
  const before = await prisma.salesRep.findUnique({
    where: { id: repId },
    select: { name: true, slackUserId: true, slackChannelId: true },
  });
  if (!before) return { ok: false, error: "Rep not found" };
  if (before.slackUserId === slack.slackUserId && before.slackChannelId === slack.slackChannelId) return { ok: true };
  const unreachable = await proveSlack(before.name, slack, before);
  if (unreachable) return { ok: false, error: unreachable };
  await prisma.salesRep.update({ where: { id: repId }, data: slack });
  await writeAudit({
    actorId: me.id,
    actorEmail: me.email,
    action: "rep.slack",
    entityType: "rep",
    entityId: repId,
    field: "slack",
    oldValue: `${before.slackUserId ?? "—"} / ${before.slackChannelId ?? "—"}`,
    newValue: `${slack.slackUserId ?? "—"} / ${slack.slackChannelId ?? "—"}`,
  });
  logger.info(`Slack for rep ${before.name} set to ${slack.slackUserId ?? "—"} / ${slack.slackChannelId ?? "—"} by ${me.email ?? "?"}`);
  revalidatePath("/users");
  return { ok: true };
}

/// Remove a rep from the roster. Their leads, open quotes and pending follow-ups go to
/// `toRepId` first (lib/salesReps.ts removeRep), so nothing is left with nobody.
export async function removeRep(repId: string, toRepId: string): Promise<Result & { moved?: string }> {
  const me = await requireCapability("reps.manage");
  try {
    const n = await removeRepFromRoster({ repId, toRepId, actor: { id: me.id, email: me.email } });
    revalidatePath("/users");
    return {
      ok: true,
      moved: `${n.leads} lead${n.leads === 1 ? "" : "s"}, ${n.quotes} open quote${n.quotes === 1 ? "" : "s"}, ${n.followUps} follow-up${n.followUps === 1 ? "" : "s"}`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not remove the rep" };
  }
}
