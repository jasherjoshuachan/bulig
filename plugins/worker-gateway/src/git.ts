import { spawn } from 'node:child_process';

export interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** True when the output went past `maxOut` and the command was stopped. */
  truncated: boolean;
}

/**
 * Run git with no shell and no hooks, and keep at most `maxOut` bytes of output. The environment is the process's own plus
 * `env`; global and system git config are not read, so a config on the machine cannot change what a patch does.
 */
export function git(cwd: string, args: string[], opts: { input?: Buffer; env?: NodeJS.ProcessEnv; maxOut?: number } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const maxOut = opts.maxOut ?? 16 * 1024 * 1024;
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size > maxOut) {
        if (!truncated) {
          truncated = true;
          child.kill('SIGKILL');
        }
        return;
      }
      out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString('utf8');
    });
    child.on('error', reject);
    // 'close', not 'exit': the output is all in by then.
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: stderr.trim(), truncated }));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input);
  });
}

export const text = (r: GitResult): string => (r.stderr || r.stdout.toString('utf8')).trim().slice(0, 500);
