// Password hashing using Node's built-in scrypt — no extra dependency.
// Format stored in User.passwordHash: "<saltHex>:<hashHex>".
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const hash = Buffer.from(hashHex, "hex");
  const test = scryptSync(password, Buffer.from(saltHex, "hex"), 64);
  return hash.length === test.length && timingSafeEqual(hash, test);
}
