"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { verifyIntakeField } from "@/app/(dashboard)/appointments/intake/actions";

/// Mark one patient-reported intake answer verified (§2.7) — or undo it.
export function VerifyToggle({ responseId, field, verified }: { responseId: string; field: string; verified: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      className="cara-btn"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await verifyIntakeField(responseId, field, !verified);
          router.refresh();
        })
      }
    >
      {verified ? "Undo" : "Confirm"}
    </button>
  );
}
