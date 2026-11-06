"use client";

// A patient's flags on their lead page (§3.2 "Cards and Flags for a Patient"). Flags could
// only be set from an appointment card, so a patient with no appointment couldn't have one.
// Every flag the clinic has defined is shown: click to pin or unpin it. Someone who can't
// edit sees only the ones that are on.
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setLeadFlag } from "@/app/(dashboard)/leads/actions";
import { FlagGlyph } from "@/components/Icon";

export type LeadFlagOption = { id: string; label: string; description: string | null; icon: string; tone: string; on: boolean };

export function LeadFlagsField({
  leadId,
  flags,
  canEdit,
}: {
  leadId: string;
  flags: LeadFlagOption[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const shown = canEdit ? flags : flags.filter((f) => f.on);
  if (shown.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-cara-muted">Flags</span>
      {shown.map((f) =>
        canEdit ? (
          <button
            key={f.id}
            type="button"
            aria-pressed={f.on}
            disabled={pending}
            className={`tag ${f.on ? `tag-${f.tone}` : "tag-neutral opacity-70"}`}
            title={`${f.on ? "Remove" : "Mark"} ${f.label}${f.description ? ` — ${f.description}` : ""}`}
            onClick={() =>
              startTransition(async () => {
                const res = await setLeadFlag(leadId, f.id, !f.on);
                if (res.ok) router.refresh();
                else window.alert(res.error ?? "Could not update the flag");
              })
            }
          >
            <FlagGlyph icon={f.icon} className="tag-icon" />
            {f.label}
          </button>
        ) : (
          <span key={f.id} className={`tag tag-${f.tone}`} title={f.description ?? undefined}>
            <FlagGlyph icon={f.icon} className="tag-icon" />
            {f.label}
          </span>
        ),
      )}
    </div>
  );
}
