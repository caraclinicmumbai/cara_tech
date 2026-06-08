// Public website contact-form intake. No shared secret (it's called from the
// public site), so it relies on a honeypot field + optional origin allowlist.
// Consider adding rate-limiting / CAPTCHA before production.
import { NextResponse } from "next/server";
import { webFormSchema } from "@/lib/contracts";
import { ingestLead } from "@/lib/leadIntake";
import { logger } from "@/lib/logger";

function originAllowed(req: Request): boolean {
  const allow = process.env.WEB_FORM_ALLOWED_ORIGINS;
  if (!allow) return true; // not configured → allow all (dev)
  const origin = req.headers.get("origin") ?? "";
  return allow
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .includes(origin);
}

export async function POST(req: Request) {
  if (!originAllowed(req)) {
    return NextResponse.json({ error: "Origin not allowed" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = webFormSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Honeypot tripped — silently accept so bots don't learn they failed.
  if (parsed.data.company) {
    logger.warn("Web form honeypot tripped — dropping submission");
    return NextResponse.json({ ok: true }, { status: 202 });
  }

  const { lead, deduped } = await ingestLead({
    name: parsed.data.name,
    phone: parsed.data.phone,
    email: parsed.data.email,
    interest: parsed.data.interest,
    source: "web_form",
  });

  return NextResponse.json({ leadId: lead.id, deduped }, { status: deduped ? 200 : 201 });
}
