# Plugin SDK v1 (release candidate)

This is the contract between the kernel and a plugin. `@bulig/plugin-sdk` is version `1.0.0-rc.1`. A manifest that sets `"sdk": "1"` is promising to follow this page, and the kernel promises to keep honouring it.

The page is split by how much Bulig is willing to promise:

- **Stable**: frozen with v1. Changing it needs a new major.
- **Experimental**: works today, written down here, and allowed to change in any minor release. Do not build a plugin that cannot survive a change to these.
- **To remove**: exported today, wrong to keep. Gone or moved before 1.0.0 final.

Seven plugins use this surface, but for most events there is one producer and one consumer, and nobody outside this repo has written a plugin. The roadmap's rule of three is not met for those, so a lot of the event traffic is marked experimental on purpose. Freezing something nobody has had to change yet is how you freeze a mistake.

## 1. Manifest

```ts
definePlugin({
  manifest: { name, version, sdk, description, provides?, subscribes?, emits?, needs? },
  register(ctx) { ... },
  stop?() { ... },
});
```

| Field | Type | Status | Notes |
|---|---|---|---|
| `name` | kebab-case string | stable | Unique per kernel. The key for `enabled`, `grants` and `pluginConfig`. |
| `version` | semver string | stable | The plugin's own version. The kernel does not read it. |
| `sdk` | major as a string, `"1"` | stable | See "Versioning". `"0"` still loads, with a warning. |
| `description` | non-empty string | stable | |
| `subscribes` | event types or patterns | stable | Exact (`stage.completed`), prefix wildcard (`stage.*`), or `*`. Default `[]`. |
| `emits` | exact event types | stable | No wildcards. May not contain `kernel.*`, `job.*` or `plugin.error`. Default `[]`. |
| `needs` | capability names | stable | `area.action` or `area.action:scope`. Default `[]`. |
| `provides.stages`, `provides.commands` | string lists | experimental | Documentation only. Nothing reads them or checks them. `provides.stages: ["*"]` is a convention, not a rule. |

Rules the kernel applies when it loads a manifest, and the conformance suite applies again:

1. The manifest parses against `ManifestSchema`.
2. `sdk` is a major the kernel supports.
3. `emits` holds no reserved event.
4. Two enabled plugins may not share a name.

`register()` is called once per plugin instance. `stop()` is called at shutdown, in reverse start order, and a plugin must tolerate a second call and a call before `register()`. A stopped instance is not registered again; a plugin may not support it.

## 2. What a plugin gets: `PluginContext`

| Member | Status | Contract |
|---|---|---|
| `on(pattern, handler)` | stable | Throws `UndeclaredSubscriptionError` unless `manifest.subscribes` covers `pattern`. Handlers may be async. A handler that throws becomes a `plugin.error` event. |
| `emit(type, payload?, jobId?)` | stable | Throws `UndeclaredEventError` unless `type` is in `manifest.emits`. Throws `CapabilityDeniedError` if the type is gated (section 5) and the plugin lacks the capability. The payload must be JSON. The event is stored first, then delivered. |
| `require(cap)` | stable | Throws `CapabilityDeniedError` unless `cap` is in `needs` and granted in config. Call it in `register()` so a missing grant stops the start. |
| `can(cap)` | stable | `true` when the plugin holds `cap`. No plugin uses it yet. |
| `jobs.create/get/list` | stable | Read jobs, and create one. Creating one makes the kernel emit `job.created`. |
| `jobs.setStatus` | stable | Ending a job (`done`, `failed`, `cancelled`) or moving it out of `awaiting_approval` needs `jobs.write`. A finished job is final. |
| `jobs.stages(jobId)` | stable | Every stage of a job, oldest first. |
| `jobs.startStage/finishStage` | experimental | Open or close a stage. Stages whose name starts with `approve-` need `jobs.write`. That prefix is a string convention the permission check relies on. It should become a field. |
| `state.get/set` | stable | The plugin's own key-value store. JSON values only. Survives a restart. Other plugins' keys are invisible. |
| `log.debug/info/warn/error` | stable | |
| `config` | experimental | The plugin's own object from `pluginConfig`, untyped. The manifest has no config schema yet, so every plugin validates its own config in `register()`. The conformance suite checks that an invalid config is refused clearly. A `configSchema` manifest field is the likely fix. |

Event delivery: events are written to the log in emit order and delivered to subscribers in subscription order. An event emitted inside a handler is queued and delivered after the current one, so dispatch order equals log order. This ordering is stable. Handlers run concurrently when they are async; do not depend on one finishing before the next starts.

## 3. Public exports of `@bulig/plugin-sdk`

| Export | Kind | Status | Why |
|---|---|---|---|
| `definePlugin`, `Plugin`, `PluginContext`, `EventHandler`, `Logger`, `StateApi`, `JobsApi` | API | stable | The plugin surface above. |
| `Manifest`, `ManifestInput` | types | stable | |
| `ManifestSchema` | zod schema | experimental | The shape is stable. The export is a zod object, so zod's major version leaks into the contract. Plan: export a `validateManifest()` function and keep zod private. |
| `SDK_VERSION` (`"1"`) | const | stable | What a new manifest sets `sdk` to. |
| `SUPPORTED_SDK_MAJORS`, `DEPRECATED_SDK_MAJORS` | consts | stable | |
| `SDK_RELEASE` | const | experimental | Moves with every release candidate. |
| `Job`, `Stage`, `JobStatus`, `StageStatus`, `JOB_STATUSES`, `STAGE_STATUSES` | data | stable | Status values are part of the contract. Adding one is a minor change. Removing or renaming one is a major change. |
| `Stage.output` | field | experimental | `unknown`. Its shape belongs to whichever plugin wrote the stage (today `pipeline-dev`). Other plugins must not read it. |
| `BuligEvent` | type | stable | `{ id, seq?, type, jobId?, source, payload, at }`. |
| `matchesPattern`, `patternCovered` | functions | stable | The wildcard rules in section 1. |
| `BuligError` and its subclasses (`UndeclaredEventError`, `UndeclaredSubscriptionError`, `CapabilityDeniedError`, `ManifestError`, `SdkVersionMismatchError`, `DuplicatePluginError`) | classes | stable | Match on the class, not the message. The messages are not part of the contract. |
| `JOBS_WRITE`, `DEFAULT_EVENT_CAPABILITIES` | consts | stable | Names and the event-to-capability map (section 5). |
| `isReservedEvent` | function | stable | |
| `TERMINAL_STATUSES`, `isApprovalStage` | helpers | experimental | They encode the `approve-` prefix convention. |
| `effectiveCapabilities` | function | to remove | Kernel-internal: it intersects `needs` with `grants`. No plugin calls it. Move it into `@bulig/core`. It lives in the SDK for now because the conformance suite builds the same grant set. |
| `parseScopeBlock`, `normalizeScopeEntry`, `matchesScope`, `matchesGlob`, `isRepoPath`, `isPlainRepoPath`, `MAX_SCOPE_ENTRIES`, `MAX_PATTERN_LENGTH`, `MAX_PATTERN_PARTS`, `MAX_PATH_PARTS` and the `Scope*` types | functions | to remove | The scope guard (ADR 0005) is a pipeline and github feature. It is in the SDK only because two plugins share it. A plugin contract should not carry a glob engine. Move it to a shared package that both plugins depend on. |
| `@bulig/plugin-sdk/conformance` | subpath | experimental | New in this release. Stabilises when a third party has run it. |

## 4. How plugins reach the kernel today

There is no other route than the context. A plugin can still import Node APIs, because it shares the process (ADR 0003 says so). The table is every context path the seven plugins in the repo use.

| Path | Used by | Status |
|---|---|---|
| `ctx.on` / `ctx.emit` | all seven | stable |
| `ctx.require` | channel-cli, channel-telegram, github, pipeline-dev, worker-claude-code | stable |
| `ctx.can` | nobody | stable (unused) |
| `ctx.jobs.get/list/stages` | channel-telegram, github, gate-promise, pipeline-dev, worker-claude-code | stable |
| `ctx.jobs.create` | channel-telegram, channel-cli (through its `submit()`) | stable |
| `ctx.jobs.setStatus` | pipeline-dev | stable |
| `ctx.jobs.startStage/finishStage` | pipeline-dev | experimental |
| `ctx.state` | channel-telegram (chat per job, poll offset) | stable |
| `ctx.log` | all but channel-cli and worker-claude-code | stable |
| `ctx.config` | all but channel-cli | experimental |
| Direct `process.env` reads | channel-telegram, github (token env var names come from config) | not part of the SDK. Allowed, but the name of the variable must come from config. |
| Direct `fetch`, `child_process`, `fs` | channel-telegram (fetch), github and worker-claude-code (processes, files) | not part of the SDK. Covered by capability names the kernel does not enforce. See section 5 and the conformance limits. |

## 5. Capabilities

A capability is a name. The plugin lists it in `needs`, the config lists it under `grants.<plugin>`, and the plugin holds it only when both agree. Declared but not granted means `require()` throws.

| Capability | Granted to (example config) | What holding it allows | Enforced by |
|---|---|---|---|
| `approval.grant` | channels | Emit `approval.granted`, `approval.denied`, `cancel.requested`. | The kernel: the bus refuses the emit. Stable. |
| `merge.request` | pipeline-dev | Emit `merge.requested`. | The kernel. Stable. |
| `jobs.write` | pipeline-dev | End a job, move it out of `awaiting_approval`, open or close an `approve-*` stage. | The kernel: the wrapped job API refuses the call. Stable. |
| `claude.run` | worker-claude-code | Start Claude Code sessions. | Nothing. The plugin calls `require()` and then does the work. The OS-level fence is the Claude sandbox, not this name. Experimental. |
| `fs.worktree` | worker-claude-code | Write inside job worktrees. | Nothing. Experimental. |
| `git.push` | github | Push branches. | Nothing. Experimental. |
| `gh.pr` | github | Open and merge pull requests. | Nothing. Experimental. |
| `channel.send:<channel>` | channels (`terminal`, `telegram`) | Send messages to that channel. | Nothing. Experimental. A scope matches exactly: `channel.send:terminal` does not cover `channel.send:telegram`. |

The three capabilities the kernel enforces are frozen. The other names are conventions with no teeth, so they are experimental: they may be renamed, merged or split once something enforces them. A new capability is a minor change. A plugin must not assume a capability it did not declare is absent from the name space.

`DEFAULT_EVENT_CAPABILITIES` lists the gated event types: `approval.granted` and `approval.denied` (`approval.grant`), `cancel.requested` (`approval.grant`), `merge.requested` (`merge.request`). The config key `eventCapabilities` adds or overrides entries. The map's default entries are stable. Anyone may subscribe to a gated event.

## 6. Events

`Status` applies to the fields listed. Fields not listed are not promised. Every payload is JSON. A consumer must ignore fields it does not know.

### Kernel events (only the kernel emits them)

| Event | Payload | Status |
|---|---|---|
| `kernel.started` | `{ plugins: string[] }` | stable |
| `job.created` | the `Job` | stable |
| `job.status` | `{ from?: JobStatus, to: JobStatus }` | stable |
| `plugin.error` | `{ plugin, eventId, eventType, message }` | stable |

### Stage events (worker, gates, pipeline)

| Event | Emitted by | Payload | Status |
|---|---|---|---|
| `stage.requested` | pipeline | `{ stage, prompt, model, mode: "readonly"\|"edit", cwd }` | stable |
| `stage.completed` | worker | `{ stage, ok: true, result: string, costUsd?, sessionId?, evidence?: EvidenceRecord[] }` | `stage`, `ok`, `result` stable. `costUsd`, `sessionId` experimental. `evidence` experimental: the record shape is gate-evidence's input and has one producer. |
| `stage.checked` | gate-evidence | the `stage.completed` fields, plus `{ checked, mode?, evidenceSummary?, evidenceLines?, unverified? }` | name and the forwarded fields stable. The gate fields are experimental. |
| `stage.screened` | gate-promise | the `stage.checked` or `stage.completed` fields minus raw `evidence`, plus `{ promiseChecked, promiseMode?, promises? }` | name and forwarded fields stable. The gate fields are experimental. |
| `stage.failed` | worker, gates | `{ stage, error: string }`, and from a gate `{ blocked: true, unverified?, promises?, evidenceSummary? }` | `stage`, `error` stable. The rest experimental. |

The gate chain is part of the contract: a gate reads one stage event, forwards everything it read, and emits the next event in the chain (`stage.completed` to `stage.checked` to `stage.screened`) or `stage.failed`. It never edits another plugin's fields and never calls the plugin after it. The consumer names the event it listens to in config (`stageResultEvent`). That chain order is stable; adding a gate is a minor change if it reuses an existing link or appends a new event name.

### Approval and cancel events

| Event | Needs | Payload | Status |
|---|---|---|---|
| `approval.requested` | none | `{ jobId, kind: "plan"\|"merge", summary: string, scope?: string[], url?, headSha? }` | stable. `scope` is set for `plan`, `url` and `headSha` for `merge`. |
| `approval.granted` | `approval.grant` | `{ jobId, kind: "plan"\|"merge" }` | stable |
| `approval.denied` | `approval.grant` | `{ jobId, kind? }` | stable. `kind` is optional: the terminal channel denies without it. |
| `cancel.requested` | `approval.grant` | `{ jobId }` | stable |

### Pull request and merge events (pipeline and github)

| Event | Payload | Status |
|---|---|---|
| `pr.requested` | `{ cwd, branch, title, body, expectSha }` | experimental |
| `pr.opened` | `{ url, number, headSha }` | `url`, `number`, `headSha` stable (channels read them) |
| `pr.failed` | `{ error }` | `error` stable |
| `merge.requested` (needs `merge.request`) | `{ cwd, branch, number, headSha }` | experimental |
| `merge.refused` | `{ reason }` | `reason` stable. Means "asking again may work". |
| `merge.failed` | `{ reason, checks?: { name, link? }[] }` | `reason` stable, `checks` experimental. Means "do not ask again". |
| `pr.merged` | `{ number }` | stable |

The names and the refused/failed meaning are stable because channels depend on them. The request payloads are experimental: one producer and one consumer, which is not enough to know the right shape.

### Internal protocol (not for third parties yet)

`worktree.requested`, `worktree.ready`, `worktree.failed`, `worktree.reset.requested`, `worktree.reset.done`, `worktree.reset.failed`, `worktree.cleanup.requested`, `worktree.cleaned`, `worktree.cleanup.failed`, `commit.requested`, `commit.done`, `commit.failed`, `pipeline.failed`. All **experimental**. They are the private conversation between `pipeline-dev` and `github`. The payloads are in the plugins' tests; they are not frozen here. A second pipeline or a second git host would be the point to freeze them.

## 7. Versioning

`manifest.sdk` is the **major** version of this contract, as a string (`"1"`). It is not a semver range and not a minor.

- The kernel loads a plugin whose `sdk` is in `SUPPORTED_SDK_MAJORS` (today `0` and `1`) and refuses any other with `SdkVersionMismatchError`.
- A plugin written for major N keeps working on every release of major N, unchanged, without edits to its manifest.
- The package version of `@bulig/plugin-sdk` is full semver (`1.0.0-rc.1`). The minor and patch numbers are for humans and release notes; plugins never declare them.
- A plugin that needs something added in a later minor checks for it at runtime, or says so in its own docs. There is no `sdkMin` field. Add one only if that turns out to hurt.

A **breaking change** (needs major 2) is any of these, for something marked stable:

1. Removing or renaming a manifest field, an export, an event, a payload field, a capability, a status value or an error class.
2. Changing the type or the meaning of a payload field, or making an optional field required.
3. Making a manifest that validated before fail validation.
4. Changing which capability an event or a job call needs, in either direction. Needing less is also breaking: a plugin that relied on being fenced out would not be.
5. Changing the order events are delivered in, or when `register()` and `stop()` are called.

These are **not** breaking: adding a manifest field with a default, an event, an optional payload field, a capability, an export, a job status or a stage name; fixing a bug where the code did less than this page says; and anything marked experimental.

## 8. Deprecation

1. A stable thing is deprecated by saying so in this page and by a runtime warning where the kernel can give one (for example, loading a plugin with `sdk: "0"` logs one warning per plugin).
2. It keeps working for at least one more minor release and at least 30 days after the warning first ships.
3. It is removed only in the next major. Experimental things are exempt from steps 2 and 3, and are removed or changed with a note in the pull request that does it.
4. `sdk: "0"` is deprecated from `1.0.0-rc.1`. It stays loadable until `sdk: "2"` is released. To leave it, run the conformance suite and change `"0"` to `"1"`. For the seven plugins in this repo that was the only edit.

## 9. Conformance suite

`@bulig/plugin-sdk/conformance` runs a plugin in a fake kernel (no SQLite, no network, no processes) and reports what it did against what its manifest said.

```ts
// plugins/my-plugin/test/conformance.test.ts
import { describeConformance, fakeJobId } from '@bulig/plugin-sdk/conformance';
import { createMyPlugin } from '../src/index.ts';

describeConformance('my-plugin', {
  load: () => createMyPlugin(),                    // a fresh instance each call
  config: { token: 'test' },                       // a config the plugin accepts
  invalidConfigs: [{ config: {}, reason: 'token is missing' }],
  scenarios: [{ name: 'a stage finishes', events: [{ type: 'stage.completed', jobId: fakeJobId(1), payload: { stage: 'plan', result: 'x' } }] }],
  strictEmits: true,
});
```

| Rule | Fails when |
|---|---|
| `manifest` | the schema refuses it, `sdk` is not a supported major, or `emits` holds a kernel event |
| `subscribes` | `register()` subscribes to something undeclared, or a declared subscription is never made in any scenario's config |
| `emits` | the plugin emits an undeclared type, a payload that is not JSON, or (with `strictEmits`) a declared type is never emitted |
| `needs` | the plugin requires an undeclared capability, never uses a declared one, emits a gated event, ends a job or touches an approval stage without declaring the capability |
| `effects` | the plugin does network, process or file-write work and no declared capability covers it (`EFFECT_CAPABILITIES`) |
| `lifecycle` | `register()` throws on a valid config, `stop()` throws (before `register()`, or on a second call), or a timer, socket or child process is still open after `stop()` |
| `config` | an invalid config is accepted, or refused with an error that is not an `Error` or does not name the plugin |
| `state` | `ctx.state.set` is given something that is not JSON |

Every rule has a negative test in `packages/plugin-sdk/test/conformance.test.ts`: a deliberately bad plugin that must fail it.

What it cannot see, so do not read a pass as more than it is:

- **Only what the scenarios trigger.** A declared `emit` that no scenario reaches is listed as unexercised. It is not a pass. `strictEmits` turns it into a failure. Today `github` leaves seven emits unexercised and `worker-claude-code` leaves `stage.completed`, because reaching them needs a real repo or a real `claude`.
- **Effects are a tripwire.** While a plugin runs, the standard `fs` write functions, `child_process`, `net.Socket.connect` and the global `fetch` are replaced with recorders that refuse the call. A plugin that loaded a native addon, or kept a reference to one of those functions from before the run, is not seen. File reads are not watched. `allowEffects` lets a kind through when a code path needs it.
- **Timers are tracked through the global `setTimeout` and `setInterval`.** A plugin that imports them from `node:timers` is not seen. An `unref()`'d timer does not count as a leak.
- **The capability to effect map is a convention.** `EFFECT_CAPABILITIES` says network is covered by `net.*` or `channel.send:*`, processes by `claude.run`, `git.*`, `gh.*` or `proc.*`, and file writes by `fs.*`, `git.*` or `gh.*`. It checks that a plugin declared something sensible, not that the name means what it says. The kernel still does not enforce those names (section 5).
- **It is not a security boundary.** A plugin that wants to hide an effect can. The suite catches mistakes.

## 10. Results for the seven plugins in the repo

All seven pass every rule. Each has a `test/conformance.test.ts` that lists the scenarios it used, and the notes it prints say which declared emits no scenario reached. The only item the suite raised during the port was `gate-promise`, which declares `stage.completed` and `stage.checked` but subscribes to one of them depending on `input`. That is correct for a setting that picks one, so the rule was written against the union of subscriptions over the scenarios, and `gate-promise`'s tests cover both settings.

## 11. Not ready to freeze

Said plainly, so v1 is not read as more than it is:

- **Capability enforcement** beyond `approval.grant`, `merge.request` and `jobs.write`. Everything else is a name checked by the plugin on itself.
- **Plugin isolation.** Plugins share the process and the database file. The suite checks behaviour, it does not contain it.
- **Config.** No schema in the manifest. Validation is per plugin and untested by the kernel.
- **The pipeline and github conversation** (`worktree.*`, `commit.*`, `pr.requested`, `merge.requested`). One producer, one consumer.
- **Stage names and `Stage.output`.** The `approve-` prefix carries a permission. That needs a real field.
- **`provides`.** Declared, never read.
- **The scope helpers** in the SDK, which belong somewhere else.
- **Third-party use.** Nobody outside this repo has written a plugin against it. The first one will find things this page missed. Hence a release candidate, not a final.
