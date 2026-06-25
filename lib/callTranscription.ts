// Transcribe + CQS-score a recorded human-handover call (§3.1).
//
// AI calls arrive with a transcript already (ElevenLabs post-call webhook), so
// they're scored inline at intake. Human-handover calls only have a Twilio
// recording — this turns that recording into a transcript (ElevenLabs Scribe),
// scores it (Claude / scoreCQS), and writes both back onto the Call.
//
// Best-effort and self-contained: every step degrades to a no-op on failure so a
// missing transcript or unfunded API key never throws into the webhook.
import { prisma } from "@/lib/prisma";
import { fetchTwilioRecording } from "@/lib/providers/twilio";
import { transcribeAudio } from "@/lib/providers/elevenlabs";
import { scoreCQS } from "@/lib/cqs";
import { logger } from "@/lib/logger";

/// Download the recording, transcribe it, score it, and persist transcript + CQS
/// onto the call. Fire-and-forget from the webhook (don't block Twilio's
/// callback): it can take 30–90s for a long call.
export async function transcribeAndScoreCall(
  callId: string,
  recordingUrl: string,
): Promise<void> {
  try {
    const audio = await fetchTwilioRecording(recordingUrl);
    if (!audio) {
      logger.warn(`Transcription: could not fetch recording for call ${callId}`);
      return;
    }

    const transcript = await transcribeAudio(audio.buffer);
    if (!transcript) {
      logger.warn(`Transcription: empty/failed transcript for call ${callId}`);
      return;
    }

    const scored = await scoreCQS(transcript);
    await prisma.call.update({
      where: { id: callId },
      data: {
        transcript,
        cqs: scored?.cqs,
        cqsBreakdown: scored?.breakdown,
      },
    });
    logger.info(
      `Transcribed + scored handover call ${callId} (CQS ${scored?.cqs ?? "n/a"}, ${transcript.length} chars)`,
    );
  } catch (err) {
    logger.error(`transcribeAndScoreCall failed for ${callId}: ${String(err)}`);
  }
}
