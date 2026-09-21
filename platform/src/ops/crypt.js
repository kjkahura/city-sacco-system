'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const zlib = require('zlib');

/**
 * At-rest encryption for backup files.
 *
 * AES-256-GCM, key derived per file with scrypt from a random salt, so two
 * dumps encrypted with the same master key share no key material. GCM gives
 * authentication as well as confidentiality: a dump that has been altered
 * on disk or in transit fails to decrypt rather than restoring silently
 * corrupted data.
 *
 * Streamed throughout. A SACCO's dump can be gigabytes and must never be
 * held in memory.
 *
 * Key rotation: BACKUP_ENCRYPTION_KEY is the key new backups are written
 * with. BACKUP_ENCRYPTION_KEYS_OLD holds retired keys, newline or comma
 * separated, so dumps taken before a rotation still restore. Each file
 * records which key id encrypted it, so decryption picks the right one
 * instead of guessing.
 *
 * File layout (v2):
 *   magic "SACCOBK2" (8) | keyIdLen (1) | keyId (n) | salt (16) | iv (12)
 *   | ciphertext... | tag (16)
 *
 * v1 files ("SACCOBK1", no key id) are still readable: every known key is
 * tried in turn, which is what makes rotation possible without a flag day.
 */

const MAGIC = Buffer.from('SACCOBK2', 'utf8');
const MAGIC_V1 = Buffer.from('SACCOBK1', 'utf8');   // pre key-ring files
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Short stable id for a key, so a file can say which one encrypted it. */
const keyId = (k) => crypto.createHash('sha256').update(k).digest('hex').slice(0, 8);

function currentKey() {
  const k = process.env.BACKUP_ENCRYPTION_KEY;
  if (!k) {
    throw Object.assign(
      new Error('BACKUP_ENCRYPTION_KEY is not set; refusing to write an unencrypted offsite backup'),
      { status: 500 }
    );
  }
  if (Buffer.from(k, 'utf8').length < 32) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be at least 32 bytes; generate with: openssl rand -base64 48');
  }
  return k;
}

/** Current key first, then any retired keys that older dumps still need. */
function keyRing() {
  const ring = [];
  const cur = process.env.BACKUP_ENCRYPTION_KEY;
  if (cur) ring.push(cur);
  const old = process.env.BACKUP_ENCRYPTION_KEYS_OLD || '';
  for (const k of old.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)) {
    if (!ring.includes(k)) ring.push(k);
  }
  return ring;
}

const deriveFrom = (material, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(material, salt, KEY_LEN, SCRYPT, (e, key) => (e ? reject(e) : resolve(key)));
});

const derive = (salt) => deriveFrom(currentKey(), salt);

/** Compress then encrypt. gzip first, because ciphertext does not compress. */
async function encryptFile(inPath, outPath) {
  const material = currentKey();
  const id = Buffer.from(keyId(material), 'utf8');
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = await deriveFrom(material, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const out = fs.createWriteStream(outPath);
  out.write(MAGIC);
  out.write(Buffer.from([id.length]));
  out.write(id);
  out.write(salt);
  out.write(iv);

  await pipeline(fs.createReadStream(inPath), zlib.createGzip({ level: 6 }), cipher, out, { end: false });

  const tag = cipher.getAuthTag();
  await new Promise((resolve, reject) => out.end(tag, (e) => (e ? reject(e) : resolve())));

  const { size } = fs.statSync(outPath);
  return { path: outPath, bytes: size, keyId: id.toString('utf8') };
}

/** Read the header without decrypting, so tooling can report key usage. */
function inspect(inPath) {
  const size = fs.statSync(inPath).size;
  const fd = fs.openSync(inPath, 'r');
  const head = Buffer.alloc(64);
  fs.readSync(fd, head, 0, Math.min(64, size), 0);
  fs.closeSync(fd);
  if (head.subarray(0, 8).equals(MAGIC_V1)) return { version: 1, keyId: null, size };
  if (!head.subarray(0, 8).equals(MAGIC)) return { version: null, keyId: null, size };
  const n = head[8];
  return { version: 2, keyId: head.subarray(9, 9 + n).toString('utf8'), size };
}

async function decryptFile(inPath, outPath) {
  const { size } = fs.statSync(inPath);
  const meta = inspect(inPath);
  if (!meta.version) throw new Error('not a SACCO backup file (bad magic)');

  const headerLen = meta.version === 1
    ? MAGIC_V1.length + SALT_LEN + IV_LEN
    : MAGIC.length + 1 + meta.keyId.length + SALT_LEN + IV_LEN;
  if (size < headerLen + TAG_LEN) throw new Error('backup file is too small to be valid');

  const fd = fs.openSync(inPath, 'r');
  const header = Buffer.alloc(headerLen);
  fs.readSync(fd, header, 0, headerLen, 0);
  const tag = Buffer.alloc(TAG_LEN);
  fs.readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
  fs.closeSync(fd);

  const saltStart = headerLen - SALT_LEN - IV_LEN;
  const salt = header.subarray(saltStart, saltStart + SALT_LEN);
  const iv = header.subarray(saltStart + SALT_LEN, headerLen);

  const ring = keyRing();
  if (!ring.length) {
    throw Object.assign(new Error('no backup keys configured (BACKUP_ENCRYPTION_KEY)'), { status: 500 });
  }
  // A v2 file names its key, so try that one first and skip the rest.
  const candidates = meta.keyId
    ? [...ring.filter((k) => keyId(k) === meta.keyId), ...ring.filter((k) => keyId(k) !== meta.keyId)]
    : ring;

  let lastErr = null;
  for (const material of candidates) {
    const key = await deriveFrom(material, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const body = fs.createReadStream(inPath, { start: headerLen, end: size - TAG_LEN - 1 });
    try {
      await pipeline(body, decipher, zlib.createGunzip(), fs.createWriteStream(outPath));
      return { path: outPath, bytes: fs.statSync(outPath).size, keyId: keyId(material) };
    } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(outPath); } catch {}
    }
  }
  if (lastErr && (/auth/i.test(lastErr.message) || /unable to authenticate/i.test(lastErr.message))) {
    throw new Error(
      `backup failed authentication with all ${candidates.length} configured key(s): `
      + 'wrong key, or the file has been altered'
      + (meta.keyId ? ` (file was written with key ${meta.keyId})` : ''));
  }
  throw lastErr || new Error('decryption failed');
}

const isConfigured = () => Boolean(process.env.BACKUP_ENCRYPTION_KEY);

/** Re-encrypt a file with the current key. Used by backup rekey. */
async function rekeyFile(inPath) {
  const tmp = `${inPath}.plain-${Date.now()}`;
  const out = `${inPath}.rekey-${Date.now()}`;
  try {
    const before = inspect(inPath);
    await decryptFile(inPath, tmp);
    const enc = await encryptFile(tmp, out);
    // Verify before replacing. Never swap a good file for an unverified one.
    const probe = `${out}.probe`;
    await decryptFile(out, probe);
    if (fs.statSync(probe).size !== fs.statSync(tmp).size) {
      throw new Error('rekey round trip size mismatch');
    }
    fs.unlinkSync(probe);
    fs.renameSync(out, inPath);
    return { path: inPath, fromKeyId: before.keyId, toKeyId: enc.keyId, bytes: fs.statSync(inPath).size };
  } finally {
    for (const f of [tmp, out, `${out}.probe`]) { try { fs.unlinkSync(f); } catch {} }
  }
}

module.exports = {
  encryptFile, decryptFile, rekeyFile, inspect, isConfigured,
  keyRing, keyId, currentKey, MAGIC, MAGIC_V1,
};
