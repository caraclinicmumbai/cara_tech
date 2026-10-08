import { onlineCatalog, onlineSettings, bookableDates } from "@/lib/scheduling/online";
import { otpChannelAvailable } from "@/lib/scheduling/otp";
import { getBoolSetting } from "@/lib/settings";
import { REMINDERS_ENABLED } from "@/lib/scheduling/toggles";
import { BookingWidget } from "@/components/scheduling/BookingWidget";

export const dynamic = "force-dynamic";
export const metadata = { title: "Book an appointment — Cara Clinic" };

// The online booking widget (§2.3) — public, embeddable on the clinic website via
// /book/embed.js. Patients see only online-bookable services; surgery is never one.
export default async function BookPage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]?.[0] : sp[k]) as string | undefined;
  const [settings, catalog, dates, messagesOn] = await Promise.all([onlineSettings(), onlineCatalog(), bookableDates(), getBoolSetting(REMINDERS_ENABLED)]);
  const embedded = one("embed") === "1";
  const closed = !settings.enabled || catalog.types.length === 0 || !otpChannelAvailable();

  return (
    <main className={`min-h-screen bg-cara-page px-4 ${embedded ? "py-4" : "py-8"}`}>
      <div className="mx-auto max-w-xl space-y-5">
        {!embedded && <div className="text-[22px] font-semibold text-cara-ink" style={{ fontFamily: "var(--font-serif)" }}>Cara Clinic</div>}
        {closed ? (
          <div className="cara-card p-5 text-[15px]">Online booking isn&rsquo;t available right now. Please call the clinic and we&rsquo;ll book you in.</div>
        ) : (
          <BookingWidget
            branches={catalog.branches.map((b) => ({ id: b.id, name: b.name }))}
            types={catalog.types}
            doctors={catalog.doctors.map((d) => ({ id: d.id, name: d.name }))}
            dates={dates}
            holdMinutes={settings.holdMinutes}
            initial={{ branchId: one("branch") ?? "", typeId: one("service") ?? "" }}
            utm={{ source: one("utm_source"), medium: one("utm_medium"), campaign: one("utm_campaign"), content: one("utm_content") }}
            embedded={embedded}
            messagesOn={messagesOn}
          />
        )}
      </div>
    </main>
  );
}
