# 0002. Events over direct calls

## Context

Bulig is built from plugins. If plugins call each other, each new plugin has to know about the others, and removing one breaks its callers. We want to add a plugin and have the rest keep working unchanged.

## Decision

Plugins never call each other. They publish events through the kernel and subscribe to the ones they care about. Each manifest declares the event types it subscribes to (exact, or a trailing wildcard like `stage.*`) and the ones it emits. The kernel refuses an undeclared subscribe or emit. Every event is written to the log first, then handed to subscribers in order. If a handler throws, the kernel records a `plugin.error` event and carries on. Events starting with `kernel.`, `job.` and the `plugin.error` type belong to the kernel.

## Consequences

- Plugins can be added, removed or disabled without editing the others.
- The event log doubles as an audit trail and can be replayed per job.
- Flow is harder to follow than a function call. You read the manifests to see who listens to what.
- Handlers should be idempotent, because replay is possible.
- Events are loosely typed for now. The payload shapes get firmer when the SDK is frozen.

## In my words (Jasher)

_To be written by Jasher before v0.1 is tagged._
