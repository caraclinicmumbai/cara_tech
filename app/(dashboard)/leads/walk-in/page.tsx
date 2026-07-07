import { WalkInForm } from "@/components/WalkInForm";

// Front-desk walk-in entry (§3.1.1). Consent is captured at the clinic and the
// lead is routed to manual follow-up — never an AI call (§3.1.2 exceptions).
// Created walk-ins appear in the main Leads list; this tab is just the entry form.
export default function WalkInPage() {
  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h1 className="text-xl font-semibold">Walk-in / front-desk entry</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Log a patient who enquired at the clinic. Collect their consent on the iPad
          or a paper form first — this record is created with consent recorded and is
          sent to the manual follow-up queue. No automated AI call is placed. The lead
          then appears in the main <span className="font-medium">Leads</span> list.
        </p>
      </section>

      <WalkInForm />
    </div>
  );
}
