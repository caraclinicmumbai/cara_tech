"use client";

// "← Leads" on a lead page: back to the leads list with the search and filters it was
// opened from (lib/leadQueue.ts). Plain /leads on the server render and when the lead
// wasn't opened from the list.
import { useSyncExternalStore } from "react";
import Link from "next/link";
import { getLeadListHrefServerSnapshot, getLeadListHrefSnapshot, subscribeLeadQueue } from "@/lib/leadQueue";

export function BackToLeads({ className, children }: { className?: string; children: React.ReactNode }) {
  const href = useSyncExternalStore(subscribeLeadQueue, getLeadListHrefSnapshot, getLeadListHrefServerSnapshot);
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
