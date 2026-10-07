import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';

/**
 * One Bulig process at a time per database (see ADR 0001). The lock file holds the owner's pid.
 * A lock whose owner is gone is taken over.
 */
export function acquireLock(dbPath: string): () => void {
  const path = `${dbPath}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
        throw new Error(`Another bulig process (pid ${pid}) is using ${dbPath}. Wait for it to finish.`);
      }
      rmSync(path, { force: true });
    }
  }
  throw new Error(`Could not take the lock ${path}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
