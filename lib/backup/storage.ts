// Off-platform storage for database backups (§backups).
//
// S3-compatible on purpose. The clinic uses Cloudflare R2, but nothing here knows
// that — the same four variables point at Backblaze B2, AWS S3 or MinIO, so the
// destination can change without touching the backup logic.
//
// **Why not Railway's own snapshots.** A backup that lives inside the platform it
// protects is not a backup: a suspended account, a billing lapse or a deleted project
// takes the database and its copies together. Railway's snapshots are worth having as
// well; they are not worth having instead.
import {
  S3Client,
  CopyObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "stream";
import { logger } from "@/lib/logger";

export type BackupObject = { key: string; size: number; modified: Date };

/// Everything the uploader needs. Absent until the clinic configures a bucket, which
/// is what keeps backups a no-op on a developer's machine.
export type StorageConfig = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
};

export function storageConfig(): StorageConfig | null {
  const endpoint = process.env.BACKUP_S3_ENDPOINT?.trim();
  const bucket = process.env.BACKUP_S3_BUCKET?.trim();
  const accessKeyId = process.env.BACKUP_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.BACKUP_S3_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    // R2 ignores the region but the SDK insists on one; "auto" is what Cloudflare
    // documents. S3 proper needs the real region.
    region: process.env.BACKUP_S3_REGION?.trim() || "auto",
    prefix: (process.env.BACKUP_S3_PREFIX?.trim() || "cara").replace(/^\/+|\/+$/g, ""),
  };
}

export function isBackupConfigured(): boolean {
  return storageConfig() !== null;
}

function client(cfg: StorageConfig): S3Client {
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // R2 and most S3-compatibles serve the bucket as a path, not a subdomain.
    forcePathStyle: true,
  });
}

/// Stream an object up. Multipart via lib-storage, so a dump larger than memory
/// never has to be buffered — the point of streaming pg_dump straight through.
export async function putStream(
  cfg: StorageConfig,
  key: string,
  body: Readable,
  contentType = "application/octet-stream",
): Promise<number> {
  const s3 = client(cfg);
  let bytes = 0;
  body.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });
  try {
    const upload = new Upload({
      client: s3,
      params: { Bucket: cfg.bucket, Key: key, Body: body, ContentType: contentType },
      queueSize: 3,
      partSize: 8 * 1024 * 1024,
    });
    await upload.done();
    return bytes;
  } finally {
    s3.destroy();
  }
}

/// Server-side copy — how a daily backup becomes that week's or month's copy without
/// dumping or uploading the database a second time.
export async function copyObject(cfg: StorageConfig, fromKey: string, toKey: string): Promise<void> {
  const s3 = client(cfg);
  try {
    await s3.send(
      new CopyObjectCommand({
        Bucket: cfg.bucket,
        // CopySource is bucket-qualified and must be URI-encoded.
        CopySource: encodeURI(`${cfg.bucket}/${fromKey}`),
        Key: toKey,
      }),
    );
  } finally {
    s3.destroy();
  }
}

export async function listObjects(cfg: StorageConfig, prefix: string): Promise<BackupObject[]> {
  const s3 = client(cfg);
  const out: BackupObject[] = [];
  try {
    let token: string | undefined;
    do {
      const res = await s3.send(
        new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) {
        if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, modified: o.LastModified ?? new Date(0) });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  } finally {
    s3.destroy();
  }
  return out;
}

export async function deleteObjects(cfg: StorageConfig, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const s3 = client(cfg);
  try {
    // DeleteObjects caps at 1000 keys per call; retention never approaches that, but
    // a first prune against a bucket someone filled by hand might.
    for (let i = 0; i < keys.length; i += 1000) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: cfg.bucket,
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) },
        }),
      );
    }
  } finally {
    s3.destroy();
  }
}

/// Read back what was just written. An upload that reports success and stored nothing
/// is the failure mode a backup system exists to rule out, so every run re-reads its
/// own object before it is called a success.
export async function headObject(cfg: StorageConfig, key: string): Promise<number | null> {
  const s3 = client(cfg);
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
    return res.ContentLength ?? null;
  } catch (err) {
    logger.error(`Backup: could not read back ${key}: ${String(err)}`);
    return null;
  } finally {
    s3.destroy();
  }
}

export async function getObjectStream(cfg: StorageConfig, key: string): Promise<Readable> {
  const s3 = client(cfg);
  const res = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  if (!res.Body) throw new Error(`Backup object ${key} has no body`);
  return res.Body as Readable;
}
