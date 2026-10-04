// The recording-disclosure whisper played to the PATIENT when they answer, before the two
// legs bridge (§compliance C1). Plivo fetches this via `confirmSound` on <Dial>.
//
// Unlike the other Plivo routes this one is NOT signature-gated, and that is deliberate:
// it returns a fixed sentence, takes no input, reveals nothing about any lead, and refusing
// it on a signature mismatch would mean a patient is recorded with NO disclosure — a
// compliance failure strictly worse than serving a constant string to a stranger.
import { NextResponse } from "next/server";
import { recordingWhisperPlivoXML } from "@/lib/providers/plivo";

const xml = () =>
  new NextResponse(recordingWhisperPlivoXML(), {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });

export async function POST() {
  return xml();
}
export async function GET() {
  return xml();
}
