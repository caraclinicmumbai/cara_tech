// Recording access, dispatched by the provider that MADE the recording.
//
// A recording lives on the provider that recorded it, behind that provider's credentials.
// Once calling moves to Plivo, the Twilio recordings already on file do not move with it —
// they stay on Twilio and still need Twilio auth to read or delete. A single "fetch the
// recording" cannot work that out from the URL alone, so `Call.provider` records it and
// these two helpers dispatch on it.
//
// This matters most for DELETION. Erasing a recording is how a DPDP erasure request is
// honoured (§compliance C3). Dispatching on the wrong provider means the delete quietly
// fails, the row is cleared anyway, and the audio survives on a provider nobody is looking
// at any more — the CRM reporting success while the PII it was asked to destroy is still
// there. Deletion returning `false` is therefore meaningful and callers must not ignore it.
import { fetchTwilioRecording, deleteTwilioRecording } from "@/lib/providers/twilio";
import { fetchPlivoRecording, deletePlivoRecording } from "@/lib/providers/plivo";

/// Providers that can hold a recording. Matches `Call.provider`.
export type CallProvider = "twilio" | "plivo";

/// Which provider a stored `Call.provider` value means, tolerating anything unexpected by
/// falling back to Twilio — every row written before the column existed is a Twilio row.
export function asProvider(value: string | null | undefined): CallProvider {
  return value === "plivo" ? "plivo" : "twilio";
}

/// Download a recording's audio for transcription / the in-CRM player.
export async function fetchRecording(
  recordingUrl: string,
  provider: string | null | undefined,
): Promise<{ buffer: Buffer; mime: string } | null> {
  switch (asProvider(provider)) {
    case "twilio":
      return fetchTwilioRecording(recordingUrl);
    case "plivo":
      return fetchPlivoRecording(recordingUrl);
  }
}

/// Delete a recording's audio at the provider. Returns true on success, or if it was
/// already gone. A false here means the audio still exists somewhere — treat it as a
/// failed erasure, not a tidy-up that can be skipped.
export async function deleteRecording(
  recordingUrl: string,
  provider: string | null | undefined,
): Promise<boolean> {
  switch (asProvider(provider)) {
    case "twilio":
      return deleteTwilioRecording(recordingUrl);
    case "plivo":
      // Plivo deletes its own recordings after 30 days, so an erasure request for an older
      // call finds nothing — a 404 counts as success, not as a failed erasure.
      return deletePlivoRecording(recordingUrl);
  }
}
