import { open, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** O_EXCL is cross-process. Never steal a stale lock: its owner may still be paying. */
export async function withProjectLock<T>(root: string, run: () => Promise<T>): Promise<T> {
  const path = join(await realpath(root), '.workflow.lock');
  const handle = await open(path, 'wx').catch(() => { throw new Error(`project lock unavailable: ${path}; verify the owning process has stopped before manually removing a stale lock`); });
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    return await run();
  } finally { await handle.close(); await unlink(path); }
}
