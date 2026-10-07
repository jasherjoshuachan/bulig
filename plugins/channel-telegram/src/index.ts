import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { definePlugin, type BuligEvent, type Job, type Plugin, type PluginContext, type Stage } from '@bulig/plugin-sdk';
import { TelegramApi, TelegramError, defaultSleep, type FetchLike, type Sleep } from './api.ts';

export { TelegramApi, TelegramError } from './api.ts';

export interface TelegramConfig {
  /** Name of the environment variable that holds the bot token. Default BULIG_TELEGRAM_TOKEN. */
  tokenEnv?: string;
  /** Only these chats may talk to the bot. Everyone else is ignored without a reply. */
  allowedChatIds: number[];
  /** Short names for repositories, used by /dev. */
  repos?: Record<string, string>;
  /** Default https://api.telegram.org. Tests point this at a local fake. */
  apiBase?: string;
  /** Seconds one getUpdates call waits for news. Default 30. */
  pollTimeoutSec?: number;
}

export interface TelegramChannelOptions {
  fetch?: FetchLike;
  sleep?: Sleep;
}

interface Update {
  update_id: number;
  message?: { message_id: number; text?: string; chat: { id: number } };
  callback_query?: {
    id: string;
    data?: string;
    from?: { username?: string; first_name?: string };
    message?: { message_id: number; text?: string; chat: { id: number } };
  };
}

const MAX_TEXT = 4000;
const SUBSCRIPTIONS = [
  'approval.requested',
  'job.status',
  'stage.completed',
  'stage.failed',
  'worktree.failed',
  'pr.opened',
  'pr.failed',
  'pr.merged',
  'merge.refused',
  'pipeline.failed',
];

const short = (id?: string) => (id ?? '--------').slice(0, 8);
const one = (s: unknown, n = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 20)}\n[cut]` : s);
const usd = (n: unknown) => (typeof n === 'number' ? ` ($${n.toFixed(2)})` : '');
const human = (status: string) => status.replace('_', ' ');
const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? `${homedir()}/${p.slice(2)}` : p);

const HELP = [
  'Commands',
  '/dev <repo> <title>   start a job. Put the issue text on the next lines.',
  '/status [jobId]       list jobs, or show one',
  '/history <jobId>      the stages of a job',
  '/cancel <jobId>       stop a job',
  '/help                 this text',
  '',
  'Plan and merge approvals arrive here with Approve and Deny buttons.',
].join('\n');

/** The one line to show for a progress event. Undefined means say nothing. */
export function progressLine(e: BuligEvent): string | undefined {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const tag = `[${short(e.jobId)}]`;
  switch (e.type) {
    case 'stage.completed': {
      const verdict = ['test', 'review'].includes(String(p.stage))
        ? /^[\s>*_`#-]*VERDICT:\s*(PASS|FAIL)\b/gim.exec(String(p.result ?? ''))?.[1]
        : undefined;
      return `${tag} ${one(p.stage)} finished${verdict ? `: ${verdict}` : ''}${usd(p.costUsd)}`;
    }
    case 'stage.failed':
      return `${tag} ${one(p.stage)} FAILED: ${one(p.error, 300)}`;
    case 'worktree.failed':
      return `${tag} could not set up a worktree: ${one(p.error, 300)}`;
    case 'pr.opened':
      return `${tag} PR opened: ${one(p.url)}`;
    case 'pr.failed':
      return `${tag} PR failed: ${one(p.error, 300)}`;
    case 'pr.merged':
      return `${tag} PR merged${p.number !== undefined ? ` (#${one(p.number)})` : ''}`;
    case 'merge.refused':
      return `${tag} merge refused: ${one(p.reason, 300)}`;
    case 'pipeline.failed':
      return `${tag} job failed: ${one(p.reason, 300)}`;
    case 'job.status':
      return ['done', 'failed', 'cancelled'].includes(String(p.to)) ? `${tag} job ${String(p.to)}` : undefined;
    default:
      return undefined;
  }
}

/**
 * The Telegram channel. Long-polls the Bot API, takes commands from allowed chats only, shows
 * progress, and turns the Approve and Deny buttons into approval events.
 *
 * Jobs are created with ctx.jobs.create: the "job.*" event names belong to the kernel, so a plugin
 * cannot emit a request event for another brick to act on, and the kernel announces job.created itself.
 */
export function createTelegramChannel(options: TelegramChannelOptions = {}): Plugin {
  const ac = new AbortController(); // stops the poll loop
  const sendAc = new AbortController(); // stops sending, a little later, so the last lines go out
  let drain: () => Promise<void> = async () => {};
  let loop: Promise<void> | undefined;

  return definePlugin({
    manifest: {
      name: 'channel-telegram',
      version: '0.1.0',
      sdk: '0',
      description: 'Run Bulig from Telegram: start jobs, watch progress, tap to approve.',
      provides: { commands: ['dev', 'status', 'history', 'cancel', 'help'] },
      subscribes: SUBSCRIPTIONS,
      emits: ['approval.granted', 'approval.denied'],
      needs: ['channel.send:telegram', 'approval.grant'],
    },

    register(ctx: PluginContext) {
      ctx.require('channel.send:telegram');
      ctx.require('approval.grant');
      const cfg = ctx.config as unknown as TelegramConfig;
      const tokenEnv = cfg.tokenEnv ?? 'BULIG_TELEGRAM_TOKEN';
      const token = process.env[tokenEnv];
      if (!token) throw new Error(`channel-telegram: the bot token is not set. Export it as ${tokenEnv}.`);
      const allowed = cfg.allowedChatIds;
      if (!Array.isArray(allowed) || allowed.length === 0 || !allowed.every((n) => Number.isInteger(n))) {
        throw new Error('channel-telegram: allowedChatIds must list at least one chat id (numbers).');
      }
      const repos = cfg.repos ?? {};

      const sleep = options.sleep ?? defaultSleep;
      const base = {
        apiBase: (cfg.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, ''),
        token,
        fetch: options.fetch ?? fetch,
        sleep,
        warn: (m: string) => ctx.log.warn(`channel-telegram: ${m}`),
      };
      const pollApi = new TelegramApi({ ...base, signal: ac.signal });
      const api = new TelegramApi({ ...base, signal: sendAc.signal });

      // ----- sending -----

      // One send at a time, in order. A failed send is logged and never blocks the next one.
      let queue: Promise<void> = Promise.resolve();
      const later = (task: () => Promise<unknown>) => {
        queue = queue.then(task).then(
          () => undefined,
          (err: unknown) => ctx.log.warn(`channel-telegram: send failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      };
      /** Where news about a job goes: the chat that started it, else every allowed chat. */
      const targets = (jobId?: string): number[] => {
        const origin = jobId ? ctx.state.get<number>(`chat:${jobId}`) : undefined;
        return origin !== undefined ? [origin] : allowed;
      };
      const say = (chats: number[], text: string, extra: Record<string, unknown> = {}) =>
        later(async () => {
          for (const chat_id of chats) await api.call('sendMessage', { chat_id, text: clip(text), ...extra });
        });
      const sayJob = (jobId: string | undefined, text: string, extra: Record<string, unknown> = {}) =>
        later(async () => {
          for (const chat_id of targets(jobId)) await api.call('sendMessage', { chat_id, text: clip(text), ...extra });
        });

      drain = async () => {
        await Promise.race([queue, defaultSleep(3000, sendAc.signal)]);
        sendAc.abort();
      };

      // ----- what Bulig tells you -----

      for (const pattern of SUBSCRIPTIONS) {
        ctx.on(pattern, (e) => {
          if (e.type === 'approval.requested') return askForApproval(e);
          const line = progressLine(e);
          if (line) sayJob(e.jobId, line);
        });
      }

      function askForApproval(e: BuligEvent): void {
        const p = (e.payload ?? {}) as Record<string, unknown>;
        const jobId = e.jobId ?? String(p.jobId ?? '');
        const kind = String(p.kind);
        const head = [`[${short(jobId)}] approval needed: ${kind}`];
        if (kind === 'merge' && p.url) head.push(`PR ${one(p.url)}`);
        const text = `${head.join('\n')}\n\n${String(p.summary ?? '').trim()}`;
        sayJob(jobId, text, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve', callback_data: `ap:${jobId}:${kind}` },
                { text: '❌ Deny', callback_data: `dn:${jobId}:${kind}` },
              ],
            ],
          },
        });
      }

      // ----- what you tell Bulig -----

      const findJob = (arg: string): Job | string => {
        const hits = ctx.jobs.list().filter((j) => j.id === arg || j.id.startsWith(arg));
        if (hits.length === 1) return hits[0]!;
        return hits.length ? `"${arg}" matches ${hits.length} jobs. Send more of the id.` : `No job starts with "${arg}".`;
      };

      function stageLine(s: Stage): string {
        const secs = s.endedAt ? `${((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 1000).toFixed(0)}s` : '...';
        const out = (s.output && typeof s.output === 'object' ? s.output : {}) as Record<string, unknown>;
        const note = out.interrupted ? ' (interrupted)' : typeof out.verdict === 'string' ? ` ${out.verdict}` : '';
        return `${s.name} #${s.attempt}  ${s.status}  ${secs}${note}`;
      }

      function handleText(chat: number, text: string): void {
        const [first = '', ...restLines] = text.trim().split('\n');
        const m = /^\/([a-z]+)(?:@\w+)?(?:\s+(.*))?$/i.exec(first.trim());
        if (!m) return say([chat], 'Send /help to see what I understand.');
        const cmd = m[1]!.toLowerCase();
        const args = (m[2] ?? '').trim();
        switch (cmd) {
          case 'start':
          case 'help':
            return say([chat], HELP);
          case 'dev':
            return startJob(chat, args, restLines.join('\n').trim());
          case 'status':
            return status(chat, args);
          case 'history':
            return history(chat, args);
          case 'cancel':
            return cancel(chat, args);
          default:
            return say([chat], `I don't know /${cmd}. Send /help.`);
        }
      }

      function startJob(chat: number, args: string, body: string): void {
        const aliases = Object.keys(repos);
        const known = aliases.length ? `Known repos: ${aliases.join(', ')}` : 'No repos are set up. Add them under "repos" in the config.';
        const [alias = '', ...titleWords] = args.split(/\s+/).filter(Boolean);
        if (!alias) return say([chat], `Usage: /dev <repo> <title>\n${known}`);
        const path = Object.hasOwn(repos, alias) ? repos[alias] : undefined;
        if (path === undefined) return say([chat], `I don't know a repo called "${alias}". ${known}`);
        const title = titleWords.join(' ');
        if (!title) return say([chat], `Usage: /dev ${alias} <title>\nPut the issue text on the lines after it.`);
        const repo = expandHome(path);
        if (!existsSync(repo)) return say([chat], `The path for "${alias}" does not exist on this machine: ${repo}`);
        try {
          const job = ctx.jobs.create({ repo, title, ...(body && { body }) });
          ctx.state.set(`chat:${job.id}`, chat);
          say([chat], `Job ${short(job.id)} started: ${title}\nRepo ${alias}. Send /status ${short(job.id)} any time.`);
        } catch (err) {
          say([chat], `Could not start the job: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      function status(chat: number, arg: string): void {
        if (!arg) {
          const jobs = ctx.jobs.list().reverse().slice(0, 8);
          if (jobs.length === 0) return say([chat], 'No jobs yet. Try /dev.');
          return say([chat], jobs.map((j) => `${short(j.id)}  ${human(j.status)}  ${j.title}`).join('\n'));
        }
        const job = findJob(arg);
        if (typeof job === 'string') return say([chat], job);
        const waiting = ctx.jobs.stages(job.id).find((s) => s.name.startsWith('approve-') && s.status === 'running');
        const lines = [`${short(job.id)}  ${human(job.status)}`, job.title, job.repo];
        if (waiting) lines.push(`Waiting for your ${waiting.name.slice(8)} approval.`);
        say([chat], lines.join('\n'));
      }

      function history(chat: number, arg: string): void {
        if (!arg) return say([chat], 'Usage: /history <jobId>');
        const job = findJob(arg);
        if (typeof job === 'string') return say([chat], job);
        const stages = ctx.jobs.stages(job.id);
        say([chat], [`${short(job.id)}  ${human(job.status)}  ${job.title}`, ...stages.map(stageLine)].join('\n'));
      }

      function cancel(chat: number, arg: string): void {
        if (!arg) return say([chat], 'Usage: /cancel <jobId>');
        const job = findJob(arg);
        if (typeof job === 'string') return say([chat], job);
        if (['done', 'failed', 'cancelled'].includes(job.status)) return say([chat], `Job ${short(job.id)} is already ${job.status}.`);
        const waiting = ctx.jobs.stages(job.id).find((s) => s.name.startsWith('approve-') && s.status === 'running');
        if (waiting) {
          // Same path as pressing Deny, so the pipeline closes the approval stage itself.
          ctx.emit('approval.denied', { jobId: job.id, kind: waiting.name.slice(8) }, job.id);
        } else {
          ctx.jobs.setStatus(job.id, 'cancelled');
        }
        say([chat], `Job ${short(job.id)} cancelled. A stage that is already running will finish, then nothing else starts.`);
      }

      const CALLBACK = /^(ap|dn):([0-9a-f-]{36}):(plan|merge)$/;

      async function handleButton(q: NonNullable<Update['callback_query']>): Promise<void> {
        const msg = q.message;
        if (!msg || !allowed.includes(msg.chat.id)) return;
        const m = CALLBACK.exec(q.data ?? '');
        const reply = (text: string) => api.call('answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => undefined);
        if (!m) return void (await reply('Unknown button.'));
        const [, action, jobId, kind] = m as unknown as [string, 'ap' | 'dn', string, string];
        const edit = (note: string) =>
          api.call('editMessageText', {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            text: clip(`${msg.text ?? ''}\n\n${note}`),
            reply_markup: { inline_keyboard: [] },
          });

        const job = ctx.jobs.get(jobId);
        const waiting = job?.status === 'awaiting_approval' && ctx.jobs.stages(jobId).some((s) => s.name === `approve-${kind}` && s.status === 'running');
        if (!waiting) {
          await reply('That approval is no longer open.');
          await edit('Expired: the job is not waiting for this any more.').catch(() => undefined);
          return;
        }
        const who = q.from?.username ? `@${q.from.username}` : (q.from?.first_name ?? 'you');
        if (action === 'ap') {
          ctx.emit('approval.granted', { jobId, kind }, jobId);
          await reply('Approved');
          await edit(`Approved by ${who}`);
        } else {
          ctx.emit('approval.denied', { jobId, kind }, jobId);
          await reply('Denied');
          await edit(`Denied by ${who}`);
        }
      }

      async function handleUpdate(u: Update): Promise<void> {
        if (u.callback_query) return handleButton(u.callback_query);
        const msg = u.message;
        if (!msg?.text) return;
        if (!allowed.includes(msg.chat.id)) {
          ctx.log.warn(`channel-telegram: ignored a message from chat ${msg.chat.id}, which is not in allowedChatIds`);
          return;
        }
        handleText(msg.chat.id, msg.text);
      }

      // ----- the poll loop -----

      async function poll(): Promise<void> {
        const wait = cfg.pollTimeoutSec ?? 30;
        while (!ac.signal.aborted) {
          let updates: Update[];
          try {
            const offset = ctx.state.get<number>('offset');
            updates = await pollApi.call<Update[]>(
              'getUpdates',
              { timeout: wait, allowed_updates: ['message', 'callback_query'], ...(offset !== undefined && { offset }) },
              { maxAttempts: Infinity, timeoutMs: (wait + 15) * 1000 },
            );
          } catch (err) {
            if (ac.signal.aborted) return;
            ctx.log.error(`channel-telegram: stopped polling: ${err instanceof Error ? err.message : String(err)}`);
            if (err instanceof TelegramError && err.code === 401) ctx.log.error('channel-telegram: Telegram rejected the token. Check it.');
            return;
          }
          for (const u of updates) {
            // Remember the position first. A crash mid-command skips that command rather than running it twice.
            ctx.state.set('offset', u.update_id + 1);
            try {
              await handleUpdate(u);
            } catch (err) {
              ctx.log.error(`channel-telegram: could not handle update ${u.update_id}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }

      loop = poll();
    },

    async stop() {
      ac.abort();
      await loop;
      await drain();
      sendAc.abort();
    },
  });
}

export default createTelegramChannel();
