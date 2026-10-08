import { intakeContext } from "@/lib/scheduling/intake/service";
import { IntakeFormView } from "@/components/scheduling/IntakeFormView";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your health form — Cara Clinic", robots: { index: false, follow: false } };

// The pre-consultation intake form (§2.7) — public, from the link in the booking
// confirmation. Nothing about the patient is shown until they've proved it's them with
// a code to the mobile on file.
export default async function IntakePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await intakeContext(token);
  return (
    <main className="min-h-screen bg-cara-page px-4 py-8">
      <div className="mx-auto max-w-xl space-y-5">
        <div className="text-[20px] font-semibold text-cara-ink" style={{ fontFamily: "var(--font-serif)" }}>Cara Clinic</div>
        {"error" in ctx ? (
          <div className="cara-card p-5 text-[15px]">{ctx.error}</div>
        ) : ctx.submitted ? (
          <div className="cara-card p-5 text-[15px]">Your health form is complete — thank you. See you at your appointment.</div>
        ) : (
          <IntakeFormView token={token} formName={ctx.formName} phoneTail={ctx.phone.slice(-4)} startAt={ctx.startAt} service={ctx.service} branch={ctx.branch} />
        )}
      </div>
    </main>
  );
}
