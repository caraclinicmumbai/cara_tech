// Session gating for API route handlers.
// Routes under /api are NOT covered by proxy.ts (its matcher excludes `api`),
// so dashboard-facing data endpoints must check the Auth.js session themselves.
// External / automation endpoints use shared-secret or signature verification
// instead (see lib/verify.ts and the /api/intake/* adapters).
import { NextResponse } from "next/server";
import { auth } from "@/auth";

/// Returns a 401 response when there is no authenticated user session, else null.
/// Usage:  const denied = await requireSession(); if (denied) return denied;
export async function requireSession(): Promise<NextResponse | null> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
