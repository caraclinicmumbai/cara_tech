// Public website contact-form intake. No shared secret (it's called from the
// public site), so it relies on a honeypot field + optional origin allowlist
// + per-IP rate limiting (below). A CAPTCHA could be added for further hardening.
import { NextResponse } from "next/server";
import { webFormSchema } from "@/lib/contracts";
import { ingestLead } from "@/lib/leadIntake";
import { logger } from "@/lib/logger";
import { rateLimit, getClientIp } from "@/lib/rateLimit";

// Public form → each accepted submission can trigger a paid outbound call.
// Two thresholds over one rolling per-IP window (§3.1):
//  • >5 submissions / 10 min → still captured, but HELD FOR REVIEW (no AI call)
//    so a human vets the burst instead of us dropping a possibly-real lead.
//  • >ABUSE_MAX → a genuine flood; reject outright to stop DB write-spam.
const RL_HOLD_THRESHOLD = 5; // hold the 6th+ submission for review
const RL_ABUSE_MAX = 50; // hard reject beyond this — clearly not a human
const RL_WINDOW_SECONDS = 600; // 10 minutes / IP

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

  const ip = getClientIp(req);
  const rl = await rateLimit(`web-form:${ip}`, RL_ABUSE_MAX, RL_WINDOW_SECONDS);
  // Reject only a genuine flood; otherwise capture and (maybe) hold for review.
  if (!rl.ok) {
    logger.warn(`Web form abuse ceiling hit for ip=${ip} — rejecting`);
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.resetSeconds) } },
    );
  }
  // count so far in this window = limit − remaining (exact while remaining > 0).
  const count = rl.limit - rl.remaining;
  const heldForReview = count > RL_HOLD_THRESHOLD;
  if (heldForReview) {
    logger.warn(`Web form burst from ip=${ip} (${count}/${RL_WINDOW_SECONDS}s) — holding lead for review`);
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
    heldForReview,
    heldReason: heldForReview
      ? `IP throttle: >${RL_HOLD_THRESHOLD} submissions in 10 min from ${ip}`
      : undefined,
  });

  return NextResponse.json({ leadId: lead.id, deduped }, { status: deduped ? 200 : 201 });
}
