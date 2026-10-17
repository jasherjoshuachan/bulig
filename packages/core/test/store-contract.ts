import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../src/index.ts';

/**
 * One open store, plus a way to close it and open the same data again. How the data is kept (a file, a schema in a
 * database server) is the adapter's business; the contract only asks that data written before `reopen` is there after it.
 */
export interface StoreHandle {
  store: Store;
  /** Close the store and open a fresh one on the same data. `store` points at the new one afterwards. */
  reopen(): Promise<Store>;
  /** Close and throw away the data. Called after each test. */
  dispose(): Promise<void>;
}

export interface StoreContractOptions {
  /** How many migrations a store with the current code has applied. */
  schemaVersion: number;
}

/**
 * The behaviour every Store adapter must show (ADR 0007). SqliteStore runs it today; the Postgres adapter runs it next.
 * It must not lean on one engine: no file paths, no row ids, no sync calls, no exact event numbers.
 */
export function describeStoreContract(name: string, make: () => Promise<StoreHandle>, options: StoreContractOptions): void {
  describe(`Store contract: ${name}`, () => {
    const open: StoreHandle[] = [];
    const fresh = async () => {
      const h = await make();
      open.push(h);
      return h;
    };
    afterEach(async () => {
      for (const h of open.splice(0)) await h.dispose();
    });

    it('starts at the latest schema version, and opening again changes nothing', async () => {
      const h = await fresh();
      expect(await h.store.schemaVersion()).toBe(options.schemaVersion);
      const job = await h.store.createJob({ repo: 'r', title: 't' });
      const reopened = await h.reopen();
      expect(await reopened.schemaVersion()).toBe(options.schemaVersion);
      expect((await reopened.getJob(job.id))?.title).toBe('t');
    });

    it('creates a queued job with an empty body unless one is given', async () => {
      const { store } = await fresh();
      const plain = await store.createJob({ repo: 'bulig', title: 'first' });
      expect(plain).toMatchObject({ repo: 'bulig', title: 'first', body: '', status: 'queued' });
      expect(plain.id).toBeTruthy();
      expect(plain.createdAt).toBe(plain.updatedAt);
      expect((await store.createJob({ repo: 'r', title: 'b', body: 'details' })).body).toBe('details');
    });

    it('gets a job by id, and returns undefined for one that is not there', async () => {
      const { store } = await fresh();
      const job = await store.createJob({ repo: 'r', title: 't' });
      expect(await store.getJob(job.id)).toEqual(job);
      expect(await store.getJob('nope')).toBeUndefined();
    });

    it('lists jobs oldest first, and by status', async () => {
      const { store } = await fresh();
      const a = await store.createJob({ repo: 'r', title: 'first' });
      const b = await store.createJob({ repo: 'r', title: 'second' });
      const c = await store.createJob({ repo: 'r', title: 'third' });
      expect((await store.listJobs()).map((j) => j.title)).toEqual(['first', 'second', 'third']);
      await store.setJobStatus(b.id, 'running');
      expect((await store.listJobs({ status: 'running' })).map((j) => j.id)).toEqual([b.id]);
      expect((await store.listJobs({ status: 'queued' })).map((j) => j.id)).toEqual([a.id, c.id]);
      expect(await store.listJobs({ status: 'done' })).toEqual([]);
    });

    it('changes a job status and moves updatedAt, and rejects for a job that is not there', async () => {
      const { store } = await fresh();
      const job = await store.createJob({ repo: 'r', title: 't' });
      const running = await store.setJobStatus(job.id, 'running');
      expect(running.status).toBe('running');
      expect(running.createdAt).toBe(job.createdAt);
      expect(Date.parse(running.updatedAt)).toBeGreaterThanOrEqual(Date.parse(job.updatedAt));
      expect((await store.getJob(job.id))?.status).toBe('running');
      await expect(store.setJobStatus('nope', 'done')).rejects.toThrow(/No such job/);
    });

    it('starts stages with a running status and counts attempts per name', async () => {
      const { store } = await fresh();
      const job = await store.createJob({ repo: 'r', title: 't' });
      const first = await store.startStage(job.id, 'build');
      expect(first).toMatchObject({ jobId: job.id, name: 'build', status: 'running', attempt: 1, endedAt: null, output: null });
      expect((await store.startStage(job.id, 'build')).attempt).toBe(2);
      expect((await store.startStage(job.id, 'test')).attempt).toBe(1);
      const other = await store.createJob({ repo: 'r', title: 'other' });
      expect((await store.startStage(other.id, 'build')).attempt).toBe(1);
      await expect(store.startStage('nope', 'build')).rejects.toThrow(/No such job/);
    });

    it('lists the stages of a job in the order they started, and gets one by id', async () => {
      const { store } = await fresh();
      const job = await store.createJob({ repo: 'r', title: 't' });
      const a = await store.startStage(job.id, 'plan');
      const b = await store.startStage(job.id, 'build');
      const c = await store.startStage(job.id, 'plan');
      expect((await store.listStages(job.id)).map((s) => s.id)).toEqual([a.id, b.id, c.id]);
      expect(await store.listStages('nope')).toEqual([]);
      expect(await store.getStage(b.id)).toEqual(b);
      expect(await store.getStage('nope')).toBeUndefined();
    });

    it('finishes a stage with its output as JSON, and without one', async () => {
      const { store } = await fresh();
      const job = await store.createJob({ repo: 'r', title: 't' });
      const one = await store.startStage(job.id, 'build');
      const failed = await store.finishStage(one.id, 'failed', { reason: 'tests', nested: [1, { a: null }] });
      expect(failed).toMatchObject({ status: 'failed', output: { reason: 'tests', nested: [1, { a: null }] } });
      expect(failed.endedAt).not.toBeNull();
      expect(await store.getStage(one.id)).toEqual(failed);
      const two = await store.startStage(job.id, 'test');
      expect(await store.finishStage(two.id, 'passed')).toMatchObject({ status: 'passed', output: null });
      await expect(store.finishStage('nope', 'passed')).rejects.toThrow(/No such stage/);
    });

    it('keeps plugin state apart per plugin and key, overwrites, and returns undefined when unset', async () => {
      const { store } = await fresh();
      expect(await store.getState('p', 'offset')).toBeUndefined();
      await store.setState('p', 'offset', 41);
      await store.setState('p', 'offset', 42);
      await store.setState('p', 'obj', { a: [1, 2] });
      await store.setState('q', 'offset', 'other');
      await store.setState('p', 'nothing', null);
      expect(await store.getState('p', 'offset')).toBe(42);
      expect(await store.getState('p', 'obj')).toEqual({ a: [1, 2] });
      expect(await store.getState('q', 'offset')).toBe('other');
      expect(await store.getState('p', 'nothing')).toBeNull();
      expect(await store.getState('q', 'obj')).toBeUndefined();
    });

    it('rejects state that has no JSON form, and leaves the old value alone', async () => {
      const { store } = await fresh();
      await store.setState('p', 'k', 1);
      await expect(store.setState('p', 'k', undefined)).rejects.toThrow(/not JSON/);
      await expect(store.setState('p', 'k', () => 1)).rejects.toThrow(/not JSON/);
      expect(await store.getState('p', 'k')).toBe(1);
    });

    it('appends events with a seq that only goes up, and gives back what was written', async () => {
      const { store } = await fresh();
      const a = await store.appendEvent({ type: 'a.one', source: 'x', payload: { n: 1 } });
      const b = await store.appendEvent({ type: 'a.two', source: 'x', payload: null });
      const c = await store.appendEvent({ type: 'a.three', source: 'x', payload: [3] });
      expect(a.seq).toBeLessThan(b.seq!);
      expect(b.seq).toBeLessThan(c.seq!);
      expect(a).toMatchObject({ type: 'a.one', source: 'x', payload: { n: 1 } });
      expect(a.id).toBeTruthy();
      expect(a.jobId).toBeUndefined();
      expect(Date.parse(a.at)).not.toBeNaN();
      expect(c.payload).toEqual([3]);
    });

    it('reads events after a seq, oldest first', async () => {
      const { store } = await fresh();
      const a = await store.appendEvent({ type: 'a.one', source: 'x', payload: 1 });
      const b = await store.appendEvent({ type: 'a.two', source: 'x', payload: 2 });
      await store.appendEvent({ type: 'a.three', source: 'x', payload: 3 });
      expect((await store.eventsAfter()).map((e) => e.type)).toEqual(['a.one', 'a.two', 'a.three']);
      expect((await store.eventsAfter(a.seq)).map((e) => e.type)).toEqual(['a.two', 'a.three']);
      expect((await store.eventsAfter(b.seq)).map((e) => e.type)).toEqual(['a.three']);
      expect(await store.eventsAfter(1_000_000_000)).toEqual([]);
    });

    it('reads the events of one job in log order', async () => {
      const { store } = await fresh();
      const j1 = await store.createJob({ repo: 'r', title: '1' });
      const j2 = await store.createJob({ repo: 'r', title: '2' });
      await store.appendEvent({ type: 'e.1', source: 'x', jobId: j1.id, payload: null });
      await store.appendEvent({ type: 'e.2', source: 'x', jobId: j2.id, payload: null });
      await store.appendEvent({ type: 'e.3', source: 'x', payload: null });
      await store.appendEvent({ type: 'e.4', source: 'x', jobId: j1.id, payload: null });
      expect((await store.eventsForJob(j1.id)).map((e) => e.type)).toEqual(['e.1', 'e.4']);
      expect((await store.eventsForJob(j1.id)).every((e) => e.jobId === j1.id)).toBe(true);
      expect((await store.eventsForJob(j2.id)).map((e) => e.type)).toEqual(['e.2']);
      expect(await store.eventsForJob('nope')).toEqual([]);
    });

    it('applies calls made one after another in that order, even when they are not awaited one by one', async () => {
      const { store } = await fresh();
      const job = await store.createJob({ repo: 'r', title: 't' });
      const status1 = store.setJobStatus(job.id, 'running');
      const first = store.appendEvent({ type: 'e.1', source: 'x', payload: null });
      const status2 = store.setJobStatus(job.id, 'done');
      const second = store.appendEvent({ type: 'e.2', source: 'x', payload: null });
      await Promise.all([status1, status2]);
      const [e1, e2] = await Promise.all([first, second]);
      expect(e1!.seq).toBeLessThan(e2!.seq!);
      expect((await store.getJob(job.id))?.status).toBe('done');
    });

    it('rejects an event payload with no JSON form, and stores nothing for it', async () => {
      const { store } = await fresh();
      await expect(store.appendEvent({ type: 'a.b', source: 'x', payload: () => 1 })).rejects.toThrow(/not JSON/);
      await expect(store.appendEvent({ type: 'a.b', source: 'x', payload: Symbol('s') })).rejects.toThrow();
      expect(await store.eventsAfter()).toEqual([]);
      expect((await store.appendEvent({ type: 'a.b', source: 'x', payload: undefined })).payload).toBeNull();
    });

    it('rejects stage output with no JSON form, and leaves the stage running', async () => {
      const { store } = await fresh();
      const job = await store.createJob({ repo: 'r', title: 't' });
      const stage = await store.startStage(job.id, 'build');
      await expect(store.finishStage(stage.id, 'passed', () => 1)).rejects.toThrow(/not JSON/);
      expect(await store.getStage(stage.id)).toMatchObject({ status: 'running', endedAt: null, output: null });
    });

    it('keeps insertion order for jobs, stages and events made in quick succession, even when their timestamps tie', async () => {
      const { store } = await fresh();
      const titles: string[] = [];
      for (let i = 0; i < 40; i++) {
        titles.push(`job-${i}`);
        await store.createJob({ repo: 'r', title: `job-${i}` });
      }
      expect((await store.listJobs()).map((j) => j.title)).toEqual(titles);
      const job = (await store.listJobs())[0]!;
      const names: string[] = [];
      for (let i = 0; i < 40; i++) {
        names.push(`stage-${i}`);
        await store.startStage(job.id, `stage-${i}`);
      }
      expect((await store.listStages(job.id)).map((s) => s.name)).toEqual(names);
      // Made without waiting between them, so they are applied back to back.
      const made = await Promise.all(Array.from({ length: 40 }, (_, i) => store.createJob({ repo: 'r', title: `quick-${i}` })));
      expect((await store.listJobs()).slice(40).map((j) => j.id)).toEqual(made.map((j) => j.id));
    });

    describe('transaction', () => {
      it('keeps what a committed transaction wrote, and hands back its result', async () => {
        const { store } = await fresh();
        const result = await store.transaction(async (tx) => {
          const job = await tx.createJob({ repo: 'r', title: 'in a transaction' });
          await tx.appendEvent({ type: 'job.created', source: 'x', jobId: job.id, payload: null });
          expect((await tx.getJob(job.id))?.title).toBe('in a transaction'); // it sees its own writes
          return job.id;
        });
        expect((await store.getJob(result))?.title).toBe('in a transaction');
        expect(await store.eventsForJob(result)).toHaveLength(1);
      });

      it('keeps nothing of a transaction that rejects, and passes the error on', async () => {
        const { store } = await fresh();
        const before = await store.createJob({ repo: 'r', title: 'before' });
        await expect(
          store.transaction(async (tx) => {
            await tx.createJob({ repo: 'r', title: 'doomed' });
            await tx.setJobStatus(before.id, 'running');
            await tx.setState('p', 'k', 1);
            await tx.appendEvent({ type: 'a.b', source: 'x', payload: null });
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');
        expect((await store.listJobs()).map((j) => j.title)).toEqual(['before']);
        expect((await store.getJob(before.id))?.status).toBe('queued');
        expect(await store.getState('p', 'k')).toBeUndefined();
        expect(await store.eventsAfter()).toEqual([]);
      });

      it('keeps nothing when a call inside it rejects and the function lets that through', async () => {
        const { store } = await fresh();
        await expect(
          store.transaction(async (tx) => {
            await tx.createJob({ repo: 'r', title: 'doomed' });
            await tx.setJobStatus('nope', 'done');
          }),
        ).rejects.toThrow(/No such job/);
        expect(await store.listJobs()).toEqual([]);
      });

      it('works again after one was rolled back, and one after another commits in order', async () => {
        const { store } = await fresh();
        await store.transaction(async () => {
          throw new Error('first fails');
        }).catch(() => {});
        await store.transaction((tx) => tx.createJob({ repo: 'r', title: 'a' }));
        await store.transaction((tx) => tx.createJob({ repo: 'r', title: 'b' }));
        expect((await store.listJobs()).map((j) => j.title)).toEqual(['a', 'b']);
      });
    });

    it('keeps everything across a reopen', async () => {
      const h = await fresh();
      const job = await h.store.createJob({ repo: 'r', title: 't', body: 'b' });
      const stage = await h.store.startStage(job.id, 'plan');
      await h.store.finishStage(stage.id, 'passed', { ok: true });
      await h.store.setState('p', 'offset', 42);
      const ev = await h.store.appendEvent({ type: 'a.b', source: 'x', jobId: job.id, payload: { n: 1 } });
      const again = await h.reopen();
      expect(await again.getJob(job.id)).toEqual(job);
      expect(await again.listStages(job.id)).toEqual([await again.getStage(stage.id)]);
      expect((await again.getStage(stage.id))?.output).toEqual({ ok: true });
      expect(await again.getState('p', 'offset')).toBe(42);
      expect(await again.eventsForJob(job.id)).toEqual([ev]);
      const next = await again.appendEvent({ type: 'a.c', source: 'x', payload: null });
      expect(next.seq).toBeGreaterThan(ev.seq!);
    });
  });
}
