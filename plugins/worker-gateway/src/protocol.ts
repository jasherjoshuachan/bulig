import { z } from 'zod';

// The wire format between a worker and the kernel (ADR 0011). JSON over HTTP. The worker never sees the database: it is told what
// to run, says it is alive, and hands back what Claude said. Every message about a running stage names the stage, its attempt
// and the lease generation, and the kernel refuses any that does not match the stage as the record has it now.

export const CLAIM_PATH = '/claim';
export const HEARTBEAT_PATH = '/heartbeat';
export const RESULT_PATH = '/result';

const id = z.string().min(1).max(100);

export const ClaimRequest = z.strictObject({
  workerId: id,
  /** How many stages the worker can run at once. The kernel never gives it more than its own cap for that worker. */
  slots: z.number().int().min(1).max(16),
  /** Repositories (paths on the kernel's machine) the worker has a copy of. Only stages of these are offered. */
  projects: z.array(z.string().min(1).max(1000)).max(200).optional(),
});
export type ClaimRequest = z.infer<typeof ClaimRequest>;

/** A stage handed to a worker. */
export interface Assignment {
  jobId: string;
  stageId: string;
  attempt: number;
  /** The lease generation the stage was claimed under. Sent back with every heartbeat and result. */
  generation: number;
  heartbeatMs: number;
  /** The largest patch the kernel will take back. A bigger one fails the stage, so the worker should not build it. */
  maxPatchBytes?: number;
  /** What to run: the same fields the in-process worker gets, minus the folder (the worker uses its own). */
  request: { stage: string; prompt: string; model: string; mode: 'readonly' | 'edit' };
  workspace: {
    /** The repository, as the kernel names it (a path on its machine). The worker maps it to its own copy. */
    repo: string;
    /** The commit the job branch grew from. The worker checks it out. */
    base: string;
    /** Work the job already holds on top of `base` (committed or not), as a git patch, base64. Absent when there is none. */
    patch?: string;
  };
}

export const HeartbeatRequest = z.strictObject({
  stageId: id,
  attempt: z.number().int().min(1),
  generation: z.number().int().min(0).optional(),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

const Evidence = z.strictObject({
  tool: z.string().max(100),
  kind: z.enum(['read', 'search', 'edit', 'run', 'other']),
  target: z.string().max(1000),
  ok: z.boolean(),
});

export const ResultRequest = z.strictObject({
  stageId: id,
  attempt: z.number().int().min(1),
  generation: z.number().int().min(0).optional(),
  outcome: z.enum(['completed', 'failed']),
  output: z.strictObject({
    result: z.string().max(4 * 1024 * 1024).optional(),
    error: z.string().max(100_000).optional(),
    costUsd: z.number().optional(),
    sessionId: z.string().max(200).optional(),
    evidence: z.array(Evidence).max(300).optional(),
  }),
  /** What an edit stage changed in the worker's folder, as a git patch, base64. */
  patch: z.string().optional(),
});
export type ResultRequest = z.infer<typeof ResultRequest>;
