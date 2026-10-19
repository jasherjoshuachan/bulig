import Database from 'better-sqlite3';
import { derivedEventId } from '../src/bus.ts';
import { SqliteStore } from '../src/sqlite-store.ts';

/** What the populated record holds, for tests to look for after a copy. */
export interface PopulatedRecord {
  /** A job in each status, by status. */
  jobs: Record<string, string>;
  /** The job with the stage that was running when the Mac kernel stopped. */
  busyJob: string;
  /** That stage's id (running, with a live claim at lease generation 3). */
  runningStage: string;
  /** The lease generation the record ends on. */
  leaseGeneration: number;
  /** The highest event seq. */
  lastSeq: number;
  eventCount: number;
}

/**
 * A schema-6 SQLite record built like the live one: jobs in every status, stages with and without claims (one stage from before
 * claims existed), claims taken under different lease generations, a running stage with a live claim, events with random and with
 * derived ids (some for no job, some with a bare number or no payload), plugin state, and a lease that is still live.
 * Built through the real SqliteStore, then a few rows are added by hand for the shapes the store no longer writes.
 */
export async function buildPopulatedV6(path: string): Promise<PopulatedRecord> {
  const store = new SqliteStore(path);
  const jobs: Record<string, string> = {};
  const holder = 'kernel-mac-before-copy';

  // Three kernel lives: generation 1 and 2 ran and released, generation 3 is the one the copy happens under.
  for (let i = 0; i < 2; i++) {
    const { generation } = await store.acquireLease(holder, 30_000);
    await store.releaseLease(holder, generation);
  }
  const { generation: leaseGeneration } = await store.acquireLease(holder, 3_600_000);

  const statuses = ['queued', 'running', 'awaiting_approval', 'done', 'failed', 'cancelled'] as const;
  for (const status of statuses) {
    const job = await store.createJob({ repo: `/repo/${status}`, title: `Job that is ${status}`, body: status === 'done' ? 'Text with "quotes", a tab\t and emoji \u{1F680} and é' : '' });
    if (status !== 'queued') await store.setJobStatus(job.id, status);
    jobs[status] = job.id;
  }

  // Claims under the generation that held the lease, written inside a fenced transaction as the kernel does.
  const fenced = async <T>(fn: (tx: SqliteStore) => Promise<T>): Promise<T> =>
    store.transaction(async (tx) => {
      await tx.assertLease(holder, leaseGeneration);
      return fn(tx as SqliteStore);
    });

  const done = jobs.done!;
  const plan = await fenced((tx) => tx.startStage(done, 'plan'));
  await fenced((tx) => tx.finishStage(plan.id, 'passed', { result: 'A plan.', costUsd: 0.5, nested: { b: [1, 2.5, null], a: 'x' } }));
  const build1 = await fenced((tx) => tx.startStage(done, 'build'));
  await fenced((tx) => tx.finishStage(build1.id, 'failed', { error: 'boom' }));
  const build2 = await fenced((tx) => tx.startStage(done, 'build')); // attempt 2
  await fenced((tx) => tx.finishStage(build2.id, 'passed', null)); // JSON null, which is not the same as no output

  // A stage left running with a live claim: the Mac kernel stopped in the middle of it.
  const busyJob = jobs.running!;
  const running = await fenced((tx) => tx.startStage(busyJob, 'build'));

  // Events: random ids, ids derived from a cause, none for a job, a bare number, no payload at all.
  const cause = (await store.appendEvent({ type: 'job.created', source: 'kernel', jobId: done, payload: { title: 'x' } })).id;
  await store.appendEvent({ id: derivedEventId(cause, 'pipeline-dev', 0, 'stage.requested'), type: 'stage.requested', source: 'pipeline-dev', jobId: done, payload: { stage: 'plan' } });
  await store.appendEvent({ id: derivedEventId(cause, 'pipeline-dev', 1, 'stage.requested'), type: 'stage.requested', source: 'pipeline-dev', jobId: done, payload: { stage: 'build' } });
  await store.appendEvent({ type: 'plugin.note', source: 'github', payload: null });
  await store.appendEvent({ type: 'plugin.count', source: 'github', payload: 5 });
  await store.appendEvent({ type: 'plugin.text', source: 'github', jobId: busyJob, payload: 'a plain string' });
  await store.appendEvent({ type: 'plugin.big', source: 'github', payload: { list: Array.from({ length: 50 }, (_, i) => ({ i, name: `item ${i}`, ratio: i / 7 })) } });

  await store.setState('github', 'cursor', { page: 7, seen: ['a', 'b'] });
  await store.setState('github', 'last-sha', 'abc123');
  await store.setState('channel-telegram', 'offset', 90210);
  await store.close();

  // Shapes the store no longer writes, added by hand: a stage from before claims existed (finished, no claim row), and a stage with
  // no output at all (SQL NULL), and a stage whose time was written without milliseconds.
  const raw = new Database(path);
  raw.pragma('foreign_keys = ON');
  raw.prepare("INSERT INTO stages (id, job_id, name, status, attempt, started_at, ended_at, output) VALUES ('legacy-stage-1', ?, 'docs', 'passed', 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:01:00.000Z', NULL)").run(done);
  raw.prepare("INSERT INTO stages (id, job_id, name, status, attempt, started_at, ended_at, output) VALUES ('legacy-stage-2', ?, 'review', 'failed', 1, '2026-09-01T00:02:00Z', '2026-09-01T00:03:00Z', '7')").run(done);
  raw.close();

  const check = new Database(path, { readonly: true });
  const stat = check.prepare('SELECT max(seq) AS last, count(*) AS n FROM events').get() as { last: number; n: number };
  check.close();
  return { jobs, busyJob, runningStage: running.id, leaseGeneration, lastSeq: stat.last, eventCount: stat.n };
}

/** Pretend the file is at another schema version, for the tests that must refuse it. */
export function setUserVersion(path: string, version: number): void {
  const raw = new Database(path);
  raw.pragma(`user_version = ${version}`);
  raw.close();
}
