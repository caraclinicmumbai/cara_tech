import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { getBoolSetting, ALLOW_UNINVOICED_CONVERSION } from "@/lib/settings";
import { SettingToggle } from "@/components/SettingToggle";
import { StagesSetup } from "@/components/StagesSetup";
import { setAllowUninvoicedConversion } from "./actions";

export const dynamic = "force-dynamic";

// Admin operating switches (§settings) — the rules the clinic changes as the business
// changes. Deliberately NOT a home for secrets or deployment config: those stay in the
// environment, where a redeploy is the right amount of friction. What belongs here is
// a decision the person running the clinic makes, like "billing is live now".

export default async function SettingsPage() {
  await requireCapability("settings.manage");
  const [allowUninvoiced, types] = await Promise.all([
    getBoolSetting(ALLOW_UNINVOICED_CONVERSION),
    prisma.appointmentType.findMany({
      where: { active: true },
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        category: true,
        stages: { orderBy: [{ active: "desc" }, { order: "asc" }], select: { id: true, label: true, role: true, tone: true, active: true } },
      },
    }),
  ]);

  return (
    <div className="space-y-6">
      <header className="cara-sec-hd">
        <div className="cara-eyebrow">Admin</div>
        <h1 className="cara-title">Settings</h1>
        <p className="cara-note mt-1">
          Operating rules the clinic controls. Every change is written to the audit log.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="cara-eyebrow">Quotes &amp; billing</h2>

        <SettingToggle
          label="Accept conversions without an invoice"
          onLabel="Allowed"
          offLabel="Invoice required"
          checked={allowUninvoiced}
          action={setAllowUninvoicedConversion}
          description={
            <>
              A quote normally converts because <strong>billing raised an invoice for it</strong> —
              that&rsquo;s what makes the branch credit a fact rather than something someone typed.
              Until the billing system is connected to the CRM, nothing sends those invoices, so
              this switch lets counsellors mark a quote Converted on their own.
              <br />
              <br />
              While it&rsquo;s <strong>allowed</strong>: the conversion is recorded as uninvoiced in
              the audit log, and the credit goes to the branch that raised the quote — a branch that
              disagrees still has the 7-day dispute.
              <br />
              <br />
              <strong>Turn this off the day billing is wired up</strong>, and conversion goes back to
              meaning a real invoice exists. Admins can always record an invoice by hand in the
              meantime, which converts the quote properly.
            </>
          }
        />
      </section>

      <section className="space-y-3">
        <h2 className="cara-eyebrow">Appointment stages</h2>
        <p className="cara-note">
          Break each consultation or treatment into the steps of the visit. Each step names the role
          that does it and has its own colour. On the day, the step shows on the appointment card,
          and anyone in that role ticks it off. To add a consultation or treatment, use{" "}
          <Link href="/appointments/setup?tab=types" className="tone-link">Scheduling setup → Appointment types</Link>.
        </p>
        <StagesSetup types={types} />
      </section>

      <p className="cara-note text-[12px] text-cara-faint">
        Integration keys, provider credentials and queue tuning stay in the deployment environment
        rather than here.
      </p>
    </div>
  );
}
