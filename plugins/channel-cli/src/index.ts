import { definePlugin, type BuligEvent, type Job, type Plugin, type PluginContext } from '@bulig/plugin-sdk';

export type ApprovalKind = 'plan' | 'merge';

export interface CliChannelOptions {
  /** Where lines go. Default: standard output. */
  write?: (line: string) => void;
  /** Print only events that belong to this job. */
  onlyJob?: string;
}

export interface CliChannel {
  plugin: Plugin;
  /** Create a job. Only works once the kernel has started. */
  submit(input: { repo: string; title: string; body?: string }): Job;
  grant(jobId: string, kind: ApprovalKind): void;
  deny(jobId: string): void;
}

const short = (id?: string) => (id ?? '--------').slice(0, 8);
const one = (s: unknown, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const usd = (n: unknown) => (typeof n === 'number' ? ` $${n.toFixed(4)}` : '');

/** One concise line (or a few) for an event. Undefined means: say nothing. */
export function format(e: BuligEvent): string[] | undefined {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const tag = `[${short(e.jobId)}]`;
  const line = (s: string) => [`${tag} ${s}`];
  switch (e.type) {
    case 'job.status':
      return line(`job ${String(p.to).replace('_', ' ')}`);
    case 'worktree.ready':
      return line(`worktree ready on ${one(p.branch)}`);
    case 'worktree.failed':
      return line(`worktree failed: ${one(p.error)}`);
    case 'stage.requested':
      return line(`${one(p.stage)}: started (${one(p.model)}, ${one(p.mode)})`);
    case 'stage.completed':
      return line(`${one(p.stage)}: done${usd(p.costUsd)}${p.sessionId ? ` session ${short(String(p.sessionId))}` : ''}`);
    case 'stage.failed':
      return line(`${one(p.stage)}: FAILED ${one(p.error, 300)}`);
    case 'pr.requested':
      return line('opening pull request');
    case 'pr.opened':
      return line(`PR opened: ${one(p.url)} (head ${short(String(p.headSha ?? ''))})`);
    case 'pr.failed':
      return line(`PR failed: ${one(p.error, 300)}`);
    case 'pr.merged':
      return line(`PR merged (#${one(p.number)})`);
    case 'merge.refused':
      return line(`merge refused: ${one(p.reason, 300)}`);
    case 'pipeline.failed': {
      const files = Array.isArray(p.outOfScope) ? p.outOfScope.slice(0, 20).map((f) => `${tag}   outside the approved scope: ${one(f, 160)}`) : [];
      return [line(`job failed: ${one(p.reason, 300)}`), ...files].flat();
    }
    case 'plugin.error':
      return line(`plugin error in ${one(p.plugin)} on ${one(p.eventType)}: ${one(p.message, 300)}`);
    case 'approval.requested': {
      const id = e.jobId ?? String(p.jobId ?? '');
      const kind = String(p.kind);
      const head = [`${tag} approval needed: ${kind}`];
      if (kind === 'merge') head.push(`${tag}   PR ${one(p.url)} at ${short(String(p.headSha ?? ''))}`);
      if (kind === 'plan' && Array.isArray(p.scope) && p.scope.length) {
        head.push(`${tag}   files this job may change:`);
        // Every entry, in full: the person approving must see all of it.
        for (const f of p.scope) head.push(`${tag}     - ${String(f).replace(/\s+/g, ' ')}`);
      }
      const summary = String(p.summary ?? '').trim().split('\n').slice(0, 14);
      for (const s of summary) head.push(`${tag}   | ${s.slice(0, 160)}`);
      head.push(`${tag}   approve: bulig approve ${id} ${kind}`);
      head.push(`${tag}   deny:    bulig deny ${id}`);
      return head;
    }
    default:
      return undefined;
  }
}

/**
 * The terminal channel. It prints what happens and lets a person grant or deny an approval.
 * Use createCliChannel() when you need grant/deny/submit; the default export is the same plugin
 * with output on stdout, for loading by name.
 */
export function createCliChannel(opts: CliChannelOptions = {}): CliChannel {
  const write = opts.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  let ctx: PluginContext | undefined;
  const need = (): PluginContext => {
    if (!ctx) throw new Error('channel-cli is not started yet');
    return ctx;
  };

  const plugin = definePlugin({
    manifest: {
      name: 'channel-cli',
      version: '0.1.0',
      sdk: '0',
      description: 'Talk to Bulig from a terminal: prints progress, takes approvals.',
      provides: { commands: ['run', 'approve', 'deny'] },
      subscribes: [
        'approval.requested',
        'job.status',
        'stage.*',
        'pr.*',
        'merge.refused',
        'pipeline.failed',
        'worktree.ready',
        'worktree.failed',
        'plugin.error',
      ],
      emits: ['approval.granted', 'approval.denied'],
      needs: ['channel.send:terminal', 'approval.grant'],
    },
    register(c) {
      c.require('channel.send:terminal');
      c.require('approval.grant');
      ctx = c;
      const show = (e: BuligEvent) => {
        if (opts.onlyJob && e.jobId !== opts.onlyJob) return;
        for (const l of format(e) ?? []) write(l);
      };
      for (const pattern of [
        'approval.requested',
        'job.status',
        'stage.*',
        'pr.*',
        'merge.refused',
        'pipeline.failed',
        'worktree.ready',
        'worktree.failed',
        'plugin.error',
      ]) {
        c.on(pattern, show);
      }
    },
  });

  return {
    plugin,
    submit: (input) => need().jobs.create(input),
    grant: (jobId, kind) => need().emit('approval.granted', { jobId, kind }, jobId),
    deny: (jobId) => need().emit('approval.denied', { jobId }, jobId),
  };
}

export default createCliChannel().plugin;
