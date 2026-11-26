import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import {
  SecretBoxConfigError,
  activeKeyId,
  assertEncryptionConfig,
  generateKeyEntry,
  isEncryptionEnabled,
  isSealed,
  isSealedJson,
  lookupHash,
  openJson,
  openOptionalString,
  openString,
  sealJson,
  sealString,
  sealedJsonKeyId,
  sealedKeyId,
} from '../util/secretBox.js';

const saved = { keys: process.env.TOKEN_ENCRYPTION_KEYS, seal: process.env.TOKEN_ENCRYPTION_SEAL };
afterEach(() => {
  if (saved.keys === undefined) delete process.env.TOKEN_ENCRYPTION_KEYS;
  else process.env.TOKEN_ENCRYPTION_KEYS = saved.keys;
  if (saved.seal === undefined) delete process.env.TOKEN_ENCRYPTION_SEAL;
  else process.env.TOKEN_ENCRYPTION_SEAL = saved.seal;
});

/** Keys listed AND sealing on: rollout step 3. */
function sealWith(keys: string): void {
  process.env.TOKEN_ENCRYPTION_KEYS = keys;
  process.env.TOKEN_ENCRYPTION_SEAL = 'true';
}

const K1 = generateKeyEntry('k1');
const K2 = generateKeyEntry('k2');

describe('secretBox with no keys configured', () => {
  it('is off and passes values through unchanged', () => {
    delete process.env.TOKEN_ENCRYPTION_KEYS;
    assert.equal(isEncryptionEnabled(), false);
    assert.equal(activeKeyId(), null);
    assert.equal(sealString('secret'), 'secret');
    const obj = { access_token: 'a' };
    assert.equal(sealJson(obj), obj);
    assert.equal(openString('secret'), 'secret');
    assert.deepEqual(openJson(obj), obj);
  });

  it('still refuses to open a sealed value it has no key for', () => {
    sealWith(K1);
    const sealed = sealString('secret');
    delete process.env.TOKEN_ENCRYPTION_KEYS;
    assert.throws(() => openString(sealed), /key "k1", which is not in TOKEN_ENCRYPTION_KEYS/);
  });
});

describe('secretBox with keys', () => {
  it('seals strings so the plaintext does not appear, and opens them', () => {
    sealWith(K1);
    const sealed = sealString('ya29.super-secret-token');
    assert.ok(isSealed(sealed));
    assert.ok(sealed.startsWith('enc1:k1:'));
    assert.ok(!sealed.includes('super-secret'));
    assert.equal(openString(sealed), 'ya29.super-secret-token');
  });

  it('uses a fresh IV per seal', () => {
    sealWith(K1);
    assert.notEqual(sealString('same'), sealString('same'));
  });

  it('round-trips unicode and the empty string', () => {
    sealWith(K1);
    for (const v of ['', 'ключ 🔑', 'x'.repeat(10_000)]) assert.equal(openString(sealString(v)), v);
  });

  it('seals JSON for a JSONB column and opens it, objects or their JSON text', () => {
    sealWith(K1);
    const tokens = { access_token: 'a', refresh_token: 'r', accessRules: { allowedOrgs: ['T1'] } };
    const sealed = sealJson(tokens);
    assert.ok(isSealedJson(sealed));
    assert.ok(!JSON.stringify(sealed).includes('refresh_token'), 'not even the key names leak');
    assert.deepEqual(openJson(sealed), tokens);
    assert.deepEqual(openJson(JSON.stringify(sealed)), tokens);
    assert.equal(sealedJsonKeyId(sealed), 'k1');
    assert.equal(sealedJsonKeyId(tokens), null);
  });

  it('opens plaintext as is, so a half-migrated table reads', () => {
    sealWith(K1);
    assert.equal(openString('plain-api-key'), 'plain-api-key');
    assert.deepEqual(openJson({ access_token: 'a' }), { access_token: 'a' });
    assert.deepEqual(openJson('{"access_token":"a"}'), { access_token: 'a' });
    assert.equal(openOptionalString(null), null);
    assert.equal(openOptionalString(undefined), undefined);
  });

  it('rejects a tampered ciphertext', () => {
    sealWith(K1);
    const sealed = sealString('secret');
    const body = Buffer.from(sealed.slice('enc1:k1:'.length), 'base64');
    body[body.length - 1] ^= 1;
    assert.throws(() => openString(`enc1:k1:${body.toString('base64')}`));
  });

  it('rejects a value moved under another key id', () => {
    sealWith(`${K1},${K2}`);
    const sealed = sealString('secret');
    assert.throws(() => openString(sealed.replace('enc1:k1:', 'enc1:k2:')));
  });

  it('rotates: the first key seals, every listed key opens', () => {
    sealWith(K1);
    const old = sealString('secret');
    sealWith(`${K2},${K1}`);
    assert.equal(activeKeyId(), 'k2');
    assert.equal(openString(old), 'secret');
    const fresh = sealString('secret');
    assert.equal(sealedKeyId(fresh), 'k2');
    assert.equal(sealedKeyId(old), 'k1');
  });

  it('refuses a malformed key list rather than guessing', () => {
    for (const bad of ['nokid', 'k1:' + Buffer.alloc(16).toString('base64'), 'bad id:' + Buffer.alloc(32).toString('base64'), `${K1},${K1}`]) {
      process.env.TOKEN_ENCRYPTION_KEYS = bad;
      assert.throws(() => assertEncryptionConfig(), SecretBoxConfigError, bad.slice(0, 10));
    }
  });
});

describe('secretBox rollout stages', () => {
  it('opens but never seals with keys listed and TOKEN_ENCRYPTION_SEAL unset (step 2)', () => {
    sealWith(K1);
    const sealed = sealString('secret');
    delete process.env.TOKEN_ENCRYPTION_SEAL;
    assert.equal(isEncryptionEnabled(), false);
    assert.equal(activeKeyId(), null);
    assert.equal(sealString('plain'), 'plain', 'writes stay plaintext');
    assert.deepEqual(sealJson({ a: 1 }), { a: 1 });
    assert.equal(openString(sealed), 'secret', 'reads of sealed values still work');
  });

  it('opens a value sealed with a key listed second, before that key seals anything', () => {
    sealWith(K2);
    const byK2 = sealString('secret');
    sealWith(`${K1},${K2}`);
    assert.equal(activeKeyId(), 'k1');
    assert.equal(openString(byK2), 'secret');
  });

  it('recovers a sealed object that SQL merged keys into, newer keys winning', () => {
    sealWith(K1);
    const sealed = sealJson({ access_token: 'old', refresh_token: 'r', accessRules: { allowedOrgs: ['T1'] } }) as object;
    const merged = { ...sealed, access_token: 'new' };
    assert.deepEqual(openJson(merged), { access_token: 'new', refresh_token: 'r', accessRules: { allowedOrgs: ['T1'] } });
    assert.equal(sealedJsonKeyId(merged), null, 'reported unsealed, so the backfill re-seals it');
  });

  it('validates the configuration up front', () => {
    sealWith(K1);
    assert.doesNotThrow(() => assertEncryptionConfig());
    process.env.TOKEN_ENCRYPTION_SEAL = 'yes';
    assert.throws(() => assertEncryptionConfig(), SecretBoxConfigError);
    delete process.env.TOKEN_ENCRYPTION_KEYS;
    process.env.TOKEN_ENCRYPTION_SEAL = 'true';
    assert.throws(() => assertEncryptionConfig(), /needs at least one key/);
    process.env.TOKEN_ENCRYPTION_KEYS = 'k1:c2hvcnQ=';
    assert.throws(() => assertEncryptionConfig(), /32 bytes/);
    delete process.env.TOKEN_ENCRYPTION_KEYS;
    delete process.env.TOKEN_ENCRYPTION_SEAL;
    assert.doesNotThrow(() => assertEncryptionConfig(), 'unset is valid: plaintext');
  });
});

describe('lookupHash', () => {
  it('is a stable SHA-256 hex digest, independent of the keys', () => {
    delete process.env.TOKEN_ENCRYPTION_KEYS;
    const a = lookupHash('api-key');
    process.env.TOKEN_ENCRYPTION_KEYS = K1;
    assert.equal(lookupHash('api-key'), a);
    assert.match(a, /^[0-9a-f]{64}$/);
  });
});
