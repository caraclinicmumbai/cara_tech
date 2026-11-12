"use client";

// Per-row actions on the WhatsApp templates screen: Disable / Enable (CRM-side,
// reversible) and Delete (removes this language version from Meta — permanent).
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteTemplateAction, setTemplateDisabledAction } from "@/app/(dashboard)/templates/actions";

export function TemplateRowActions({
  id,
  name,
  language,
  disabled,
}: {
  id: string;
  name: string;
  language: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      <button
        disabled={pending}
        onClick={() => {
          if (
            !disabled &&
            !window.confirm(
              `Disable "${name}"? It will be hidden from the team's template pickers, and any automation (chatbot, reminders, follow-ups) that uses it will stop sending it. You can re-enable it any time.`,
            )
          )
            return;
          startTransition(async () => {
            const res = await setTemplateDisabledAction(name, !disabled);
            if (res.ok) router.refresh();
            else window.alert(res.error);
          });
        }}
        className={`${disabled ? "txt-good" : ""} rounded px-2 py-1 text-xs font-medium disabled:opacity-50`}
      >
        {disabled ? "Enable" : "Disable"}
      </button>
      {id && (
        <button
          disabled={pending}
          onClick={() => {
            if (
              !window.confirm(
                `Permanently delete "${name}" (${language}) from WhatsApp? This cannot be undone, and Meta won't let you create a new template with the same name for 30 days.`,
              )
            )
              return;
            startTransition(async () => {
              const res = await deleteTemplateAction(name, id, language);
              if (res.ok) router.refresh();
              else window.alert(res.error);
            });
          }}
          className="txt-bad rounded px-2 py-1 text-xs font-medium disabled:opacity-50"
        >
          Delete
        </button>
      )}
    </span>
  );
}
