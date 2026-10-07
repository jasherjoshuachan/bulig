import { homedir } from 'node:os';
import { runCli, type Io } from './commands.ts';

const cleanups = new Set<() => Promise<void> | void>();
const stoppers = new Set<() => void>();

const io: Io = {
  out: (line) => void process.stdout.write(`${line}\n`),
  err: (line) => void process.stderr.write(`${line}\n`),
  cwd: process.cwd(),
  home: homedir(),
  onInterrupt(cleanup) {
    cleanups.add(cleanup);
    return () => void cleanups.delete(cleanup);
  },
  onStop(stop) {
    stoppers.add(stop);
    return () => void stoppers.delete(stop);
  },
};

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    // A running `serve` stops itself cleanly and the process exits 0 from main().
    if (stoppers.size) {
      process.stderr.write(`\nbulig: ${sig}, stopping.\n`);
      for (const stop of [...stoppers]) stop();
      return;
    }
    process.stderr.write(`\nbulig: ${sig}, stopping. The job stays where it was; "bulig resume <jobId>" picks it up.\n`);
    for (const c of [...cleanups]) await c();
    process.exit(130);
  });
}

export async function main(argv: string[]): Promise<void> {
  const code = await runCli(argv, io);
  process.exit(code);
}
