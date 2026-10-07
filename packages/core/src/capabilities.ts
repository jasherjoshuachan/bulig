import type { Manifest } from '@bulig/plugin-sdk';

/**
 * Events that only a plugin holding a capability may emit. Declaring the event in `emits` is not enough:
 * the plugin must also declare the capability in `needs` and be granted it in the config. Anyone can
 * listen to these events, but only the right plugins can say them.
 */
export const DEFAULT_EVENT_CAPABILITIES: Readonly<Record<string, string>> = {
  'approval.granted': 'approval.grant',
  'approval.denied': 'approval.grant',
  'merge.requested': 'merge.request',
  // Ending a job on a person's say-so. Without this, any plugin could cancel a job and skip jobs.write.
  'cancel.requested': 'approval.grant',
};

/** What a plugin may do: what it declared it needs, intersected with what the config grants it. */
export function effectiveCapabilities(
  manifest: Pick<Manifest, 'name' | 'needs'>,
  grants: Record<string, readonly string[]>,
): Set<string> {
  const granted = new Set(grants[manifest.name] ?? []);
  return new Set(manifest.needs.filter((cap) => granted.has(cap)));
}

/** Capability that lets a plugin close an approval stage or end a job. Only the pipeline holds it by default. */
export const JOBS_WRITE = 'jobs.write';

/** Statuses that end a job. Setting one of these ends the work, so it needs jobs.write. */
export const TERMINAL_STATUSES: readonly string[] = ['done', 'failed', 'cancelled'];

/** Stages that stand for a person's yes: approve-plan and approve-merge. Opening or closing one needs jobs.write. */
export const isApprovalStage = (name: string | undefined): boolean => name !== undefined && name.startsWith('approve-');
