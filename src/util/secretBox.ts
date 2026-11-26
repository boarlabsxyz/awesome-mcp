// Application-level encryption at rest for stored credentials: users' OAuth
// tokens (Google, Slack, ClickUp, ...), OAuth client secrets, API keys.
//
// AES-256-GCM with keys from TOKEN_ENCRYPTION_KEYS:
//
//   TOKEN_ENCRYPTION_KEYS="k2:<base64 32 bytes>,k1:<base64 32 bytes>"
//
// The FIRST key encrypts; every listed key decrypts, by the key id written into
// each value. Rotating is: put a new key first, keep the old one listed,
// restart (initDatabase re-seals every row to the first key), then drop the old
// one. Losing every key that sealed a value loses the value, so users must
// reconnect: back the keys up outside the database.
//
// Unset means no encryption and plaintext as before (a warning is logged at
// boot), so existing and dev deployments keep running. Reading is
// format-driven, not configuration-driven: a sealed value is always opened, a
// plaintext one is always returned as is, so a half-migrated table reads fine.
//
// Formats:
//   string  enc1:<kid>:<base64(iv[12] | tag[16] | ciphertext)>
//   JSONB   {"__enc": "<the string form>"}  (the column stays JSONB)

import * as crypto from 'node:crypto';

const PREFIX = 'enc1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

interface Keyring {
  active: { kid: string; key: Buffer } | null;
  byKid: Map<string, Buffer>;
}

let cached: { raw: string; ring: Keyring } | null = null;

/** Thrown when TOKEN_ENCRYPTION_KEYS is malformed: refusing is safer than guessing. */
export class SecretBoxConfigError extends Error {
  constructor(message: string) {
    super(`TOKEN_ENCRYPTION_KEYS: ${message}`);
    this.name = 'SecretBoxConfigError';
  }
}

function keyring(): Keyring {
  const raw = process.env.TOKEN_ENCRYPTION_KEYS || '';
  if (cached && cached.raw === raw) return cached.ring;
  const byKid = new Map<string, Buffer>();
  let active: Keyring['active'] = null;
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    const sep = entry.indexOf(':');
    if (sep <= 0) throw new SecretBoxConfigError(`entry "${entry.slice(0, 8)}…" is not "<kid>:<base64 key>"`);
    const kid = entry.slice(0, sep);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) throw new SecretBoxConfigError(`key id "${kid}" must be 1-32 of [A-Za-z0-9_-]`);
    const key = Buffer.from(entry.slice(sep + 1), 'base64');
    if (key.length !== 32) throw new SecretBoxConfigError(`key "${kid}" must decode to 32 bytes, got ${key.length}`);
    if (byKid.has(kid)) throw new SecretBoxConfigError(`key id "${kid}" is listed twice`);
    byKid.set(kid, key);
    active ??= { kid, key };
  }
  const ring = { active, byKid };
  cached = { raw, ring };
  return ring;
}

/** True when TOKEN_ENCRYPTION_KEYS is set, i.e. writes are sealed. */
export function isEncryptionEnabled(): boolean {
  return keyring().active !== null;
}

/** The key id new values are sealed with, or null when encryption is off. */
export function activeKeyId(): string | null {
  return keyring().active?.kid ?? null;
}

/** True for a value in the sealed string form. */
export function isSealed(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** The key id a sealed string was written with. */
export function sealedKeyId(value: string): string | null {
  if (!isSealed(value)) return null;
  const end = value.indexOf(':', PREFIX.length);
  return end > 0 ? value.slice(PREFIX.length, end) : null;
}

/** Seal a string with the active key; returns it unchanged when encryption is off. */
export function sealString(plain: string): string {
  const { active } = keyring();
  if (!active) return plain;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', active.key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${active.kid}:${Buffer.concat([iv, tag, ct]).toString('base64')}`;
}

/** Open a sealed string; a plaintext one is returned as is. Throws on an unknown key or tampering. */
export function openString(value: string): string {
  if (!isSealed(value)) return value;
  const end = value.indexOf(':', PREFIX.length);
  if (end < 0) throw new Error('Sealed value is malformed.');
  const kid = value.slice(PREFIX.length, end);
  const key = keyring().byKid.get(kid);
  if (!key) {
    throw new Error(`Sealed value uses key "${kid}", which is not in TOKEN_ENCRYPTION_KEYS. Add the key back to read it.`);
  }
  const buf = Buffer.from(value.slice(end + 1), 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('Sealed value is malformed.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, IV_BYTES));
  decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
}

/** Like openString, for a value that may be null or undefined. */
export function openOptionalString<T extends string | null | undefined>(value: T): T {
  return (typeof value === 'string' ? openString(value) : value) as T;
}

/** A JSONB column's sealed form. */
export interface SealedJson {
  __enc: string;
}

export function isSealedJson(value: unknown): value is SealedJson {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && isSealed((value as SealedJson).__enc);
}

/** Seal a JSON value for a JSONB column; returns it unchanged when encryption is off. */
export function sealJson<T>(value: T): T | SealedJson {
  if (!isEncryptionEnabled() || value === null || value === undefined) return value;
  return { __enc: sealString(JSON.stringify(value)) };
}

/** Open a JSONB column value (object or its JSON text); plaintext is returned parsed, as is. */
export function openJson<T = any>(value: unknown): T {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (isSealedJson(parsed)) return JSON.parse(openString(parsed.__enc));
  return parsed as T;
}

/** The key id a JSONB value was sealed with; null when it is plaintext. */
export function sealedJsonKeyId(value: unknown): string | null {
  const parsed = typeof value === 'string' ? safeParse(value) : value;
  return isSealedJson(parsed) ? sealedKeyId(parsed.__enc) : null;
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** SHA-256 hex of a high-entropy secret, for lookups by a value we no longer store in the clear. */
export function lookupHash(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/** Generate a new key entry for TOKEN_ENCRYPTION_KEYS: `<kid>:<base64 32 bytes>`. */
export function generateKeyEntry(kid: string): string {
  return `${kid}:${crypto.randomBytes(32).toString('base64')}`;
}
