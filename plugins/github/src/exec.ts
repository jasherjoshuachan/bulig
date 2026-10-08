import { execFile } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the program after this many ms. The result is then a failure whose stderr says "timed out". */
  timeoutMs?: number;
  /** Ask the program to stop (SIGTERM, then SIGKILL after a short grace) when this fires. */
  signal?: AbortSignal;
}

const KILL_GRACE_MS = 2000;

/** Run a program without a shell. Never throws on a nonzero exit; the caller reads `code`. */
export function exec(bin: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    let aborted = false;
    const timers: NodeJS.Timeout[] = [];
    const child = execFile(
      bin,
      args,
      { cwd: opts.cwd, env: opts.env ?? process.env, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        for (const t of timers) clearTimeout(t);
        opts.signal?.removeEventListener('abort', onAbort);
        if (!err && !timedOut) return resolve({ code: 0, stdout, stderr });
        let code = typeof (err as { code?: unknown } | null)?.code === 'number' ? (err as { code: number }).code : 127;
        let text = stderr || err?.message || '';
        if (timedOut) {
          code = code || 124;
          text = `timed out after ${opts.timeoutMs}ms; the program was killed. ${text}`.trim();
        } else if (aborted && !stderr) text = `stopped before it finished. ${text}`.trim();
        resolve({ code, stdout: stdout ?? '', stderr: text });
      },
    );
    const stop = () => {
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      t.unref();
      timers.push(t);
    };
    function onAbort() {
      aborted = true;
      stop();
    }
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timers.push(
        setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs),
      );
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
