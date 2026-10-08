import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { getBoolSetting, getNumberSetting } from "@/lib/settings";
import { SCHEDULING_TOGGLES, DEFAULT_TRAVEL_MINUTES, QUIET_END_HOUR, QUIET_START_HOUR } from "@/lib/scheduling/toggles";
import { branchWeek } from "@/lib/scheduling/hours";
import { keyOfDateColumn, minutesToHhmm } from "@/lib/scheduling/time";
import { istDateTimeLocal } from "@/lib/datetime";
import { SettingToggle } from "@/components/SettingToggle";
import { BranchHoursEditor, ClosuresEditor, TravelSetup } from "@/components/scheduling/HoursSetup";
import { ResourcesSetup } from "@/components/scheduling/ResourcesSetup";
import { TypesSetup } from "@/components/scheduling/TypesSetup";
import { FlagsSetup } from "@/components/scheduling/FlagsSetup";
import { MessagesSetup } from "@/components/scheduling/MessagesSetup";
import { IntakeFormsSetup } from "@/components/scheduling/IntakeFormsSetup";
import type { IntakeSchema } from "@/lib/scheduling/intake/schema";
import { isWhatsAppConfigured } from "@/lib/providers/whatsapp";
import { isSmsConfigured } from "@/lib/providers/sms";
import { isEmailConfigured } from "@/lib/providers/email";
import { setSchedulingToggle } from "./actions";

export const dynamic = "force-dynamic";

// Scheduling setup (§3.2) — everything the calendar needs to know before it can tell
// a free slot from a taken one: the module's switches, when each branch is open, who
// and what can be booked, what each appointment type needs, and the flags a patient
// can carry. Route-guarded to `appointments.configure`; re-checked here.

const TABS = [
  { key: "switches", label: "Switches" },
  { key: "hours", label: "Hours, holidays & travel" },
  { key: "resources", label: "Resources & rosters" },
  { key: "types", label: "Appointment types" },
  { key: "messages", label: "Messages & reminders" },
  { key: "intake", label: "Intake forms" },
  { key: "flags", label: "Patient flags" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default async function SchedulingSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await requireCapability("appointments.configure");
  const sp = await searchParams;
  const tab: TabKey = (TABS.find((t) => t.key === sp.tab)?.key ?? "switches") as TabKey;
  const branches = await prisma.branch.findMany({
    where: { active: true },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: { id: true, name: true, code: true },
  });

  return (
    <div className="space-y-6">
      <header className="cara-sec-hd">
        <div className="cara-eyebrow">Appointments</div>
        <h1 className="cara-title">Scheduling setup</h1>
        <p className="cara-note mt-1">
          What the calendar needs to know before it can tell a free slot from a taken one. Every change
          is written to the audit log.
        </p>
      </header>

      <nav className="flex flex-wrap gap-2" aria-label="Setup sections">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/appointments/setup?tab=${t.key}`}
            className={`cara-chip ${tab === t.key ? "on" : ""}`}
            aria-current={tab === t.key ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "switches" && <SwitchesTab />}
      {tab === "hours" && <HoursTab branches={branches} />}
      {tab === "resources" && <ResourcesTab branches={branches} />}
      {tab === "types" && <TypesTab branches={branches} />}
      {tab === "messages" && <MessagesTab />}
      {tab === "intake" && <IntakeTab />}
      {tab === "flags" && <FlagsTab />}
    </div>
  );
}

async function SwitchesTab() {
  const values = await Promise.all(SCHEDULING_TOGGLES.map((t) => getBoolSetting(t.key)));
  return (
    <section className="space-y-3">
      {SCHEDULING_TOGGLES.map((t, i) => (
        <SettingToggle
          key={t.key}
          label={t.label}
          description={t.description}
          checked={values[i]}
          action={setSchedulingToggle.bind(null, t.key)}
        />
      ))}
    </section>
  );
}

type BranchOpt = { id: string; name: string; code: string };

async function HoursTab({ branches }: { branches: BranchOpt[] }) {
  const [weeks, travelRows, defaultTravel] = await Promise.all([
    Promise.all(branches.map((b) => branchWeek(prisma, b.id))),
    prisma.branchTravelTime.findMany({ select: { branchAId: true, branchBId: true, minutes: true } }),
    getNumberSetting(DEFAULT_TRAVEL_MINUTES),
  ]);
  const closures = await prisma.branchClosure.findMany({
    where: { endDate: { gte: new Date(new Date().toISOString().slice(0, 10)) } },
    orderBy: { startDate: "asc" },
    include: { branch: { select: { name: true } } },
  });
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="cara-eyebrow">Weekly opening hours (IST)</h2>
        {branches.length === 0 && <p className="cara-note">Create a branch first, under Branches.</p>}
        {branches.map((b, i) => (
          <BranchHoursEditor
            key={b.id}
            branchId={b.id}
            branchName={b.name}
            configured={weeks[i].configured}
            week={weeks[i].week.map((d) => ({
              weekday: d.weekday,
              open: minutesToHhmm(d.openMin),
              close: minutesToHhmm(d.closeMin),
              closed: d.closed,
            }))}
          />
        ))}
      </section>
      <section className="space-y-3">
        <h2 className="cara-eyebrow">Holidays &amp; blackout dates</h2>
        <ClosuresEditor
          branches={branches}
          closures={closures.map((c) => ({
            id: c.id,
            branchName: c.branch?.name ?? null,
            startDate: keyOfDateColumn(c.startDate),
            endDate: keyOfDateColumn(c.endDate),
            hours: c.startMin != null && c.endMin != null ? `${minutesToHhmm(c.startMin)}–${minutesToHhmm(c.endMin)}` : null,
            reason: c.reason,
          }))}
        />
      </section>
      <section className="space-y-3">
        <h2 className="cara-eyebrow">Travel time between branches</h2>
        <TravelSetup
          branches={branches}
          defaultMinutes={defaultTravel}
          pairs={travelRows.map((t) => ({ a: t.branchAId, b: t.branchBId, minutes: t.minutes }))}
        />
      </section>
    </div>
  );
}

async function ResourcesTab({ branches }: { branches: BranchOpt[] }) {
  const [resources, users] = await Promise.all([
    prisma.resource.findMany({
      orderBy: [{ active: "desc" }, { kind: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
      include: {
        schedules: { orderBy: [{ weekday: "asc" }, { startMin: "asc" }] },
        exceptions: {
          where: { date: { gte: new Date(new Date().toISOString().slice(0, 10)) } },
          orderBy: [{ date: "asc" }, { startMin: "asc" }],
        },
        timeOff: { where: { endAt: { gt: new Date() }, status: { in: ["approved", "requested"] } }, orderBy: { startAt: "asc" } },
        user: { select: { email: true, name: true } },
      },
    }),
    prisma.user.findMany({
      where: { role: { in: ["doctor", "ot_team", "post_sales_consultant", "front_desk", "branch_manager", "crm_admin"] } },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return (
    <ResourcesSetup
      branches={branches}
      users={users.map((u) => ({ id: u.id, label: `${u.name ?? u.email} (${u.role.replace(/_/g, " ")})` }))}
      resources={resources.map((r) => ({
        id: r.id,
        kind: r.kind,
        subtype: r.subtype,
        name: r.name,
        branchId: r.branchId,
        userId: r.userId,
        userLabel: r.user ? (r.user.name ?? r.user.email) : null,
        notes: r.notes,
        active: r.active,
        allowOverride: r.allowOverride,
        roster: r.schedules.map((s) => ({
          branchId: s.branchId,
          weekday: s.weekday,
          start: minutesToHhmm(s.startMin),
          end: minutesToHhmm(s.endMin),
        })),
        exceptions: r.exceptions.map((e) => ({
          id: e.id,
          date: keyOfDateColumn(e.date),
          branchId: e.branchId,
          start: minutesToHhmm(e.startMin),
          end: minutesToHhmm(e.endMin),
          note: e.note,
        })),
        timeOff: r.timeOff.map((t) => ({
          id: t.id,
          start: istDateTimeLocal(t.startAt).replace("T", " "),
          end: istDateTimeLocal(t.endAt).replace("T", " "),
          reason: t.reason,
          source: t.status === "requested" ? "requested" : t.kind === "leave" ? t.source : t.kind,
        })),
        availableFrom: r.availableFrom ? keyOfDateColumn(r.availableFrom) : "",
        availableUntil: r.availableUntil ? keyOfDateColumn(r.availableUntil) : "",
      }))}
    />
  );
}

async function TypesTab({ branches }: { branches: BranchOpt[] }) {
  const intakeForms = await prisma.intakeForm.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const [types, resources, catalog] = await Promise.all([
    prisma.appointmentType.findMany({
      orderBy: [{ active: "desc" }, { category: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
      include: { requirements: true, catalogItem: { select: { name: true } } },
    }),
    prisma.resource.findMany({ where: { active: true }, select: { id: true, name: true, kind: true }, orderBy: { name: "asc" } }),
    prisma.catalogItem.findMany({ where: { active: true }, select: { id: true, name: true, category: true }, orderBy: [{ category: "asc" }, { name: "asc" }] }),
  ]);
  const subtypes = await prisma.resource.findMany({
    where: { subtype: { not: null } },
    distinct: ["kind", "subtype"],
    select: { kind: true, subtype: true },
  });
  return (
    <TypesSetup
      hasBranches={branches.length > 0}
      resources={resources}
      subtypes={subtypes.map((s) => ({ kind: s.kind, subtype: s.subtype as string }))}
      catalog={catalog.map((c) => ({ id: c.id, label: `${c.category} — ${c.name}` }))}
      intakeForms={intakeForms}
      types={types.map((t) => ({
        id: t.id,
        name: t.name,
        code: t.code,
        category: t.category,
        durationMin: t.durationMin,
        bufferAfterMin: t.bufferAfterMin,
        catalogItemId: t.catalogItemId,
        catalogName: t.catalogItem?.name ?? null,
        onlineBookable: t.onlineBookable,
        intakeFormId: t.intakeFormId,
        onlineAudience: t.onlineAudience,
        onlineFee: t.onlineFee,
        onlinePrepay: t.onlinePrepay,
        prepayDiscountPct: t.prepayDiscountPct,
        prepInstructions: t.prepInstructions,
        color: t.color,
        active: t.active,
        requirements: t.requirements.map((r) => ({
          kind: r.kind,
          subtype: r.subtype,
          resourceId: r.resourceId,
          quantity: r.quantity,
        })),
      }))}
    />
  );
}

async function FlagsTab() {
  const flags = await prisma.flagDefinition.findMany({
    orderBy: [{ active: "desc" }, { sortOrder: "asc" }],
    include: { _count: { select: { leadFlags: true } } },
  });
  return (
    <FlagsSetup
      flags={flags.map((f) => ({
        id: f.id,
        label: f.label,
        description: f.description,
        icon: f.icon,
        tone: f.tone,
        active: f.active,
        patients: f._count.leadFlags,
      }))}
    />
  );
}

async function MessagesTab() {
  const [templates, types, qStart, qEnd] = await Promise.all([
    prisma.appointmentMessageTemplate.findMany({ where: { active: true }, orderBy: { createdAt: "asc" } }),
    prisma.appointmentType.findMany({
      where: { active: true },
      orderBy: [{ category: "asc" }, { name: "asc" }],
      select: { id: true, name: true, selfServiceCutoffHours: true, reminderRules: { orderBy: { sortOrder: "asc" } } },
    }),
    getNumberSetting(QUIET_START_HOUR),
    getNumberSetting(QUIET_END_HOUR),
  ]);
  return (
    <MessagesSetup
      providers={{ whatsapp: isWhatsAppConfigured(), sms: isSmsConfigured(), email: isEmailConfigured() }}
      quiet={{ start: qStart, end: qEnd }}
      templates={templates.map((t) => ({
        id: t.id,
        key: t.key,
        name: t.name,
        body: t.body,
        whatsappTemplateName: t.whatsappTemplateName ?? "",
        whatsappLanguage: t.whatsappLanguage,
        whatsappParams: t.whatsappParams.join(", "),
        smsDltTemplateId: t.smsDltTemplateId ?? "",
        emailSubject: t.emailSubject ?? "",
      }))}
      types={types.map((t) => ({
        id: t.id,
        name: t.name,
        cutoffHours: t.selfServiceCutoffHours,
        rules: t.reminderRules.map((r) => ({
          kind: r.kind,
          hoursBefore: r.minutesBefore != null ? r.minutesBefore / 60 : null,
          at: r.atMin != null ? minutesToHhmm(r.atMin) : null,
          templateId: r.templateId,
          channels: r.channels,
          smsFallback: r.smsFallback,
          quietExempt: r.quietExempt,
        })),
      }))}
    />
  );
}

async function IntakeTab() {
  const forms = await prisma.intakeForm.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: {
      versions: { orderBy: { version: "desc" }, take: 1 },
      appointmentTypes: { select: { name: true } },
      _count: { select: { responses: true } },
    },
  });
  return (
    <IntakeFormsSetup
      forms={forms
        .filter((f) => f.versions[0])
        .map((f) => ({
          id: f.id,
          name: f.name,
          active: f.active,
          version: f.versions[0].version,
          schema: f.versions[0].schema as unknown as IntakeSchema,
          usedBy: f.appointmentTypes.map((t) => t.name),
          responses: f._count.responses,
        }))}
    />
  );
}
