// Client-side encryption for database backups (§backups, §compliance).
//
// The dump is every patient's name, phone, treatment interest and call transcript in
// one file, leaving the platform for a third party's bucket. Object storage encrypts
// at rest, but that key belongs to the storage provider — encrypting here means a
// leaked bucket token yields ciphertext, and the clinic holds the only key.
//
// **This is optional and defaults to off**, because a key that gets lost turns every
// backup into noise. It is only worth switching on once `BACKUP_ENCRYPTION_KEY` is
// somewhere a human can still find it after the laptop it was generated on is gone.
//
// Format: "CARABK1" (7B) · IV (12B) · ciphertext · GCM tag (16B). The tag is only
// known once the last byte is encrypted, so it is appended rather than prefixed —
// which is why decryption has to hold the final 16 bytes back (see decryptStream).
import { createCipheriv, createDecipheriv, randomBytes, type DecipherGCM } from "crypto";
import { Transform, type Readable } from "stream";

const MAGIC = Buffer.from("CARABK1");
const IV_LEN = 12;
const TAG_LEN = 16;

/// Accepts the key as 64 hex characters or 44 base64 characters — whatever the
/// generator on hand produced. Anything that isn't 32 bytes is refused rather than
/// silently padded, because a short key is a weak backup nobody would notice.
export function encryptionKey(): Buffer | null {
  const raw = process.env.BACKUP_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `BACKUP_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64); got ${key.length} bytes`,
    );
  }
  return key;
}

export function isEncryptionEnabled(): boolean {
  return encryptionKey() !== null;
}

/// Wrap a plaintext stream. Returns a stream of magic · IV · ciphertext · tag.
///
/// One Transform rather than a cipher piped into a PassThrough: a PassThrough fed by
/// `write()` in a data handler ignores what `write()` returns, so a slow upload would
/// buffer the whole dump in memory instead of pausing the dump.
export function encryptStream(source: Readable, key: Buffer): Readable {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let headerSent = false;

  const transform = new Transform({
    transform(chunk: Buffer, _enc, done) {
      try {
        if (!headerSent) {
          this.push(Buffer.concat([MAGIC, iv]));
          headerSent = true;
        }
        this.push(cipher.update(chunk));
        done();
      } catch (err) {
        done(err as Error);
      }
    },
    flush(done) {
      try {
        if (!headerSent) this.push(Buffer.concat([MAGIC, iv]));
        this.push(cipher.final());
        this.push(cipher.getAuthTag());
        done();
      } catch (err) {
        done(err as Error);
      }
    },
  });

  source.on("error", (err) => transform.destroy(err));
  return source.pipe(transform);
}

/// Reverse of the above. The GCM tag is the last 16 bytes of the object, and it is
/// needed *before* the final plaintext can be released, so this buffers a trailing
/// 16-byte window and only feeds bytes forward once they're known not to be the tag.
/// A truncated or tampered object fails at `final()` — loudly, which is the point.
export function decryptStream(source: Readable, key: Buffer): Readable {
  let header = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;
  let tail = Buffer.alloc(0);

  const transform = new Transform({
    transform(chunk: Buffer, _enc, done) {
      try {
        if (!decipher) {
          header = Buffer.concat([header, chunk]);
          if (header.length < MAGIC.length + IV_LEN) return done();
          if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
            return done(new Error("Not a Cara encrypted backup (bad magic)"));
          }
          const iv = header.subarray(MAGIC.length, MAGIC.length + IV_LEN);
          decipher = createDecipheriv("aes-256-gcm", key, iv);
          chunk = header.subarray(MAGIC.length + IV_LEN);
        }
        const buf = Buffer.concat([tail, chunk]);
        if (buf.length <= TAG_LEN) {
          tail = buf;
          return done();
        }
        tail = buf.subarray(buf.length - TAG_LEN);
        this.push(decipher.update(buf.subarray(0, buf.length - TAG_LEN)));
        done();
      } catch (err) {
        done(err as Error);
      }
    },
    flush(done) {
      try {
        if (!decipher) return done(new Error("Encrypted backup ended before its header"));
        if (tail.length !== TAG_LEN) return done(new Error("Encrypted backup is truncated"));
        decipher.setAuthTag(tail);
        this.push(decipher.final());
        done();
      } catch (err) {
        done(err as Error);
      }
    },
  });

  source.on("error", (err) => transform.destroy(err));
  return source.pipe(transform);
}
