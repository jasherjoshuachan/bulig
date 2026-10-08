import { z } from 'zod';

/** Major version of the plugin contract. A plugin must target the same major. */
export const SDK_VERSION = '0';

// ---------- errors ----------

export class BuligError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class UndeclaredEventError extends BuligError {}
export class UndeclaredSubscriptionError extends BuligError {}
export class CapabilityDeniedError extends BuligError {}
export class ManifestError extends BuligError {}
export class SdkVersionMismatchError extends BuligError {}
export class DuplicatePluginError extends BuligError {}

// ---------- manifest ----------

const eventType = z.string().regex(/^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/, 'event types look like "stage.started"');
// An exact type, or a prefix wildcard such as "stage.*". A bare "*" means everything.
const eventPattern = z
  .string()
  .regex(/^(\*|[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*(\.\*)?)$/, 'use an event type or a trailing wildcard like "stage.*"');
// "git.push", or a scoped one like "channel.send:owner-dm".
const capability = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+(:[a-z0-9._-]+)?$/, 'capabilities look like "git.push" or "channel.send:owner-dm"');

export const ManifestSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'name must be kebab-case'),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/, 'version must be semver'),
  sdk: z.string().regex(/^\d+$/, 'sdk is a major version string, e.g. "0"'),
  description: z.string().min(1),
  provides: z
    .object({
      stages: z.array(z.string()).default([]),
      commands: z.array(z.string()).default([]),
    })
    .default({ stages: [], commands: [] }),
  subscribes: z.array(eventPattern).default([]),
  emits: z.array(eventType).default([]),
  needs: z.array(capability).default([]),
});

export type Manifest = z.infer<typeof ManifestSchema>;
/** What a plugin author writes. Defaults fill in the rest. */
export type ManifestInput = z.input<typeof ManifestSchema>;

// ---------- event matching ----------

/** Does a subscription pattern match a concrete event type? */
export function matchesPattern(pattern: string, type: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

/** Is `requested` (exact or wildcard) allowed by one of the declared patterns? */
export function patternCovered(declared: readonly string[], requested: string): boolean {
  return declared.some((d) => {
    if (d === requested || d === '*') return true;
    if (!d.endsWith('*')) return false;
    // A declared wildcard covers anything that starts with its prefix.
    return requested.startsWith(d.slice(0, -1));
  });
}

// ---------- data ----------

export const JOB_STATUSES = ['queued', 'running', 'awaiting_approval', 'done', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const STAGE_STATUSES = ['running', 'passed', 'failed'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export interface Job {
  id: string;
  repo: string;
  title: string;
  /** The longer description of the work, such as an issue text. Empty when none was given. */
  body: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Stage {
  id: string;
  jobId: string;
  name: string;
  status: StageStatus;
  attempt: number;
  startedAt: string;
  endedAt: string | null;
  output: unknown;
}

export interface BuligEvent {
  id: string;
  /** Position in the event log. Set once the event is persisted. */
  seq?: number;
  type: string;
  jobId?: string;
  source: string;
  payload: unknown;
  at: string;
}

// ---------- plugin API ----------

/** The narrow job API a plugin gets. No raw database access. */
export interface JobsApi {
  create(input: { repo: string; title: string; body?: string }): Job;
  get(id: string): Job | undefined;
  list(filter?: { status?: JobStatus }): Job[];
  setStatus(id: string, status: JobStatus): Job;
  /** Every stage of a job, oldest first. Lets a plugin rebuild its position after a restart. */
  stages(jobId: string): Stage[];
  startStage(jobId: string, name: string): Stage;
  finishStage(stageId: string, status: Exclude<StageStatus, 'running'>, output?: unknown): Stage;
}

/**
 * A small key-value store that belongs to one plugin. Values are JSON. A plugin sees only its own keys,
 * and the values survive a restart. Use it for things like "the last update I handled".
 */
export interface StateApi {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export type EventHandler = (event: BuligEvent) => void | Promise<void>;

export interface PluginContext {
  /** Subscribe. Throws if the pattern is not covered by manifest.subscribes. */
  on(pattern: string, handler: EventHandler): void;
  /** Publish. Throws UndeclaredEventError if the type is not in manifest.emits. */
  emit(type: string, payload?: unknown, jobId?: string): void;
  can(capability: string): boolean;
  /** Throws CapabilityDeniedError unless declared in needs AND granted in config. */
  require(capability: string): void;
  jobs: JobsApi;
  /** This plugin's own durable key-value store. */
  state: StateApi;
  log: Logger;
  /** This plugin's own config object. */
  config: Record<string, unknown>;
}

export interface Plugin {
  manifest: ManifestInput;
  register(ctx: PluginContext): void | Promise<void>;
  stop?(): void | Promise<void>;
}

/** Identity helper that gives plugin authors type checking and autocomplete. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

export * from './scope.ts';
