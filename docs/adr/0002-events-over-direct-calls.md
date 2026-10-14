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

I chose events so I can add a plugin and nothing else has to change. That's the main reason. The audit trail from the log is a bonus I'm glad to have.

I accept that flow is harder to follow than a function call. The manifests are where I look to see who listens to what, and I'd rather keep that one place than build more tooling around it.

Log first, then deliver. That's a hard rule and it doesn't bend, even when wake-ups arrive through Postgres.

A handler that throws shouldn't take the others down, so the kernel records `plugin.error` and carries on. For gates that already fails safe: the pipeline only trusts the gate's output, so a crashed gate stalls the job and doesn't let it through. I ran it to be sure. The job stayed running, no approval card went out, and the error was in the log. What I want added is that a stalled job gets noticed and failed, not left waiting.

Resume doesn't replay events. It reads the saved job and stage state, marks the stage that was running as interrupted, and runs it again. So the work inside a stage has to be safe to run twice. The log is there to read, not to re-feed.

When the SDK freezes, new event shapes get a schema and are refused when they don't match. Existing shapes stay tolerant until a major version, as ADR 0006 requires.
