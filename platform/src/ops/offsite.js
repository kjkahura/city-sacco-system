'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Offsite destination for encrypted backups.
 *
 * Two drivers:
 *
 *   dir       copy to another filesystem path. Real offsite when that path
 *             is an NFS mount, an attached volume, or a synced folder.
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

module.exports = { ship, fetch, list, parse };
