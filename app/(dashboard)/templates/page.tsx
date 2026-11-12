import { getDisabledTemplateNames, listAllTemplates } from "@/lib/whatsappTemplates";
import { TemplateBuilder } from "@/components/TemplateBuilder";
import { TemplateRowActions } from "@/components/TemplateRowActions";

export const dynamic = "force-dynamic";

function StatusBadge({ status }: { status: string }) {
  const s = status.toUpperCase();
  const cls =
    s === "APPROVED"
      ? "tag tag-aqua"
      : s === "PENDING"
        ? "tag tag-citric"
        : s === "REJECTED"
          ? "tag tag-tangerine"
          : "bg-black/5 text-black/50 dark:bg-white/10 dark:text-white/50";
  return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{s}</span>;
}

export default async function TemplatesPage() {
  const [templates, disabledNames] = await Promise.all([listAllTemplates(), getDisabledTemplateNames()]);
  const disabled = new Set(disabledNames);

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h1 className="text-xl font-semibold">WhatsApp templates</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Create message templates for outreach and re-engagement. New templates are
          submitted to Meta for review and go live once <strong>Approved</strong> (usually minutes
          to a few hours). <strong>Disable</strong> a template to stop the team and automations
          from sending it (you can re-enable it later); <strong>Delete</strong> removes it from
          WhatsApp for good.
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
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr
                  key={`${t.name}:${t.language}`}
                  className={`border-t border-black/5 dark:border-white/10 ${disabled.has(t.name) ? "opacity-60" : ""}`}
                >
                  <td className="px-4 py-2 whitespace-nowrap font-medium">{t.name}</td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    <StatusBadge status={t.status} />
                    {disabled.has(t.name) && (
                      <span className="ml-1 rounded-full bg-black/5 px-2 py-0.5 text-xs text-black/60 dark:bg-white/10 dark:text-white/60">
                        Disabled
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">{t.category}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{t.language}</td>
                  <td className="max-w-md px-4 py-2 text-black/70 dark:text-white/70">{t.bodyText}</td>
                  <td className="px-4 py-2">
                    <TemplateRowActions id={t.id} name={t.name} language={t.language} disabled={disabled.has(t.name)} />
                  </td>
                </tr>
              ))}
              {templates.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-black/50" colSpan={6}>
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
