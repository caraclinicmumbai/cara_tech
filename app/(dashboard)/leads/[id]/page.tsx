import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const SOURCE_LABELS: Record<string, string> = {
  web_form: "Website",
  facebook: "Facebook",
  instagram: "Instagram",
  google: "Google",
  referral: "Referral",
  manual: "Manual",
  walk_in: "Walk-in",
};

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">
      {children}
    </span>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs uppercase tracking-wide text-black/40 dark:text-white/40">
        {label}
      </dt>
      <dd className="text-sm">{value || "—"}</dd>
    </div>
  );
}

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const lead = await prisma.lead.findUnique({
    where: { id },
    include: {
      calls: { orderBy: { createdAt: "desc" } },
      duplicateOf: true,
      duplicates: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!lead) notFound();

  return (
    <div className="space-y-8">
      <div>
        <Link href="/leads" className="text-sm text-black/50 hover:underline dark:text-white/50">
          ← Leads
        </Link>
      </div>

      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">{lead.name}</h1>
          <Pill>{lead.status}</Pill>
        </div>

        {lead.duplicateOf && (
          <div className="rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
            ⚠️ <span className="font-medium">Possible duplicate</span> of an existing lead —{" "}
            <Link href={`/leads/${lead.duplicateOf.id}`} className="font-medium underline">
              {lead.duplicateOf.name} ({lead.duplicateOf.phone})
            </Link>
            . No AI call was placed; review/merge before contacting.
          </div>
        )}

        {lead.duplicates.length > 0 && (
          <div className="rounded border border-black/15 bg-black/5 px-3 py-2 text-sm dark:border-white/20 dark:bg-white/5">
            {lead.duplicates.length} later enquir{lead.duplicates.length === 1 ? "y" : "ies"} matched this record:{" "}
            {lead.duplicates.map((d, i) => (
              <span key={d.id}>
                {i > 0 && ", "}
                <Link href={`/leads/${d.id}`} className="underline">
                  {d.name}
                </Link>
              </span>
            ))}
          </div>
        )}

        {lead.callbackAt && (
          <div className="rounded border border-blue-500/40 bg-blue-500/5 px-3 py-2 text-sm">
            📞 <span className="font-medium">Callback requested</span> for{" "}
            {lead.callbackAt.toLocaleString()} — auto-retries cancelled, a call is scheduled for this time.
          </div>
        )}

        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="Phone" value={lead.phone} />
          <Field label="Email" value={lead.email} />
          <Field
            label="Source"
            value={lead.source ? (SOURCE_LABELS[lead.source] ?? lead.source) : null}
          />
          <Field label="Interest" value={lead.interest} />
          <Field label="Interest level" value={lead.interestLevel} />
          <Field label="Campaign" value={lead.campaign} />
          <Field label="Ad ID" value={lead.adId} />
          <Field
            label="Callback at"
            value={lead.callbackAt ? lead.callbackAt.toLocaleString() : null}
          />
          <Field label="Created" value={lead.createdAt.toLocaleString()} />
          <Field label="Updated" value={lead.updatedAt.toLocaleString()} />
        </dl>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Calls ({lead.calls.length})</h2>

        {lead.calls.length === 0 ? (
          <p className="rounded border border-black/10 px-3 py-6 text-center text-sm text-black/50 dark:border-white/15 dark:text-white/50">
            No calls yet for this lead.
          </p>
        ) : (
          <ul className="space-y-3">
            {lead.calls.map((call) => (
              <li
                key={call.id}
                className="rounded border border-black/10 p-4 dark:border-white/15"
              >
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <span className="font-medium">{call.callType}</span>
                  <span>Outcome: {call.outcome ?? "—"}</span>
                  <span>Sentiment: {call.sentiment ?? "—"}</span>
                  <span>Duration: {call.duration ? `${call.duration}s` : "—"}</span>
                  <span className="ml-auto text-black/50 dark:text-white/50">
                    {call.createdAt.toLocaleString()}
                  </span>
                </div>

                {call.transcript ? (
                  <details className="mt-3 group">
                    <summary className="cursor-pointer text-sm text-black/60 hover:underline dark:text-white/60">
                      Transcript
                    </summary>
                    <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-black/5 p-3 text-xs leading-relaxed dark:bg-white/10">
                      {call.transcript}
                    </pre>
                  </details>
                ) : (
                  <p className="mt-3 text-xs text-black/40 dark:text-white/40">
                    No transcript captured.
                  </p>
                )}

                {call.elevenlabsId && (
                  <p className="mt-2 text-xs text-black/30 dark:text-white/30">
                    ElevenLabs ID: {call.elevenlabsId}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
