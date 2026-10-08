// Pages a PATIENT reaches without a staff login (§3.2). Each one carries its own
// credential instead — a signed, expiring token in the URL — and its own rate limits.
//   /a/<token>  the appointment link from a reminder (2.4)
// Kept in one list so the route gate (auth.ts) and anything else that needs to know
// "is this a patient-facing page" agree.
export const PUBLIC_PREFIXES = ["/a/"] as const;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}
