import { execFile } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a program without a shell. Never throws on a nonzero exit; the caller reads `code`. */
export function exec(bin: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd: opts.cwd, env: opts.env ?? process.env, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const code = typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 127;
        resolve({ code, stdout: stdout ?? '', stderr: stderr || err.message });
      },
    );
  });
}
