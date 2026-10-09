import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { definePlugin, type ManifestInput, type Plugin, type PluginContext } from '../src/index.ts';
import { fakeJobId } from '../src/conformance/fake-kernel.ts';
import { checkPlugin, type ConformanceOptions, type Rule } from '../src/conformance/check.ts';

const J1 = fakeJobId(1);
const base: ManifestInput = { name: 'demo', version: '0.1.0', sdk: '1', description: 'test plugin' };
const make = (manifest: Partial<ManifestInput>, register: (ctx: PluginContext) => void | Promise<void>, stop?: () => void | Promise<void>): Plugin =>
  definePlugin({ manifest: { ...base, ...manifest }, register, ...(stop && { stop }) });

/** The rules a run broke, so each negative test names exactly the rule it expects. */
const broken = async (opts: ConformanceOptions): Promise<Rule[]> => [...new Set((await checkPlugin(opts)).findings.map((f) => f.rule))].sort();
const messages = async (opts: ConformanceOptions): Promise<string> => (await checkPlugin(opts)).findings.map((f) => f.message).join('\n');

describe('a good plugin', () => {
  it('has no findings', async () => {
    const good = () =>
      make({ subscribes: ['stage.completed'], emits: ['stage.checked'], needs: [] }, (ctx) => {
        ctx.on('stage.completed', (e) => ctx.emit('stage.checked', { stage: 'plan' }, e.jobId));
        ctx.state.set('seen', 1);
      });
    const report = await checkPlugin({ load: good, scenarios: [{ name: 'a stage', events: [{ type: 'stage.completed', payload: { stage: 'plan' }, jobId: J1 }] }], strictEmits: true });
    expect(report.findings).toEqual([]);
    expect(report.unexercised).toEqual([]);
  });
});

describe('manifest rule', () => {
  it('fails a manifest the schema refuses', async () => {
    expect(await broken({ load: () => make({ name: 'Not Kebab' }, () => {}) })).toContain('manifest');
  });
  it('fails an sdk major the kernel does not load', async () => {
    expect(await messages({ load: () => make({ sdk: '9' }, () => {}) })).toMatch(/sdk "9" is not supported/);
  });
  it('fails a plugin that lists a kernel event in emits', async () => {
    expect(await messages({ load: () => make({ emits: ['job.created'] }, () => {}) })).toMatch(/only the kernel may emit/);
  });
});

describe('subscribes rule', () => {
  it('fails a subscription the manifest does not declare', async () => {
    const load = () => make({ subscribes: ['stage.completed'] }, (ctx) => {
      ctx.on('stage.completed', () => {});
      try {
        ctx.on('pr.opened', () => {}); // swallowed on purpose: the harness still saw it
      } catch {}
    });
    expect(await messages({ load })).toMatch(/subscribed to "pr.opened" but did not declare it/);
  });
  it('fails a declared subscription that register() never makes', async () => {
    expect(await messages({ load: () => make({ subscribes: ['stage.completed', 'pr.opened'] }, (ctx) => ctx.on('stage.completed', () => {})) })).toMatch(/never subscribed to it/);
  });
  it('allows a setting to choose between two declared subscriptions, but not to hide one from every config', async () => {
    const load = () => make({ subscribes: ['stage.completed', 'stage.checked'] }, (ctx) => ctx.on(ctx.config.input === 'checked' ? 'stage.checked' : 'stage.completed', () => {}));
    expect(await broken({ load })).toEqual(['subscribes']);
    expect(await broken({ load, scenarios: [{ name: 'checked', config: { input: 'checked' }, events: [] }] })).toEqual([]);
  });
  it('accepts a wildcard that covers what it subscribes to', async () => {
    expect(await broken({ load: () => make({ subscribes: ['stage.*'] }, (ctx) => ctx.on('stage.*', () => {})) })).toEqual([]);
  });
});

describe('emits rule', () => {
  const emitting = (type: string, declared: string[]) => () =>
    make({ subscribes: ['kernel.started'], emits: declared }, (ctx) => {
      ctx.on('kernel.started', () => {
        try {
          ctx.emit(type, {});
        } catch {}
      });
    });
  const kick = [{ name: 'start', events: [{ type: 'kernel.started' }] }];
  it('fails an undeclared emit, even when the plugin swallows the error', async () => {
    expect(await messages({ load: emitting('pr.opened', ['stage.checked']), scenarios: kick })).toMatch(/emitted "pr.opened" but did not declare it/);
  });
  it('fails a payload that is not JSON', async () => {
    const load = () => make({ subscribes: ['kernel.started'], emits: ['stage.checked'] }, (ctx) => ctx.on('kernel.started', () => ctx.emit('stage.checked', { n: 1n })));
    expect(await messages({ load, scenarios: kick })).toMatch(/not JSON/);
  });
  it('lists a declared emit that no scenario reached, and fails it under strictEmits', async () => {
    const load = emitting('stage.checked', ['stage.checked', 'stage.failed']);
    const report = await checkPlugin({ load, scenarios: kick });
    expect(report.unexercised).toEqual(['stage.failed']);
    expect(report.findings).toEqual([]);
    expect(await broken({ load, scenarios: kick, strictEmits: true })).toEqual(['emits']);
  });
});

describe('needs rule', () => {
  it('fails require() of a capability that is not declared', async () => {
    const load = () => make({}, (ctx) => {
      try {
        ctx.require('git.push');
      } catch {}
    });
    expect(await messages({ load })).toMatch(/required "git.push" but did not declare it/);
  });
  it('fails a declared need that the plugin never uses', async () => {
    expect(await messages({ load: () => make({ needs: ['git.push', 'gh.pr'] }, (ctx) => ctx.require('git.push')) })).toMatch(/declared need "gh.pr"/);
  });
  it('fails emitting a gated event without the capability', async () => {
    const load = () => make({ subscribes: ['kernel.started'], emits: ['approval.granted'] }, (ctx) => ctx.on('kernel.started', () => {
      try {
        ctx.emit('approval.granted', {});
      } catch {}
    }));
    expect(await messages({ load, scenarios: [{ name: 'go', events: [{ type: 'kernel.started' }] }] })).toMatch(/needs "approval.grant"/);
  });
  it('fails ending a job without jobs.write', async () => {
    const load = () => make({ subscribes: ['kernel.started'] }, (ctx) => ctx.on('kernel.started', () => {
      try {
        ctx.jobs.setStatus(J1, 'done');
      } catch {}
    }));
    const opts = { load, scenarios: [{ name: 'go', jobs: [{ repo: 'r', title: 't' }], events: [{ type: 'kernel.started' }] }] };
    expect(await messages(opts)).toMatch(/used "jobs.write" to set a job done without declaring it/);
  });
  it('fails opening an approval stage without jobs.write', async () => {
    const load = () => make({ subscribes: ['kernel.started'] }, (ctx) => ctx.on('kernel.started', () => {
      try {
        ctx.jobs.startStage(J1, 'approve-plan');
      } catch {}
    }));
    expect(await messages({ load, scenarios: [{ name: 'go', jobs: [{ repo: 'r', title: 't' }], events: [{ type: 'kernel.started' }] }] })).toMatch(/open the "approve-plan" stage/);
  });
  it('passes the same calls once jobs.write is declared and required', async () => {
    const load = () => make({ subscribes: ['kernel.started'], needs: ['jobs.write'] }, (ctx) => {
      ctx.require('jobs.write');
      ctx.on('kernel.started', () => {
        ctx.jobs.startStage(J1, 'approve-plan');
        ctx.jobs.setStatus(J1, 'done');
      });
    });
    expect(await broken({ load, scenarios: [{ name: 'go', jobs: [{ repo: 'r', title: 't' }], events: [{ type: 'kernel.started' }] }] })).toEqual([]);
  });
});

describe('effects rule', () => {
  const go = [{ name: 'go', events: [{ type: 'kernel.started' }] }];
  const onStart = (needs: string[], fn: (ctx: PluginContext) => void) => () =>
    make({ subscribes: ['kernel.started'], needs }, (ctx) => {
      for (const n of needs) ctx.require(n);
      ctx.on('kernel.started', () => {
        try {
          fn(ctx);
        } catch {}
      });
    });
  it('fails network access with no network capability', async () => {
    const load = onStart([], () => void fetch('https://example.com').catch(() => {}));
    expect(await messages({ load, scenarios: go })).toMatch(/used network but none of its declared needs covers it/);
  });
  it('fails a child process with no process capability', async () => {
    expect(await messages({ load: onStart([], () => void spawn('echo', ['hi'])), scenarios: go })).toMatch(/used process/);
  });
  it('fails a file write with no fs capability', async () => {
    expect(await messages({ load: onStart([], () => writeFileSync('/tmp/conformance-should-not-exist', 'x')), scenarios: go })).toMatch(/used fs-write/);
  });
  it('blocks the call, so a failing plugin touches nothing', async () => {
    const { existsSync } = await import('node:fs');
    await checkPlugin({ load: onStart([], () => writeFileSync('/tmp/conformance-should-not-exist', 'x')), scenarios: go });
    expect(existsSync('/tmp/conformance-should-not-exist')).toBe(false);
  });
  it('accepts the same effects once a covering capability is declared', async () => {
    expect(await broken({ load: onStart(['claude.run'], () => void spawn('echo', ['hi'])), scenarios: go })).toEqual([]);
    expect(await broken({ load: onStart(['channel.send:chat'], () => void fetch('https://example.com').catch(() => {})), scenarios: go })).toEqual([]);
  });
});

describe('lifecycle rule', () => {
  it('fails an interval that stop() leaves running', async () => {
    let timer: NodeJS.Timeout | undefined;
    const load = () => make({}, () => void (timer = setInterval(() => {}, 1000)), () => {});
    try {
      expect(await messages({ load })).toMatch(/still open: 1 x Timeout/);
    } finally {
      clearInterval(timer);
    }
  });
  it('passes an interval that stop() clears', async () => {
    let timer: NodeJS.Timeout | undefined;
    const load = () => make({}, () => void (timer = setInterval(() => {}, 1000)), () => clearInterval(timer));
    expect(await broken({ load })).toEqual([]);
  });
  it('fails a long one-shot timer that stop() leaves pending, and allows an unref\'d one', async () => {
    const load = (unref: boolean) => () => make({}, () => {
      const t = setTimeout(() => {}, 60_000);
      if (unref) t.unref();
    });
    expect(await messages({ load: load(false) })).toMatch(/1 x Timeout/);
    expect(await broken({ load: load(true) })).toEqual([]);
  });
  it('fails a stop() that throws the second time', async () => {
    const load = () => {
      let stopped = false;
      return make({}, () => {}, () => {
        if (stopped) throw new Error('already stopped');
        stopped = true;
      });
    };
    expect(await messages({ load })).toMatch(/stop\(\) threw on call 2: already stopped/);
  });
  it('fails a stop() that throws before register()', async () => {
    const load = () => {
      let registered = false;
      return make({}, () => void (registered = true), () => {
        if (!registered) throw new Error('not started');
      });
    };
    expect(await messages({ load })).toMatch(/stop\(\) before register\(\) threw/);
  });
  it('fails a register() that throws with a config that should be valid', async () => {
    expect(await messages({ load: () => make({}, () => { throw new Error('boom'); }) })).toMatch(/register\(\) threw with a config that should be valid: boom/);
  });
});

describe('config rule', () => {
  const strict = (msg: (name: string) => string) => () =>
    make({}, (ctx) => {
      if (ctx.config.mode !== 'a') throw new Error(msg('demo'));
    });
  const invalid = [{ config: { mode: 'b' }, reason: 'mode b is not allowed' }];
  it('fails a plugin that accepts an invalid config', async () => {
    expect(await messages({ load: () => make({}, () => {}), invalidConfigs: invalid })).toMatch(/accepted an invalid config: mode b/);
  });
  it('fails an error that does not name the plugin', async () => {
    expect(await messages({ load: strict(() => 'bad mode'), config: { mode: 'a' }, invalidConfigs: invalid })).toMatch(/without naming the plugin/);
  });
  it('fails a throw that is not an Error', async () => {
    const load = () => make({}, (ctx) => {
      if (ctx.config.mode !== 'a') throw 'nope';
    });
    expect(await messages({ load, config: { mode: 'a' }, invalidConfigs: invalid })).toMatch(/without naming the plugin/);
  });
  it('passes a clear refusal, and leaves nothing running after a half-finished register', async () => {
    expect(await broken({ load: strict((n) => `${n}: mode must be "a"`), config: { mode: 'a' }, invalidConfigs: invalid })).toEqual([]);
  });
  it('fails a refusal that leaves a timer running', async () => {
    const timers: NodeJS.Timeout[] = [];
    const load = () => make({}, (ctx) => {
      timers.push(setInterval(() => {}, 1000));
      if (ctx.config.mode !== 'a') throw new Error('demo: bad mode');
    }, () => {});
    const found = await messages({ load, invalidConfigs: invalid });
    timers.forEach(clearInterval);
    expect(found).toMatch(/\[invalid config\].*still open: 1 x Timeout/);
  });
});

describe('state rule', () => {
  it('fails a value that is not JSON', async () => {
    const load = () => make({}, (ctx) => ctx.state.set('fn', () => {}));
    expect(await messages({ load })).toMatch(/state.set\("fn"\)/);
  });
  it('fails a circular value', async () => {
    const load = () => make({}, (ctx) => {
      const a: Record<string, unknown> = {};
      a.self = a;
      ctx.state.set('loop', a);
    });
    expect(await broken({ load })).toEqual(['state']);
  });
});
