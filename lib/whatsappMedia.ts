// What a chat attachment may be (§WhatsApp attachments). Shared by the composer (to
// say no before an upload starts) and the server route (which re-checks).
//
// These are Meta's own Cloud API media rules: each WhatsApp message kind accepts a
// fixed set of file types, each with its own size cap. Anything else is refused at
// Meta's upload step with an opaque error, so we refuse it here with a clear one.
// HEIC photos and .mov videos — what an iPhone produces — are the usual casualties:
// export them as JPG / MP4, or send them as a PDF.

export type AttachmentKind = "image" | "video" | "audio" | "document";

const MB = 1024 * 1024;

const RULES: Record<AttachmentKind, { mimes: string[]; maxBytes: number }> = {
  image: { mimes: ["image/jpeg", "image/png"], maxBytes: 5 * MB },
  video: { mimes: ["video/mp4", "video/3gpp"], maxBytes: 16 * MB },
  audio: { mimes: ["audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"], maxBytes: 16 * MB },
  document: {
    mimes: [
      "application/pdf",
      "text/plain",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    maxBytes: 100 * MB,
  },
};

/// Browsers sometimes report no type (or a generic one) — fall back to the extension.
const BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  mp4: "video/mp4",
  "3gp": "video/3gpp",
  aac: "audio/aac",
  amr: "audio/amr",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  txt: "text/plain",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/// The file picker's `accept` list.
export const ATTACHMENT_ACCEPT = [
  ...Object.values(RULES).flatMap((r) => r.mimes),
  ...Object.keys(BY_EXTENSION).map((e) => `.${e}`),
].join(",");

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${Math.round(n / 1024)} KB`;
  return `${(n / MB).toFixed(1)} MB`;
}

/// Decide how a file goes out on WhatsApp, or why it can't.
export function classifyAttachment(
  filename: string,
  mime: string,
  size: number,
): { ok: true; kind: AttachmentKind; mime: string } | { ok: false; error: string } {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const known = (Object.keys(RULES) as AttachmentKind[]).some((k) => RULES[k].mimes.includes(mime));
  const type = known ? mime : BY_EXTENSION[ext];
  const kind = type
    ? (Object.keys(RULES) as AttachmentKind[]).find((k) => RULES[k].mimes.includes(type))
    : undefined;
  if (!type || !kind) {
    return {
      ok: false,
      error: `WhatsApp can't send "${filename}". Photos must be JPG or PNG, videos MP4, documents PDF / Word / Excel / PowerPoint / text.`,
    };
  }
  if (size === 0) return { ok: false, error: `"${filename}" is empty` };
  const max = RULES[kind].maxBytes;
  if (size > max) {
    return {
      ok: false,
      error: `"${filename}" is ${formatBytes(size)} — WhatsApp allows up to ${formatBytes(max)} for ${kind === "image" ? "a photo" : `a ${kind}`}.${kind === "image" ? " Save it as a PDF to send it as a document instead." : ""}`,
    };
  }
  return { ok: true, kind, mime: type };
}
