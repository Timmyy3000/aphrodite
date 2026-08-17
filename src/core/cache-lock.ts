import { constants } from 'node:fs';
import { open, readFile, unlink, rename } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AphroditeError } from './errors.js';
interface LockRecord { host: string; pid: number; startedAt: number; processStartToken?: string; acquiredAt: number; nonce: string; }
async function processStartToken(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const endOfCommand = stat.lastIndexOf(')');
    if (endOfCommand < 0) return undefined;
    return stat.slice(endOfCommand + 2).trim().split(/\s+/)[19];
  } catch { return undefined; }
}
async function isStale(record: LockRecord) {
  if (record.host !== hostname()) return false;
  if (!Number.isInteger(record.pid) || record.pid <= 0) return true;
  if (record.processStartToken) {
    const currentToken = await processStartToken(record.pid);
    if (currentToken !== undefined) return currentToken !== record.processStartToken;
  }
  try { process.kill(record.pid, 0); return false; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true;
    // EPERM means the process exists but is not inspectable by this user.
    return false;
  }
}
async function quarantineStaleLock(lockPath: string, expectedNonce: string) {
  // There is no portable compare-and-unlink primitive. Renaming the candidate
  // to a unique quarantine path makes the ownership transition atomic: only a
  // record that still has the inspected nonce is deleted. If an owner won the
  // race, preserve its record (and best-effort restore it) rather than ever
  // unlinking a path that may now belong to that owner.
  const quarantinePath = `${lockPath}.stale-${expectedNonce}-${randomUUID()}`;
  try { await rename(lockPath, quarantinePath); } catch { return false; }
  let current: Partial<LockRecord>;
  try { current = JSON.parse(await readFile(quarantinePath, 'utf8')) as Partial<LockRecord>; } catch { return false; }
  if (current.nonce !== expectedNonce) {
    try {
      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      try { await handle.writeFile(JSON.stringify(current)); } finally { await handle.close(); }
      await unlink(quarantinePath);
    } catch { /* a newer owner already recreated the lock; preserve quarantine */ }
    return false;
  }
  try { await unlink(quarantinePath); return true; } catch { return false; }
}
export async function withManifestLock<T>(lockPath: string, action: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const started = Date.now(); const nonce = randomUUID(); const owner: LockRecord = { host: hostname(), pid: process.pid, startedAt: Date.now() - Math.floor(process.uptime() * 1000), processStartToken: await processStartToken(process.pid), acquiredAt: Date.now(), nonce };
  while (true) { try { const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY); await handle.writeFile(JSON.stringify(owner)); await handle.close(); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; try { const existing = JSON.parse(await readFile(lockPath, 'utf8')) as LockRecord; if (existing.nonce && await isStale(existing)) await quarantineStaleLock(lockPath, existing.nonce); } catch { /* another owner can be replacing it */ } if (Date.now() - started >= timeoutMs) throw new AphroditeError('CACHE_BUSY', 'The Aphrodite cache manifest is busy.', { lockPath }, true); await new Promise(resolve => setTimeout(resolve, 25 + Math.floor(Math.random() * 50))); } }
  try { return await action(); } finally { try { const current = JSON.parse(await readFile(lockPath, 'utf8')) as LockRecord; if (current.nonce === nonce) await unlink(lockPath); } catch { /* cleanup is best effort */ } }
}
