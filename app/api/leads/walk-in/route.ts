// Walk-in / front-desk lead entry. (§3.1.1, §3.1.13)
// Session-gated (front-desk staff must be logged in). Consent (iPad/written) is
// mandatory and captured here BEFORE the record is created. ingestLead() routes
// walk-ins to manual follow-up and never triggers an AI call.
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { requireSession } from "@/lib/apiAuth";
import { walkInSchema } from "@/lib/contracts";
import { ingestLead } from "@/lib/leadIntake";

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const parsed = walkInSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Attribute the consent to the logged-in staff member who captured it.
  const session = await auth();
  const consentBy = session?.user?.email ?? "unknown";

  const { lead } = await ingestLead({
    name: parsed.data.name,
    phone: parsed.data.phone,
    email: parsed.data.email,
    interest: parsed.data.interest,
    source: "walk_in",
    consentMethod: parsed.data.consentMethod,
    consentAt: new Date(),
    consentBy,
  });

  return NextResponse.json({ leadId: lead.id, status: lead.status }, { status: 201 });
}
