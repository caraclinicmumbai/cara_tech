// gzip for the portable dump (§backups). pg_dump's custom format compresses itself,
// so only the NDJSON path comes through here — where it matters, since JSON of a
// relational database compresses roughly ten to one.
import { createGzip } from "zlib";
import type { Readable } from "stream";

export function gzip(source: Readable): Readable {
  const z = createGzip({ level: 6 });
  source.on("error", (err) => z.destroy(err));
  return source.pipe(z);
}
