import { createHash } from 'node:crypto';
import { readCredential } from '@bulig/credentials';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { definePlugin, type BuligEvent, type Job, type Plugin, type PluginContext, type Stage } from '@bulig/plugin-sdk';
import { TelegramApi, TelegramError, defaultSleep, type FetchLike, type Sleep } from './api.ts';
import { clipText } from '@bulig/text';

export { TelegramApi, TelegramError } from './api.ts';

export interface TelegramConfig {
  /** Name of the environment variable that holds the bot token. Default BULIG_TELEGRAM_TOKEN. */
  tokenEnv?: string;
  /** A file name in $CREDENTIALS_DIRECTORY (systemd LoadCredential=) that holds the bot token. Default "telegram-token". It wins over tokenEnv when the file is there. */
  tokenCredential?: string;
  /** Only these chats may talk to the bot. Everyone else is ignored without a reply. */
  allowedChatIds: number[];
  /**
   * Only these Telegram users may use commands or tap Approve and Deny. In a group chat, being in the chat is
   * not enough. If this is not set, anyone in an allowed chat can approve, and a warning is logged at start.
   */
  allowedUserIds?: number[];
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
  /** The clock, in milliseconds. Tests set it so job ages are fixed. */
  now?: () => number;
}

interface Update {
  update_id: number;
  message?: { message_id: number; text?: string; chat: { id: number }; from?: { id: number } };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number; username?: string; first_name?: string };
    message?: { message_id: number; text?: string; chat: { id: number } };
  };
}

const MAX_TEXT = 4000;
/**
 * What a button carries to name its approval stage: 12 characters of a hash of the stage id. Button data is at most 64
 * bytes, too few for a job id and a whole stage id; ap:<36-char job id>:merge:<12> is 58. A hash, not a prefix, because
 * stage ids from one store can share their first characters. The channel turns it back into the full id before emitting.
 */
const stageRef = (stageId: string): string => createHash('sha256').update(stageId).digest('base64url').slice(0, 12);
const SUBSCRIPTIONS = [
  'approval.requested',
  'job.status',
  'stage.completed',
  'stage.checked',
  'stage.screened',
  'stage.failed',
  'worktree.failed',
  'pr.opened',
  'pr.failed',
  'pr.merged',
  'merge.refused',
  'merge.failed',
  'pipeline.failed',
];

const short = (id?: string) => (id ?? '--------').slice(0, 8);
const one = (s: unknown, n = 200) => clipText(String(s ?? '').replace(/\s+/g, ' ').trim(), n);
const MAX_FILE_LINES = 20;
/** "- path" lines for a list of paths, cut at `max` with a count of the rest. Empty when the value is not a list of strings. */
const bullets = (list: unknown, max: number): string[] => {
  if (!Array.isArray(list)) return [];
  const items = list.filter((x): x is string => typeof x === 'string' && x !== '').map((x) => one(x, 200));
  const lines = items.slice(0, max).map((x) => `- ${x}`);
  if (items.length > max) lines.push(`... and ${items.length - max} more`);
  return lines;
};
/** Split text into pieces of at most `max` characters, breaking between lines (and inside a line only if one line is longer than `max`). */
export const chunkLines = (lines: string[], max: number): string[] => {
  const out: string[] = [];
  let cur = '';
  for (const raw of lines) {
    let rest = raw;
    do {
      // Cut with clipText so a piece never ends in half an emoji. If the limit is smaller than one emoji, take the emoji whole.
      const line = clipText(rest, max) || rest.slice(0, 2);
      rest = rest.slice(line.length);
      if (cur && cur.length + 1 + line.length > max) {
        out.push(cur);
        cur = '';
      }
      cur = cur ? `${cur}\n${line}` : line;
    } while (rest);
  }
  if (cur) out.push(cur);
  return out;
};
const clip = (s: string) => (s.length > MAX_TEXT ? `${clipText(s, MAX_TEXT - 20)}\n[cut]` : s);
const usd = (n: unknown) => (typeof n === 'number' ? ` ($${n.toFixed(2)})` : '');
const human = (status: string) => status.replace('_', ' ');
const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? `${homedir()}/${p.slice(2)}` : p);

const STATUS_LIMIT = 10;
const ENDED = ['done', 'failed', 'cancelled'];
/** "45s", "12m", "3h", "2d": how long ago, in the biggest whole unit. */
const ago = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const HELP = [
  'Commands',
  '/dev <repo> <title>   start a job. Put the issue text on the next lines.',
  '/status [jobId]       your jobs, newest first, or one job',
  '/history <jobId>      the stages of a job',
  '/cancel [jobId]       stop a job. Without an id, stops the only active one.',
  '/retry <jobId>        run a failed or cancelled job again, with a new plan approval',
  '/help                 this text',
  '',
  'Plan and merge approvals arrive here with Approve and Deny buttons.',
].join('\n');

/** A link from a check is shown only if it is a plain https URL: no other scheme, no spaces, no control or bidi characters, no user@host. */
export function safeLink(link: unknown): boolean {
  if (typeof link !== 'string' || link.length === 0 || link.length > 500) return false;
  // Controls, spaces, zero-width characters, and the bidi marks and overrides that can make a link read as a different address.
  if (/[\s\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/.test(link)) return false;
  try {
    const url = new URL(link);
    // user@host hides the real host behind a name that looks like one.
    return url.protocol === 'https:' && !url.username && !url.password && !/^https:\/\/[^/?#]*@/i.test(link);
  } catch {
    return false;
  }
}

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
    case 'stage.checked': {
      // A gate (gate-evidence) found a claim with no tool-use record behind it. Say nothing when everything was backed.
      const unverified = bullets(p.unverified, 5);
      return unverified.length ? `${tag} ${one(p.stage)} has claims with no evidence:\n${unverified.join('\n')}\n${one(p.evidenceSummary, 200)}` : undefined;
    }
    case 'stage.screened': {
      // gate-promise found a promise of later work with no live job id behind it. Say nothing when there is none.
      const promises = bullets(p.promises, 5);
      return promises.length ? `${tag} ${one(p.stage)} promises later work with no job id:\n${promises.join('\n')}` : undefined;
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
    case 'merge.failed': {
      // The reason says what to do. Failing checks come with their names (already in the reason) and links when GitHub gave them.
      const links = (Array.isArray(p.checks) ? p.checks : [])
        .map((c) => c as { name?: unknown; link?: unknown })
        .filter((c) => safeLink(c.link))
        .map((c) => `\n${one(c.name, 80)}: ${String(c.link)}`);
      return `${tag} merge failed: ${one(p.reason, 400)}${links.join('')}`;
    }
    case 'pipeline.failed': {
      // A failed merge already said why, in its own message. Only the status line follows.
      if (/^merge failed:/i.test(String(p.reason ?? ''))) return undefined;
      const files = bullets(p.outOfScope, MAX_FILE_LINES);
      return `${tag} job failed: ${one(p.reason, 300)}${files.length ? `\nFiles outside the approved scope:\n${files.join('\n')}` : ''}`;
    }
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
      sdk: '1',
      description: 'Run Bulig from Telegram: start jobs, watch progress, tap to approve.',
      provides: { commands: ['dev', 'status', 'history', 'cancel', 'retry', 'help'] },
      subscribes: SUBSCRIPTIONS,
      emits: ['approval.granted', 'approval.denied', 'cancel.requested'],
      needs: ['channel.send:telegram', 'approval.grant'],
    },

    register(ctx: PluginContext) {
      ctx.require('channel.send:telegram');
      ctx.require('approval.grant');
      const cfg = ctx.config as unknown as TelegramConfig;
      const tokenEnv = cfg.tokenEnv ?? 'BULIG_TELEGRAM_TOKEN';
      const token = readCredential(cfg.tokenCredential ?? 'telegram-token') ?? process.env[tokenEnv];
      if (!token) throw new Error(`channel-telegram: the bot token is not set. Export it as ${tokenEnv}${cfg.tokenCredential ? `, or add the credential ${cfg.tokenCredential}` : ' (or give the unit a telegram-token credential)'}.`);
      const allowed = cfg.allowedChatIds;
      if (!Array.isArray(allowed) || allowed.length === 0 || !allowed.every((n) => Number.isInteger(n))) {
        throw new Error('channel-telegram: allowedChatIds must list at least one chat id (numbers).');
      }
      const users = cfg.allowedUserIds;
      if (users !== undefined && (!Array.isArray(users) || users.length === 0 || !users.every((n) => Number.isInteger(n)))) {
        throw new Error('channel-telegram: allowedUserIds must list at least one Telegram user id (numbers), or be left out.');
      }
      if (users === undefined) {
        ctx.log.warn('channel-telegram: allowedUserIds is not set, so anyone in an allowed chat can approve and deny. Set it to the user ids that may.');
      }
      /** May this Telegram user give orders and approve? Always true when no list is configured. */
      const userAllowed = (id: number | undefined): boolean => users === undefined || (id !== undefined && users.includes(id));
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
      // Chats set this run, filled in before any await, so the first news about a new job never goes to every chat while its save is in flight.
      const chatOf = new Map<string, number>();
      // Jobs this plugin is creating right now. Creating a job is async, and the kernel announces the new job before the call
      // returns, so news about it can be ready to send before chatOf is filled in. Sends wait for these first.
      const creating = new Set<Promise<unknown>>();
      const targets = async (jobId?: string): Promise<number[]> => {
        if (jobId && !chatOf.has(jobId) && creating.size > 0) await Promise.allSettled([...creating]);
        const origin = jobId ? (chatOf.get(jobId) ?? (await ctx.state.get<number>(`chat:${jobId}`))) : undefined;
        return origin !== undefined ? [origin] : allowed;
      };
      const say = (chats: number[], text: string, extra: Record<string, unknown> = {}) =>
        later(async () => {
          for (const chat_id of chats) await api.call('sendMessage', { chat_id, text: clip(text), ...extra });
        });
      const sayJob = (jobId: string | undefined, text: string, extra: Record<string, unknown> = {}) =>
        later(async () => {
          for (const chat_id of await targets(jobId)) await api.call('sendMessage', { chat_id, text: clip(text), ...extra });
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
        // The buttons name this exact approval stage, so a card left over from an earlier question cannot answer a later one.
        if (typeof p.stageId !== 'string' || p.stageId === '') {
          ctx.log.warn(`channel-telegram: approval.requested for job ${jobId} names no approval stage, so its card has no buttons`);
          return sayJob(jobId, `[${short(jobId)}] approval needed: ${kind}, but the request names no approval stage, so there are no buttons. Use /cancel ${short(jobId)}.`);
        }
        const buttons = {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve', callback_data: `ap:${jobId}:${kind}:${stageRef(p.stageId)}` },
                { text: '❌ Deny', callback_data: `dn:${jobId}:${kind}:${stageRef(p.stageId)}` },
              ],
            ],
          },
        };
        const summary = String(p.summary ?? '').trim();
        // The approver sees every entry of the scope, in full, before the buttons. It goes above the plan text.
        const scope = kind === 'plan' && Array.isArray(p.scope) ? p.scope.filter((x): x is string => typeof x === 'string' && x !== '').map((x) => `- ${x.replace(/\s+/g, ' ')}`) : [];
        if (scope.length) head.push('', 'Files this job may change:', ...scope);
        const text = `${head.join('\n')}\n\n${summary}`;
        if (text.length <= MAX_TEXT) return sayJob(jobId, text, buttons);
        // Too long for one message: send the header and the whole scope first, in order, then the plan with the buttons.
        // If any piece of the scope fails to send, the buttons are withheld in that chat: a job must not be approvable
        // when the approver could not see what it may change.
        const pieces = chunkLines(head, MAX_TEXT - 20);
        later(async () => {
          for (const chat_id of await targets(jobId)) {
            try {
              for (const [i, piece] of pieces.entries()) {
                await api.call('sendMessage', { chat_id, text: clip(pieces.length > 1 ? `${piece}\n(${i + 1}/${pieces.length})` : piece) });
              }
            } catch (err) {
              ctx.log.warn(`channel-telegram: scope list did not send, approval buttons withheld: ${err instanceof Error ? err.message : String(err)}`);
              await api
                .call('sendMessage', { chat_id, text: `[${short(jobId)}] approval needed: ${kind}, but the list of files could not be sent, so there are no buttons. Use /cancel ${short(jobId)} or ask for the approval again.` })
                .catch(() => undefined);
              continue;
            }
            await api.call('sendMessage', { chat_id, text: clip(`[${short(jobId)}] approval needed: ${kind} (plan text, after the list above)\n\n${summary}`), ...buttons });
          }
        });
      }

      /** Create a job for a chat. The chat is recorded as soon as the job exists, before anything waiting on `creating` can send. */
      async function createFor(chat: number, input: { repo: string; title: string; body?: string }): Promise<Job> {
        const made = ctx.jobs.create(input).then((job) => {
          chatOf.set(job.id, chat);
          return job;
        });
        creating.add(made);
        try {
          return await made;
        } finally {
          creating.delete(made);
        }
      }

      // ----- what you tell Bulig -----

      const now = options.now ?? Date.now;
      /** The jobs this chat may see and act on: the ones it started, and the ones with no recorded chat. Oldest first. */
      const jobsOf = async (chat: number): Promise<Job[]> => {
        const mine: Job[] = [];
        for (const j of await ctx.jobs.list()) if ((await targets(j.id)).includes(chat)) mine.push(j);
        return mine;
      };
      const findJob = async (chat: number, arg: string): Promise<Job | string> => {
        const mine = await jobsOf(chat);
        const exact = mine.filter((j) => j.id === arg);
        const hits = exact.length ? exact : mine.filter((j) => j.id.startsWith(arg));
        if (hits.length === 1) return hits[0]!;
        return hits.length ? `"${one(arg, 40)}" matches ${hits.length} jobs. Send more of the id.` : `No job starts with "${one(arg, 40)}".`;
      };
      /** The repo's short name from the config; the folder name if it is not listed. */
      const aliasOf = (repo: string): string => {
        const hit = Object.entries(repos).find(([, p]) => expandHome(p) === repo);
        return hit ? hit[0] : one(repo.split('/').filter(Boolean).pop() ?? repo, 40);
      };
      const waitingFor = async (job: Job): Promise<string | undefined> => {
        if (job.status !== 'awaiting_approval') return undefined;
        const w = (await ctx.jobs.stages(job.id)).find((s) => s.name.startsWith('approve-') && s.status === 'running');
        return w ? `${w.name.slice(8)} approval` : undefined;
      };
      const jobLine = async (j: Job): Promise<string> => {
        const wait = await waitingFor(j);
        return `${short(j.id)}  ${aliasOf(j.repo)}  ${human(j.status)}  ${ago(now() - Date.parse(j.createdAt))}  ${one(j.title, 80)}${wait ? `\n    waiting for your ${wait}` : ''}`;
      };

      function stageLine(s: Stage): string {
        const secs = s.endedAt ? `${((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 1000).toFixed(0)}s` : '...';
        const out = (s.output && typeof s.output === 'object' ? s.output : {}) as Record<string, unknown>;
        const note = out.interrupted ? ' (interrupted)' : typeof out.verdict === 'string' ? ` ${out.verdict}` : '';
        return `${s.name} #${s.attempt}  ${s.status}  ${secs}${note}`;
      }

      async function handleText(chat: number, text: string): Promise<void> {
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
          case 'retry':
            return retry(chat, args);
          default:
            return say([chat], `I don't know /${cmd}. Send /help.`);
        }
      }

      async function startJob(chat: number, args: string, body: string): Promise<void> {
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
          const job = await createFor(chat, { repo, title, ...(body && { body }) });
          await ctx.state.set(`chat:${job.id}`, chat);
          say([chat], `Job ${short(job.id)} started: ${title}\nRepo ${alias}. Send /status ${short(job.id)} any time.`);
        } catch (err) {
          say([chat], `Could not start the job: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      async function status(chat: number, arg: string): Promise<void> {
        if (!arg) {
          const jobs = (await jobsOf(chat)).reverse();
          if (jobs.length === 0) return say([chat], 'No jobs yet. Try /dev.');
          const lines = await Promise.all(jobs.slice(0, STATUS_LIMIT).map(jobLine));
          if (jobs.length > STATUS_LIMIT) lines.push(`... and ${jobs.length - STATUS_LIMIT} more`);
          return say([chat], lines.join('\n'));
        }
        const job = await findJob(chat, arg);
        if (typeof job === 'string') return say([chat], job);
        const waiting = await waitingFor(job);
        const lines = [`${short(job.id)}  ${human(job.status)}  ${ago(now() - Date.parse(job.createdAt))}`, one(job.title, 200), job.repo];
        if (waiting) lines.push(`Waiting for your ${waiting}.`);
        say([chat], lines.join('\n'));
      }

      async function history(chat: number, arg: string): Promise<void> {
        if (!arg) return say([chat], 'Usage: /history <jobId>');
        const job = await findJob(chat, arg);
        if (typeof job === 'string') return say([chat], job);
        const stages = await ctx.jobs.stages(job.id);
        say([chat], [`${short(job.id)}  ${human(job.status)}  ${job.title}`, ...stages.map(stageLine)].join('\n'));
      }

      async function cancel(chat: number, arg: string): Promise<void> {
        let job: Job;
        if (arg) {
          const found = await findJob(chat, arg);
          if (typeof found === 'string') return say([chat], found);
          job = found;
        } else {
          const active = (await jobsOf(chat)).filter((j) => !ENDED.includes(j.status));
          if (active.length === 0) return say([chat], 'No active jobs to cancel.');
          if (active.length > 1) {
            return say([chat], [`${active.length} jobs are active. Send /cancel <jobId> with one of these:`, ...(await Promise.all(active.reverse().map(jobLine)))].join('\n'));
          }
          job = active[0]!;
        }
        if (ENDED.includes(job.status)) return say([chat], `Job ${short(job.id)} is already ${job.status}.`);
        const waiting = (await ctx.jobs.stages(job.id)).find((s) => s.name.startsWith('approve-') && s.status === 'running');
        if (waiting) {
          // Same path as pressing Deny, so the pipeline closes the approval stage itself.
          ctx.emit('approval.denied', { jobId: job.id, kind: waiting.name.slice(8), stageId: waiting.id }, job.id);
        } else {
          // Ending a job needs jobs.write, which the pipeline holds and this channel does not. Ask it.
          ctx.emit('cancel.requested', { jobId: job.id }, job.id);
        }
        say([chat], `Job ${short(job.id)} cancelled. A stage that is running is being stopped, and nothing else starts.`);
      }

      /** The chat a job came from, which job it retries, and the retries a job has had. A retry of a retry links to the retry, so chains work. The pending mark is cleared last. */
      async function linkRetry(newId: string, oldId: string, chat: number): Promise<void> {
        chatOf.set(newId, chat); // before any await, so news about the new job already goes to this chat
        // The list the guard reads goes first: a crash after any one write below still leaves the job counted as a retry.
        const earlier = (await ctx.state.get<string[]>(`retries:${oldId}`)) ?? [];
        if (!earlier.includes(newId)) await ctx.state.set(`retries:${oldId}`, [...earlier, newId]);
        await ctx.state.set(`retry-of:${newId}`, oldId);
        await ctx.state.set(`chat:${newId}`, chat);
        await ctx.state.set(`retry-pending:${oldId}`, null);
      }

      /**
       * A retry job is created first and linked after, in separate writes, so a crash between them leaves a job nobody
       * links to the one it retries, and a second /retry would start another. Before a retry begins it leaves a
       * `retry-pending` mark. If the mark is still there, look for the job it was about to link: one made since the mark
       * with the same repo, title and text that nothing links yet. Link it. No such job means the crash came before the
       * job was created, and the mark is just cleared.
       */
      async function adoptUnlinkedRetry(old: Job): Promise<void> {
        const pending = await ctx.state.get<{ at: string; chat: number } | null>(`retry-pending:${old.id}`);
        // The mark has no expiry. Age cannot tell a crash after the job was created (adopt it) from one before (nothing to adopt),
        // and guessing wrong would start a second job. A job that matches is always taken for the retry, however old the mark.
        if (!pending) return;
        // Not yet linked, or linked part way: linkRetry can be run again for the same job.
        let orphan: Job | undefined;
        for (const j of await ctx.jobs.list()) {
          if (j.id === old.id || j.createdAt < pending.at || j.repo !== old.repo || j.title !== old.title || j.body !== old.body) continue;
          const of = await ctx.state.get(`retry-of:${j.id}`);
          if (of === undefined || of === old.id) {
            orphan = j;
            break;
          }
        }
        if (orphan) await linkRetry(orphan.id, old.id, pending.chat);
        else await ctx.state.set(`retry-pending:${old.id}`, null);
      }

      async function retry(chat: number, arg: string): Promise<void> {
        if (!arg) return say([chat], 'Usage: /retry <jobId>');
        const old = await findJob(chat, arg);
        if (typeof old === 'string') return say([chat], old);
        if (old.status === 'done') return say([chat], `Job ${short(old.id)} is done, so there is nothing to retry.`);
        if (!ENDED.includes(old.status)) {
          return say([chat], `Job ${short(old.id)} is still ${human(old.status)}. Only a failed or cancelled job can be retried. Use /cancel ${short(old.id)} first if you want to stop it.`);
        }
        try {
          await adoptUnlinkedRetry(old);
        } catch (err) {
          // Cannot tell whether an earlier attempt left a job behind, so do not start another.
          ctx.log.warn(`channel-telegram: could not check an earlier retry of ${old.id}: ${err instanceof Error ? err.message : String(err)}`);
          return say([chat], `Could not check whether job ${short(old.id)} was already retried. Look at /status, then send /retry ${short(old.id)} again.`);
        }
        // One live retry per job. An earlier retry that ended failed or cancelled does not count, so a retry can be tried again.
        const earlier = (await Promise.all(((await ctx.state.get<string[]>(`retries:${old.id}`)) ?? []).map((id) => ctx.jobs.get(id)))).filter((j): j is Job => !!j);
        const blocking = earlier.reverse().find((j) => j.status !== 'failed' && j.status !== 'cancelled');
        if (blocking) return say([chat], `Job ${short(blocking.id)} already retried this one and is ${human(blocking.status)}. Use /status ${short(blocking.id)}.`);
        if (!existsSync(old.repo)) return say([chat], `The repo for job ${short(old.id)} is not on this machine any more: ${one(old.repo, 200)}`);
        try {
          // Written before the job exists, so a crash between creating it and saving its link can be found and healed (see adoptUnlinkedRetry).
          await ctx.state.set(`retry-pending:${old.id}`, { at: new Date().toISOString(), chat });
          // A new job: it plans again and asks for its own plan approval. Nothing of the old job's approvals or scope is carried over.
          let job: Job;
          try {
            job = await createFor(chat, { repo: old.repo, title: old.title, ...(old.body && { body: old.body }) });
          } catch (err) {
            // The create itself failed and was handled: no job exists, so the mark must not outlive this attempt.
            try {
              await ctx.state.set(`retry-pending:${old.id}`, null);
            } catch {
              // The mark stays; the next /retry finds no matching job and clears it (adoptUnlinkedRetry).
            }
            throw err;
          }
          await linkRetry(job.id, old.id, chat);
          say([chat], `Job ${short(job.id)} started from ${short(old.id)}: ${one(old.title, 200)}\nRepo ${aliasOf(old.repo)}. It will plan first and ask for your plan approval.`);
        } catch (err) {
          say([chat], `Could not start the job: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // The stage part is optional only so that a card sent before stage ids existed is recognised and told it has expired.
      const CALLBACK = /^(ap|dn):([0-9a-f-]{36}):(plan|merge)(?::([0-9A-Za-z_-]{12}))?$/;

      async function handleButton(q: NonNullable<Update['callback_query']>): Promise<void> {
        const msg = q.message;
        if (!msg || !allowed.includes(msg.chat.id)) return;
        const m = CALLBACK.exec(q.data ?? '');
        const reply = (text: string) => api.call('answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => undefined);
        if (!userAllowed(q.from?.id)) {
          ctx.log.warn(`channel-telegram: refused a button press from user ${q.from?.id ?? 'unknown'}, who is not in allowedUserIds`);
          await api
            .call('answerCallbackQuery', { callback_query_id: q.id, text: 'You are not allowed to approve or deny.', show_alert: true })
            .catch(() => undefined);
          return;
        }
        if (!m) return void (await reply('Unknown button.'));
        const [, action, jobId, kind, ref] = m as unknown as [string, 'ap' | 'dn', string, string, string | undefined];
        const edit = (note: string) =>
          api.call('editMessageText', {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            text: clip(`${msg.text ?? ''}\n\n${note}`),
            reply_markup: { inline_keyboard: [] },
          });

        const job = await ctx.jobs.get(jobId);
        const open = job?.status === 'awaiting_approval' ? (await ctx.jobs.stages(jobId)).find((s) => s.name === `approve-${kind}` && s.status === 'running') : undefined;
        // The card must name the stage that is open now. A card from an earlier question of the same kind, or from before
        // stage ids, names another stage or none, and has expired. The pipeline makes the same check and ignores it too.
        const waiting = open !== undefined && ref !== undefined && stageRef(open.id) === ref;
        if (!waiting) {
          await reply('That approval is no longer open.');
          await edit('Expired: the job is not waiting for this any more.').catch(() => undefined);
          return;
        }
        const who = q.from?.username ? `@${q.from.username}` : (q.from?.first_name ?? 'you');
        if (action === 'ap') {
          ctx.emit('approval.granted', { jobId, kind, stageId: open.id }, jobId);
          await reply('Approved');
          await edit(`Approved by ${who}`);
        } else {
          ctx.emit('approval.denied', { jobId, kind, stageId: open.id }, jobId);
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
        if (!userAllowed(msg.from?.id)) {
          ctx.log.warn(`channel-telegram: ignored a message from user ${msg.from?.id ?? 'unknown'}, who is not in allowedUserIds`);
          return;
        }
        await handleText(msg.chat.id, msg.text);
      }

      // ----- the poll loop -----

      async function poll(): Promise<void> {
        const wait = cfg.pollTimeoutSec ?? 30;
        while (!ac.signal.aborted) {
          let updates: Update[];
          try {
            const offset = await ctx.state.get<number>('offset');
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
            await ctx.state.set('offset', u.update_id + 1);
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
