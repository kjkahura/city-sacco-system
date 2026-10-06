'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');

/**
 * Offsite destination for encrypted backups.
 *
 * Two drivers:
 *
 *   dir       copy to another filesystem path. Real offsite when that path
 *             is an NFS mount, an attached volume, or a synced folder.
 *   gcs       gcs:<bucket>[/<prefix>]: Cloud Storage with the service account the
 *             job runs as (its token from the metadata server, no SDK), for
 *             Cloud Run, whose image has no gcloud. Push only.
 *   command   shell out to whatever the operator already uses:
 *             aws s3 cp, rclone copy, gsutil, scp. The push command receives
 *             {src}, {name} and {slug}; the pull command set in
 *             BACKUP_OFFSITE_PULL receives {dest}, {name} and {slug}.
 *
 * No cloud SDK, and no hand-rolled request signing. Shipping an untested
 * SigV4 implementation into a backup path would be worse than using the
 * tool the operator has already configured and can verify themselves.
 */

function parse(target = process.env.BACKUP_OFFSITE) {
  if (!target) return null;
  if (target.startsWith('dir:')) return { driver: 'dir', dest: target.slice(4) };
  if (target.startsWith('cmd:')) return { driver: 'command', cmd: target.slice(4) };
  if (target.startsWith('gcs:')) {
    const [bucket, ...prefix] = target.slice(4).split('/');
    return { driver: 'gcs', bucket, prefix: prefix.filter(Boolean).join('/') };
  }
  // A bare path is treated as a directory, which is the common case.
  return { driver: 'dir', dest: target };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { shell: false });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0
      ? resolve({ stderr })
      : reject(new Error(`offsite command exited ${code}: ${stderr.slice(0, 400)}`))));
  });
}

async function ship(file, { target = process.env.BACKUP_OFFSITE, slug } = {}) {
  const cfg = parse(target);
  if (!cfg) return { shipped: false, reason: 'BACKUP_OFFSITE not configured' };

  const name = path.basename(file);

  if (cfg.driver === 'dir') {
    const dir = path.join(cfg.dest, slug || '');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, name);
    // Copy then rename, so a reader never sees a half-written backup.
    const tmp = `${dest}.partial`;
    await fs.promises.copyFile(file, tmp);
    await fs.promises.rename(tmp, dest);
    const { size } = fs.statSync(dest);
    if (size !== fs.statSync(file).size) throw new Error('offsite copy size mismatch');
    return { shipped: true, driver: 'dir', dest, bytes: size };
  }

  if (cfg.driver === 'gcs') {
    const objectName = [cfg.prefix, slug, name].filter(Boolean).join('/');
    const token = await metadataToken();
    const body = await fs.promises.readFile(file);
    // Create only (ifGenerationMatch=0): an object already there, from an earlier run that failed
    // part way, is kept, as a bucket with a retention policy requires.
    let res;
    try {
      res = await httpsJson({
        method: 'POST', host: 'storage.googleapis.com',
        path: `/upload/storage/v1/b/${encodeURIComponent(cfg.bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(objectName)}`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'content-length': body.length },
      }, body);
    } catch (e) {
      if (e.status === 412) return { shipped: true, driver: 'gcs', dest: `gs://${cfg.bucket}/${objectName}`, bytes: body.length, existed: true };
      throw e;
    }
    if (Number(res.size) !== body.length) throw new Error('offsite copy size mismatch');
    return { shipped: true, driver: 'gcs', dest: `gs://${cfg.bucket}/${objectName}`, bytes: body.length };
  }

  // command driver: split on whitespace, substitute placeholders.
  const parts = cfg.cmd.split(/\s+/).filter(Boolean)
    .map((a) => a.replace('{src}', file).replace('{name}', name).replace('{slug}', slug || ''));
  if (!parts.length) throw new Error('empty offsite command');
  await run(parts[0], parts.slice(1));
  return { shipped: true, driver: 'command', command: parts[0] };
}

/**
 * Pull a backup back.
 *
 * A backup you cannot retrieve is not a backup, so the command driver is
 * two-way as well: set BACKUP_OFFSITE_PULL to the inverse of your push
 * command, e.g.
 *   cmd:aws s3 cp s3://bucket/{slug}/{name} {dest}
 */
async function fetch(name, { target = process.env.BACKUP_OFFSITE,
                             pull = process.env.BACKUP_OFFSITE_PULL, slug, to } = {}) {
  const cfg = parse(target);
  if (!cfg) throw new Error('BACKUP_OFFSITE not configured');
  fs.mkdirSync(path.dirname(to), { recursive: true });

  if (cfg.driver === 'dir') {
    const src = path.join(cfg.dest, slug || '', name);
    if (!fs.existsSync(src)) throw new Error(`offsite file not found: ${src}`);
    await fs.promises.copyFile(src, to);
    return { path: to, bytes: fs.statSync(to).size, driver: 'dir' };
  }

  const pullCfg = parse(pull);
  if (!pullCfg || pullCfg.driver !== 'command') {
    throw new Error(
      'pulling with the command driver needs BACKUP_OFFSITE_PULL set to the inverse '
      + 'of your push command, e.g. cmd:aws s3 cp s3://bucket/{slug}/{name} {dest}');
  }
  const parts = pullCfg.cmd.split(/\s+/).filter(Boolean)
    .map((a) => a.replace('{dest}', to).replace('{name}', name).replace('{slug}', slug || ''));
  await run(parts[0], parts.slice(1));
  if (!fs.existsSync(to)) throw new Error(`pull command completed but ${to} was not written`);
  return { path: to, bytes: fs.statSync(to).size, driver: 'command' };
}

function list({ target = process.env.BACKUP_OFFSITE, slug } = {}) {
  const cfg = parse(target);
  if (!cfg || cfg.driver !== 'dir') return [];
  const dir = path.join(cfg.dest, slug || '');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.enc'))
    .map((f) => ({ name: f, bytes: fs.statSync(path.join(dir, f)).size }));
}

function httpsJson(opts, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...opts, timeout: 120_000 }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(Object.assign(new Error(`gcs: HTTP ${res.statusCode} ${text.slice(0, 200)}`), { status: res.statusCode }));
        try { resolve(JSON.parse(text)); } catch { reject(new Error('gcs: not JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('gcs: timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

/** The access token of the service account this runs as (Cloud Run's metadata server). */
function metadataToken() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: 'metadata.google.internal', path: '/computeMetadata/v1/instance/service-accounts/default/token',
      headers: { 'Metadata-Flavor': 'Google' }, timeout: 5000 }, (res) => {
      let t = '';
      res.on('data', (d) => { t += d; });
      res.on('end', () => { try { resolve(JSON.parse(t).access_token); } catch { reject(new Error('gcs: no token from the metadata server')); } });
    });
    req.on('timeout', () => req.destroy(new Error('gcs: the metadata server did not answer')));
    req.on('error', reject);
  });
}

module.exports = { ship, fetch, list, parse };
