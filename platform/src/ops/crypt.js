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
 * File layout:
 *   magic "SACCOBK1" (8) | salt (16) | iv (12) | ciphertext... | tag (16)
 */

const MAGIC = Buffer.from('SACCOBK1', 'utf8');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function masterKey() {
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

const derive = (salt) => new Promise((resolve, reject) => {
  crypto.scrypt(masterKey(), salt, KEY_LEN, SCRYPT, (e, key) => (e ? reject(e) : resolve(key)));
});

/** Compress then encrypt. gzip first, because ciphertext does not compress. */
async function encryptFile(inPath, outPath) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = await derive(salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const out = fs.createWriteStream(outPath);
  out.write(MAGIC);
  out.write(salt);
  out.write(iv);

  await pipeline(fs.createReadStream(inPath), zlib.createGzip({ level: 6 }), cipher, out, { end: false });

  const tag = cipher.getAuthTag();
  await new Promise((resolve, reject) => out.end(tag, (e) => (e ? reject(e) : resolve())));

  const { size } = fs.statSync(outPath);
  return { path: outPath, bytes: size };
}

async function decryptFile(inPath, outPath) {
  const { size } = fs.statSync(inPath);
  const headerLen = MAGIC.length + SALT_LEN + IV_LEN;
  if (size < headerLen + TAG_LEN) throw new Error('backup file is too small to be valid');

  const fd = fs.openSync(inPath, 'r');
  const header = Buffer.alloc(headerLen);
  fs.readSync(fd, header, 0, headerLen, 0);
  const tag = Buffer.alloc(TAG_LEN);
  fs.readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
  fs.closeSync(fd);

  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not a SACCO backup file (bad magic)');
  }
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = header.subarray(MAGIC.length + SALT_LEN, headerLen);

  const key = await derive(salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  // Read the ciphertext only: skip the header, stop before the tag.
  const body = fs.createReadStream(inPath, { start: headerLen, end: size - TAG_LEN - 1 });

  try {
    await pipeline(body, decipher, zlib.createGunzip(), fs.createWriteStream(outPath));
  } catch (e) {
    try { fs.unlinkSync(outPath); } catch {}
    if (/auth/i.test(e.message) || /unable to authenticate/i.test(e.message)) {
      throw new Error('backup failed authentication: wrong key, or the file has been altered');
    }
    throw e;
  }
  return { path: outPath, bytes: fs.statSync(outPath).size };
}

const isConfigured = () => Boolean(process.env.BACKUP_ENCRYPTION_KEY);

module.exports = { encryptFile, decryptFile, isConfigured, MAGIC };
