// Turning a hand-typed phone number into something a carrier will actually dial.
//
// Numbers reach us in whatever shape the source produced: a web form, an ad
// platform, a receptionist typing at the desk. They're stored as given, so by the
// time we dial we may be holding "9536108238", "+91 7506452973" or worse. Twilio
// wants strict E.164 and answers a malformed destination by failing the leg, which
// on a click-to-call means the rep hears the announcement and then silence.
//
// This is an India-only clinic, so a bare 10-digit mobile has exactly one sensible
// reading (+91). Anything we can't read confidently is refused rather than guessed
// at — a mis-dialled patient is worse than a call that doesn't start.
export function dialablePhone(phone: string | null | undefined): string | null {
  const raw = (phone ?? "").trim();
  if (!raw) return null;
  const digits = raw.match(/\d/g)?.join("") ?? "";
  if (raw.startsWith("+") && digits.length >= 8) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`; // bare Indian mobile
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return null;
}

/// Numbers that pass dialablePhone but that no carrier can complete — worth catching
/// before we place a call, because Twilio's own answer is a silent failed leg.
///
/// The case seen in practice: an Indian 10-digit mobile saved with a `+1` in front
/// (`+18850925804`). It's E.164-shaped, so it looks fine, but 885 is not an
/// assignable North-American area code and Twilio rejects the dial outright
/// (error 13225). NANP area codes and exchanges both start 2–9, and the number
/// body is exactly 10 digits.
export function implausibleReason(e164: string): string | null {
  const digits = e164.replace(/\D/g, "");
  if (!digits.startsWith("1")) return null; // only NANP is checked here
  const nanp = digits.slice(1);
  if (nanp.length !== 10) return `+1 numbers must have 10 digits after the country code`;
  const areaCode = nanp.slice(0, 3);
  const exchange = nanp.slice(3, 6);
  if (areaCode[0] === "0" || areaCode[0] === "1") return `+1 ${areaCode} is not a valid area code`;
  if (exchange[0] === "0" || exchange[0] === "1") return `+1 ${areaCode} ${exchange} is not a valid exchange`;
  // A 10-digit Indian mobile (starting 6–9) prefixed with +1 lands here: the
  // area code looks valid, so only the shape of the original tips us off.
  return null;
}

/// One call: normalise, then sanity-check. Returns the dialable number or a reason
/// a human can act on ("this lead's number can't be dialled: …").
export function toDialable(
  phone: string | null | undefined,
): { ok: true; e164: string } | { ok: false; reason: string } {
  const e164 = dialablePhone(phone);
  if (!e164) {
    return {
      ok: false,
      reason: `"${(phone ?? "").trim() || "(empty)"}" isn't a number we can dial — use +91 followed by the 10-digit mobile`,
    };
  }
  const bad = implausibleReason(e164);
  if (bad) return { ok: false, reason: `${e164} can't be dialled — ${bad}` };
  return { ok: true, e164 };
}
