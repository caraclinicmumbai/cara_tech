# Flow 13 — Database backups

**What it is for.** Every lead, quote, call record, WhatsApp thread and audit entry the
clinic has lives in one Postgres database on Railway. Until this existed there was no
copy of it anywhere: a dropped table, a bad migration, a billing lapse or a compromised
account and the CRM's entire history was gone with no way back. This takes a copy every
day, keeps a year of them, and puts them somewhere Railway cannot reach.

Related: [gaps-and-roadmap.md](../gaps-and-roadmap.md) O1.

---

## The shape of it

One dump a day, at **`BACKUP_HOUR_IST`** (default 02:00 IST — after the do-not-call
window shuts, before the desk starts). That single object is the day's backup. On
**Sunday** it is also copied into `weekly/`, on the **1st** into `monthly/` — copied
server-side in the bucket, so a week's copy costs a copy rather than dumping the
database a second time. Each tier is then pruned to its own retention:

| Tier | Written | Kept | Env |
|---|---|---|---|
| `daily/` | every day | 7 | `BACKUP_KEEP_DAILY` |
| `weekly/` | Sundays | 5 | `BACKUP_KEEP_WEEKLY` |
| `monthly/` | the 1st | 12 | `BACKUP_KEEP_MONTHLY` |

Grandfather-father-son, and the reason for it is that **not every disaster announces
itself**. Ransomware and a bad migration are noticed the same day; a subtly corrupted
column, a bad backfill or a deletion nobody reported can take weeks to surface. Seven
dailies alone would already have rotated past it. A year of month-ends is what makes
that recoverable.

Dates are **IST calendar dates**, not UTC: a dump taken at 02:00 IST is 20:30 the
previous day in UTC, and naming it with the wrong day makes every conversation about
"Tuesday's backup" ambiguous.

## Where it goes

An **S3-compatible bucket** — the clinic uses Cloudflare R2, but nothing in the code
knows that, so the same four variables point at Backblaze B2, AWS S3 or MinIO.

It is deliberately **not** Railway. A backup that lives inside the platform it protects
is not a backup: a suspended account or a deleted project takes the database and its
copies in one motion. Railway's own Postgres snapshots are worth switching on as well —
they restore faster and are one click — but as the second line, not the only one.

**Nothing is backed up until `BACKUP_S3_*` is set.** The presence of a bucket is the
on-switch; there is no separate enable flag, which is what keeps a developer's machine
from needing any of it.

## Encryption

The dump is every patient's name, phone number, treatment interest and call transcript
in a single file, leaving the platform for a third party's storage. With
**`BACKUP_ENCRYPTION_KEY`** set (32 bytes, `openssl rand -hex 32`), the object is
AES-256-GCM encrypted before it is uploaded — a leaked bucket token then yields
ciphertext, and the clinic holds the only key.

Format is `CARABK1` · IV(12) · ciphertext · GCM tag(16). The tag is only known once the
last byte is encrypted, so it is appended rather than prefixed, which is why decryption
holds a trailing 16-byte window back. A truncated or tampered object fails at `final()`
rather than yielding plausible-looking garbage.

> ⚠️ **Losing the key makes every backup unreadable.** Store it where it outlives the
> laptop that generated it — and not *only* in Railway, since the scenario the backups
> exist for is the one where Railway is gone. It is optional for exactly this reason:
> an unencrypted backup you can read beats an encrypted one you cannot.

## Two dump modes, and why

Railway builds this repo with **Railpack**, whose image ships Node and not the Postgres
client tools. So `pg_dump` exists on the worker only if somebody sets
`RAILPACK_DEPLOY_APT_PACKAGES=postgresql-client-17` on the service — one console field
away from being forgotten.

- **`pg_dump`** (preferred) — custom-format archive, restored with `pg_restore`. Schema
  and data together, the real thing. Used whenever `pg_dump` is present and at least as
  new as the server (it refuses to dump a newer one).
- **portable** (fallback) — gzipped NDJSON this repo writes itself, one row per line via
  Postgres's own `row_to_json`, so types survive: `bytea` as `\x…`, timestamps as ISO,
  `Decimal` unrounded — none of which holds if JavaScript does the serialising. Every
  table is read inside **one repeatable-read transaction**, because a dump where a lead
  exists and the call that created it does not is not a consistent copy. It ends with a
  footer naming the row count, and a restore refuses a file that lacks it — which is how
  a half-uploaded object gets caught.

The portable dump carries **no schema**: restore runs `prisma migrate deploy` against
the target first, which makes the repo the source of truth for structure.

Every run reports which mode it used, and running on the fallback is called out in Slack
*every time* so it cannot quietly become the permanent state.

## What a run actually does

1. Pick a mode (`chooseMode` — is `pg_dump` there, and is it new enough?).
2. Dump → gzip (portable only; `pg_dump` compresses itself) → encrypt, all streamed, so
   a dump larger than the worker's memory never has to fit in it.
3. Upload to `daily/<IST date>.<ext>`.
4. **Read it back.** `headObject` re-reads the object and the run fails unless it exists,
   is over 1 KB, and holds exactly the number of bytes that were sent. An upload that
   reports success and stores nothing is precisely the failure a backup system exists to
   rule out.
5. Copy into `weekly/` and `monthly/` when the day calls for it.
6. Prune each tier past its retention.
7. Report.

## Alerts

Failures **always** post to Slack — `BACKUP_ALERT_CHANNEL`, falling back to
`CRM_ADMIN_CHANNEL` and then the branch manager's channel. Successes stay **quiet**
unless `BACKUP_REPORT_SUCCESS` is set, because a daily "all fine" is a message people
learn to scroll past, and this is one that has to be read. Two things break that silence
whatever the setting: running on the portable fallback, and storing unencrypted.

`scripts/preflight.ts` reports the same picture on demand, including **freshness** — a
configured bucket with nothing recent in it reads as ❌, since "set up" and "working" are
not the same claim.

## Restoring

The half everyone skips and then discovers, at the worst possible moment, does not work.

```bash
npm run backup:list                        # what is in the bucket
npm run backup:verify -- <key>             # download, decrypt, read it end to end
npm run backup:restore -- <key> <db-url>   # write it into a database
```

`verify` is the one to run on a schedule you keep: it proves the object downloads, the
key decrypts it and the archive is complete, without touching any database. A `key` that
names a file on disk is read from disk, for when the object was already pulled down.

**Restore never falls back to `DATABASE_URL`.** The target is a required argument,
because the difference between restoring into a scratch database and overwriting
production should not be one forgotten flag.

Restoring the portable dump runs inside **one transaction** with
`session_replication_role = replica`: rows arrive in table order rather than dependency
order, so foreign keys have to stand down, and a failure halfway rolls back rather than
leaving the database half-populated — the worst possible state to find one in. That
setting needs a privileged role; Railway's Postgres user has it.

### Runbook — the database is gone

1. Create a new Postgres (Railway, or anywhere) and get its connection URL.
2. `npm run backup:list` → pick the newest good key.
3. `npm run backup:verify -- <key>` → do not skip this; a corrupt archive found now is
   an inconvenience, found after the switchover it is the incident.
4. If the key ends `.ndjson.gz(.enc)`: `DATABASE_URL=<new> npx prisma migrate deploy`.
5. `npm run backup:restore -- <key> <new-url>`.
6. Point `DATABASE_URL` on the web **and** worker services at the new database; Railway
   redeploys both. The app must restart to pick it up.
7. Check `npm run preflight` and the lead count against what the last digest reported.

## What is not backed up

- **Call recordings** live on Twilio and **WhatsApp media** on Meta — hosted already,
  and Meta's expire in ~30 days regardless. Transcripts *are* in the database, so what
  was said survives; the audio does not.
- **Redis** — queues and rate-limit counters, all rebuildable. A restored CRM starts
  with an empty queue, which loses in-flight retry schedules but nothing durable.
- **Environment variables and secrets.** They are in the Railway console and nowhere
  else, which is its own gap — see [deferred-todo.md](../deferred-todo.md).

## Files

- `lib/backup/index.ts` — the run: tiers, retention, verification, alerts, the cron job
- `lib/backup/dump.ts` — `pg_dump` and the portable fallback, mode selection
- `lib/backup/storage.ts` — S3-compatible put / copy / list / head / delete
- `lib/backup/crypto.ts` — AES-256-GCM streaming encryption
- `scripts/runBackup.ts` — `npm run backup:now`
- `scripts/restoreBackup.ts` — list / verify / restore
- `workers/callQueueWorker.ts` — registers and processes the daily job

| Env | Default | |
|---|---|---|
| `BACKUP_S3_ENDPOINT` / `_BUCKET` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | — | all four required; absent = backups off |
| `BACKUP_S3_REGION` | `auto` | R2 ignores it; real S3 does not |
| `BACKUP_S3_PREFIX` | `cara` | key prefix inside the bucket |
| `BACKUP_HOUR_IST` | `2` | hour of the daily run |
| `BACKUP_KEEP_DAILY` / `_WEEKLY` / `_MONTHLY` | 7 / 5 / 12 | retention per tier |
| `BACKUP_ENCRYPTION_KEY` | — | 32 bytes hex/base64; unset = stored unencrypted |
| `BACKUP_ALERT_CHANNEL` | `CRM_ADMIN_CHANNEL` → branch manager | where alerts land |
| `BACKUP_REPORT_SUCCESS` | — | set to post on success too |
| `BACKUP_TX_TIMEOUT_MS` | 900000 | portable dump's transaction budget |
| `RESTORE_TX_TIMEOUT_MS` | 1800000 | restore's transaction budget |
