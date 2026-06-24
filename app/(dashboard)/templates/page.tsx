import { listAllTemplates } from "@/lib/whatsappTemplates";
import { TemplateBuilder } from "@/components/TemplateBuilder";

export const dynamic = "force-dynamic";

function StatusBadge({ status }: { status: string }) {
  const s = status.toUpperCase();
  const cls =
    s === "APPROVED"
      ? "bg-green-600/15 text-green-700 dark:text-green-400"
      : s === "PENDING"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : s === "REJECTED"
          ? "bg-red-500/15 text-red-700 dark:text-red-400"
          : "bg-black/5 text-black/50 dark:bg-white/10 dark:text-white/50";
  return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{s}</span>;
}

export default async function TemplatesPage() {
  const templates = await listAllTemplates();

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h1 className="text-xl font-semibold">WhatsApp templates</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Create message templates for outreach and re-engagement. New templates are
          submitted to Meta for review and go live once <strong>Approved</strong> (usually minutes
          to a few hours).
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">New template</h2>
        <TemplateBuilder />
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Templates ({templates.length})</h2>
        <div className="overflow-x-auto rounded border border-black/10 dark:border-white/15">
          <table className="min-w-full text-sm">
            <thead className="bg-black/5 text-left dark:bg-white/10">
              <tr>
                <th className="px-4 py-2 whitespace-nowrap">Name</th>
                <th className="px-4 py-2 whitespace-nowrap">Status</th>
                <th className="px-4 py-2 whitespace-nowrap">Category</th>
                <th className="px-4 py-2 whitespace-nowrap">Lang</th>
                <th className="px-4 py-2">Body</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={`${t.name}:${t.language}`} className="border-t border-black/5 dark:border-white/10">
                  <td className="px-4 py-2 whitespace-nowrap font-medium">{t.name}</td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">{t.category}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{t.language}</td>
                  <td className="max-w-md px-4 py-2 text-black/70 dark:text-white/70">{t.bodyText}</td>
                </tr>
              ))}
              {templates.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-black/50" colSpan={5}>
                    No templates yet — create one above. (If the WABA isn&apos;t configured, this
                    list stays empty.)
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
