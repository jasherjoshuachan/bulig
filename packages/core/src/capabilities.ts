import type { Manifest } from '@bulig/plugin-sdk';

// The event-to-capability map, the job rules and the approval-stage convention live in the SDK, so the conformance suite
// enforces the same rules as the kernel. They are re-exported here so existing imports keep working.
export { DEFAULT_EVENT_CAPABILITIES, JOBS_WRITE, TERMINAL_STATUSES, isApprovalStage } from '@bulig/plugin-sdk';

/** What a plugin may do: what it declared it needs, intersected with what the config grants it. */
export function effectiveCapabilities(
  manifest: Pick<Manifest, 'name' | 'needs'>,
  grants: Record<string, readonly string[]>,
): Set<string> {
  const granted = new Set(grants[manifest.name] ?? []);
  return new Set(manifest.needs.filter((cap) => granted.has(cap)));
}
