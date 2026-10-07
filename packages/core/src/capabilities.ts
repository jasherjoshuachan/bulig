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
};

/** What a plugin may do: what it declared it needs, intersected with what the config grants it. */
export function effectiveCapabilities(
  manifest: Pick<Manifest, 'name' | 'needs'>,
  grants: Record<string, readonly string[]>,
): Set<string> {
  const granted = new Set(grants[manifest.name] ?? []);
  return new Set(manifest.needs.filter((cap) => granted.has(cap)));
}
