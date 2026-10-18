import { pgSupport } from './pg-support.ts';

/** Vitest global setup: say once per run, in the main process, when the Postgres suites are going to skip. */
export default function setup(): void {
  if (!pgSupport.available) console.warn(`[bulig] ${pgSupport.reason}`);
}
