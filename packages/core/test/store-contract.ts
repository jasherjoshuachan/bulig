import { afterEach, describe, expect, it } from 'vitest';
import { DuplicateEventError, LeaseHeldError, LeaseLostError, StageClaimedError, StageNotClaimedError, StoreBrokenError, StoreQueue, type Store } from '../src/index.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
 * The behaviour every Store adapter must show (ADR 0007). SqliteStore runs it in store.test.ts and PostgresStore in postgres-store.test.ts.
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
      // A stage is claimed while it runs (ADR 0010): the next attempt starts once the last one has finished.
      await store.finishStage(first.id, 'failed');
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
      await store.finishStage(a.id, 'passed');
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

    it('refuses an event number that is not a non-negative safe integer, before any SQL, and the transaction stays usable', async () => {
      const { store } = await fresh();
      await store.appendEvent({ type: 'a.one', source: 'x', payload: 1 });
      for (const bad of [1.5, Number.NaN, -1, 2 ** 63, Number.POSITIVE_INFINITY, 2 ** 53]) {
        await expect(store.eventsAfter(bad)).rejects.toThrow(/afterSeq must be a non-negative safe integer/);
      }
      expect(await store.eventsAfter(0)).toHaveLength(1);
      await store.transaction(async (tx) => {
        await tx.createJob({ repo: 'r', title: 'kept' });
        await expect(tx.eventsAfter(1.5)).rejects.toThrow(/afterSeq/);
        await tx.createJob({ repo: 'r', title: 'also kept' });
      });
      expect((await store.listJobs()).map((j) => j.title)).toEqual(['kept', 'also kept']);
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

    it('accepts a lone surrogate (half an emoji) in any JSON value and reads it back as U+FFFD, and keeps whole emoji', async () => {
      const { store } = await fresh();
      const half = 'cut here \ud83e';
      const robot = '\u{1F916}';
      await store.setState('p', 'k', { a: [half, { n: `x\udd16y` }], robot });
      expect(await store.getState('p', 'k')).toEqual({ a: ['cut here \ufffd', { n: 'x\ufffdy' }], robot });
      await store.setState('p', 'bare', half);
      expect(await store.getState('p', 'bare')).toBe('cut here \ufffd');
      const ev = await store.appendEvent({ type: 'a.b', source: 'x', payload: { evidence: [{ target: half }], 'key\ud83e': 1 } });
      expect(ev.payload).toEqual({ evidence: [{ target: 'cut here \ufffd' }], 'key\ufffd': 1 });
      expect((await store.eventsAfter())[0]!.payload).toEqual(ev.payload);
      const job = await store.createJob({ repo: 'r', title: 't' });
      const stage = await store.startStage(job.id, 'build');
      expect((await store.finishStage(stage.id, 'passed', { result: half })).output).toEqual({ result: 'cut here \ufffd' });
      // Text that only looks like an escape is just text.
      await store.setState('p', 'text', 'literal \\ud83e and \\u0000');
      expect(await store.getState('p', 'text')).toBe('literal \\ud83e and \\u0000');
    });

    it('keeps a NUL character in a JSON string as U+FFFD, the same on every engine', async () => {
      const { store } = await fresh();
      await store.setState('p', 'k', ['a\u0000b', { 'k\u0000': 'v' }]);
      expect(await store.getState('p', 'k')).toEqual(['a\ufffdb', { 'k\ufffd': 'v' }]);
    });

    it('refuses a NUL character in a plain text column or an identifier before it reaches the engine, and stores nothing', async () => {
      const { store } = await fresh();
      const job = await store.createJob({ repo: 'r', title: 't' });
      const stage = await store.startStage(job.id, 'build');
      const nul = (s: string) => `${s}\u0000${s}`;
      const refused = [
        store.createJob({ repo: nul('r'), title: 't' }),
        store.createJob({ repo: 'r', title: nul('t') }),
        store.createJob({ repo: 'r', title: 't', body: nul('b') }),
        store.setJobStatus(nul('id'), 'done'),
        store.startStage(job.id, nul('name')),
        store.finishStage(stage.id, nul('passed') as 'passed'),
        store.setState(nul('p'), 'k', 1),
        store.setState('p', nul('k'), 1),
        store.getState('p', nul('k')),
        store.appendEvent({ type: nul('a.b'), source: 'x', payload: null }),
        store.appendEvent({ type: 'a.b', source: nul('x'), payload: null }),
        store.getJob(nul('id')),
        store.eventsForJob(nul('id')),
      ];
      for (const p of refused) await expect(p).rejects.toThrow(/NUL/);
      expect((await store.listJobs()).map((j) => j.title)).toEqual(['t']);
      expect(await store.eventsAfter()).toEqual([]);
      expect(await store.getState('p', 'k')).toBeUndefined();
    });

    it('a NUL refusal inside a transaction leaves the transaction usable, so the rest of it still commits', async () => {
      const { store } = await fresh();
      await store.transaction(async (tx) => {
        await tx.createJob({ repo: 'r', title: 'before' });
        await expect(tx.createJob({ repo: 'r', title: 'bad\u0000' })).rejects.toThrow(/NUL/);
        await expect(tx.setState('p', 'k\u0000', 1)).rejects.toThrow(/NUL/);
        await tx.createJob({ repo: 'r', title: 'after' });
      });
      expect((await store.listJobs()).map((j) => j.title)).toEqual(['before', 'after']);
    });

    it('stores a lone surrogate in a title as U+FFFD', async () => {
      const { store } = await fresh();
      const job = await store.createJob({ repo: 'r', title: 'half \ud83e' });
      expect(job.title).toBe('half \ufffd');
      expect((await store.getJob(job.id))?.title).toBe('half \ufffd');
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

    describe('executor lease (ADR 0010)', () => {
      const TTL = 250; // long enough that a slow moment on a busy machine does not end it early, short enough to wait out
      const SHORT_WAIT = TTL + 150;

      it('gives the first holder generation 1, lets the same holder in again with a higher number, and keeps a second holder out while it runs', async () => {
        const { store } = await fresh();
        expect(await store.acquireLease('a', 60_000)).toEqual({ generation: 1 });
        expect(await store.acquireLease('a', 60_000)).toEqual({ generation: 2 });
        const err = await store.acquireLease('b', 60_000).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(LeaseHeldError);
        expect((err as LeaseHeldError).holder).toBe('a');
        // the refused attempt changed nothing
        expect(await store.renewLease('a', 2, 60_000)).toBe(true);
      });

      it('lets another holder take it after it runs out, with the next generation, and the old holder is then refused everywhere', async () => {
        const { store } = await fresh();
        const a = await store.acquireLease('a', TTL);
        await sleep(SHORT_WAIT);
        const b = await store.acquireLease('b', 60_000);
        expect(b.generation).toBe(a.generation + 1);
        expect(await store.renewLease('a', a.generation, 60_000)).toBe(false);
        await expect(store.transaction((tx) => tx.assertLease('a', a.generation))).rejects.toBeInstanceOf(LeaseLostError);
        await expect(store.transaction((tx) => tx.assertLease('b', b.generation))).resolves.toBeUndefined();
      });

      it('refuses a write from the old holder after a takeover, and keeps nothing of it', async () => {
        const { store } = await fresh();
        const a = await store.acquireLease('a', TTL);
        await sleep(SHORT_WAIT);
        await store.acquireLease('b', 60_000);
        const late = store.transaction(async (tx) => {
          await tx.assertLease('a', a.generation);
          await tx.createJob({ repo: 'r', title: 'late write from the old holder' });
        });
        await expect(late).rejects.toBeInstanceOf(LeaseLostError);
        expect(await store.listJobs()).toEqual([]);
      });

      it('refuses a stale generation even when the holder name is right', async () => {
        const { store } = await fresh();
        const first = await store.acquireLease('a', 60_000);
        const second = await store.acquireLease('a', 60_000);
        await expect(store.transaction((tx) => tx.assertLease('a', first.generation))).rejects.toBeInstanceOf(LeaseLostError);
        await expect(store.transaction((tx) => tx.assertLease('a', second.generation))).resolves.toBeUndefined();
      });

      it('refuses the holder itself once its lease has run out, even before anyone else takes it', async () => {
        const { store } = await fresh();
        const a = await store.acquireLease('a', TTL);
        await sleep(SHORT_WAIT);
        await expect(store.transaction((tx) => tx.assertLease('a', a.generation))).rejects.toBeInstanceOf(LeaseLostError);
        expect(await store.renewLease('a', a.generation, 60_000)).toBe(false);
      });

      it('refuses an assertion when no lease was ever taken', async () => {
        const { store } = await fresh();
        await expect(store.transaction((tx) => tx.assertLease('a', 1))).rejects.toBeInstanceOf(LeaseLostError);
      });

      it('renews only for the current holder and generation, and a renewal moves the end out', async () => {
        const { store } = await fresh();
        const a = await store.acquireLease('a', TTL);
        expect(await store.renewLease('a', a.generation + 1, 60_000)).toBe(false);
        expect(await store.renewLease('b', a.generation, 60_000)).toBe(false);
        expect(await store.renewLease('a', a.generation, 60_000)).toBe(true);
        await sleep(SHORT_WAIT); // would have run out without the renewal
        await expect(store.acquireLease('b', 60_000)).rejects.toBeInstanceOf(LeaseHeldError);
      });

      it('lets the next holder in at once after a release, and the number still goes up', async () => {
        const { store } = await fresh();
        const a = await store.acquireLease('a', 60_000);
        await store.releaseLease('a', a.generation);
        expect((await store.acquireLease('b', 60_000)).generation).toBe(a.generation + 1);
        // a release by someone who no longer holds it does nothing
        await store.releaseLease('a', a.generation);
        await expect(store.acquireLease('c', 60_000)).rejects.toBeInstanceOf(LeaseHeldError);
      });

      it('rejects a lease length that is not a positive whole number of milliseconds', async () => {
        const { store } = await fresh();
        await expect(store.acquireLease('a', 0)).rejects.toThrow(/positive whole number/);
        await expect(store.acquireLease('a', 1.5)).rejects.toThrow(/positive whole number/);
        await expect(store.renewLease('a', 1, -1)).rejects.toThrow(/positive whole number/);
      });

      it('can be renewed while a transaction is open and waiting, and the renewal is not undone when that transaction rolls back', async () => {
        const { store } = await fresh();
        const a = await store.acquireLease('a', 400);
        let renewed: boolean | undefined;
        await store
          .transaction(async (tx) => {
            await tx.assertLease('a', a.generation);
            await tx.createJob({ repo: 'r', title: 'doomed' });
            // the transaction now waits; the heartbeat has its own way in
            await sleep(150);
            renewed = await store.renewLease('a', a.generation, 60_000);
            throw new Error('rolled back');
          })
          .catch(() => {});
        expect(renewed).toBe(true);
        expect(await store.listJobs()).toEqual([]);
        await sleep(450); // past the original 400 ms
        await expect(store.acquireLease('b', 60_000)).rejects.toBeInstanceOf(LeaseHeldError);
      });
    });

    describe('claims (ADR 0010)', () => {
      const TTL = 250; // long enough that a slow moment on a busy machine does not end it early, short enough to wait out
      const SHORT_WAIT = TTL + 150;
      /** Run `fn` as a task of a queue fenced with this lease, the way the kernel does. */
      const fenced = (store: Store, holder: string, generation: number) => {
        const queue = new StoreQueue(store);
        queue.setFence({ holder, generation });
        return queue;
      };

      it('refuses to start a stage that is already running, and allows it again once it has finished', async () => {
        const { store } = await fresh();
        const job = await store.createJob({ repo: 'r', title: 't' });
        const first = await store.startStage(job.id, 'build');
        const err = await store.startStage(job.id, 'build').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(StageClaimedError);
        expect(err).toMatchObject({ jobId: job.id, stage: 'build', attempt: 1 });
        expect(await store.listStages(job.id)).toHaveLength(1); // the refused start wrote no stage row
        await store.finishStage(first.id, 'passed');
        expect((await store.startStage(job.id, 'build')).attempt).toBe(2);
      });

      it('claims per stage of a job: other stages of the job, and the same stage of other jobs, run side by side', async () => {
        const { store } = await fresh();
        const a = await store.createJob({ repo: 'r', title: 'a' });
        const b = await store.createJob({ repo: 'r', title: 'b' });
        const held = [await store.startStage(a.id, 'build'), await store.startStage(a.id, 'test'), await store.startStage(b.id, 'build')];
        expect(held.every((s) => s.status === 'running' && s.attempt === 1)).toBe(true);
      });

      it('lets exactly one of two racing starts of one stage win', async () => {
        const { store } = await fresh();
        const { generation } = await store.acquireLease('a', 60_000);
        const job = await store.createJob({ repo: 'r', title: 't' });
        const queue = fenced(store, 'a', generation);
        const results = await Promise.allSettled([
          queue.run('one', (tx) => tx.startStage(job.id, 'build')),
          queue.run('two', (tx) => tx.startStage(job.id, 'build')),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
        const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        expect(lost.reason).toBeInstanceOf(StageClaimedError);
        expect(await store.listStages(job.id)).toHaveLength(1);
      });

      it('lets only one of two starts of a stage made at the same moment outside a transaction through', async () => {
        const { store } = await fresh();
        const job = await store.createJob({ repo: 'r', title: 't' });
        const results = await Promise.allSettled([store.startStage(job.id, 'plan'), store.startStage(job.id, 'plan')]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      });

      it('takes a stage over from a holder that lost the lease: new attempt, old claim released as lease-lost, old stage closed as interrupted', async () => {
        const { store } = await fresh();
        const a = await store.acquireLease('a', TTL);
        const job = await store.createJob({ repo: 'r', title: 't' });
        const old = await fenced(store, 'a', a.generation).run('start', (tx) => tx.startStage(job.id, 'build'));
        await sleep(SHORT_WAIT);
        const b = await store.acquireLease('b', 60_000);
        const taken = await fenced(store, 'b', b.generation).run('take over', (tx) => tx.startStage(job.id, 'build'));
        expect(taken.attempt).toBe(2);
        expect(taken.status).toBe('running');
        const closed = await store.getStage(old.id);
        expect(closed).toMatchObject({ status: 'failed', output: { interrupted: true, reason: 'lease-lost' } });
        expect(closed?.endedAt).not.toBeNull();
        // and the new holder's claim is a real one
        await expect(fenced(store, 'b', b.generation).run('again', (tx) => tx.startStage(job.id, 'build'))).rejects.toBeInstanceOf(StageClaimedError);
      });

      it('refuses the old attempt a finish once its claim was taken over: the attempt number is the fence', async () => {
        const { store } = await fresh();
        const a = await store.acquireLease('a', TTL);
        const job = await store.createJob({ repo: 'r', title: 't' });
        const old = await fenced(store, 'a', a.generation).run('start', (tx) => tx.startStage(job.id, 'build'));
        await sleep(SHORT_WAIT);
        const b = await store.acquireLease('b', 60_000);
        const next = await fenced(store, 'b', b.generation).run('take over', (tx) => tx.startStage(job.id, 'build'));
        // A late finish for attempt 1 that got past the lease check (it is not fenced here) still bounces off the claim.
        const err = await store.finishStage(old.id, 'passed', { late: true }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(StageNotClaimedError);
        expect((await store.getStage(old.id))?.output).toMatchObject({ reason: 'lease-lost' }); // the late output was not kept
        // and the live attempt can still finish
        expect((await store.finishStage(next.id, 'passed')).status).toBe('passed');
      });

      it('lets a newer generation finish a stage the dead kernel left running, which is how a restart closes it', async () => {
        const { store } = await fresh();
        const a = await store.acquireLease('a', TTL);
        const job = await store.createJob({ repo: 'r', title: 't' });
        const left = await fenced(store, 'a', a.generation).run('start', (tx) => tx.startStage(job.id, 'build'));
        await sleep(SHORT_WAIT);
        const b = await store.acquireLease('b', 60_000);
        const closed = await fenced(store, 'b', b.generation).run('close', (tx) => tx.finishStage(left.id, 'failed', { interrupted: true }));
        expect(closed.status).toBe('failed');
        expect((await store.startStage(job.id, 'build')).attempt).toBe(2);
      });

      it('refuses to finish a stage twice', async () => {
        const { store } = await fresh();
        const job = await store.createJob({ repo: 'r', title: 't' });
        const stage = await store.startStage(job.id, 'build');
        await store.finishStage(stage.id, 'passed', { n: 1 });
        await expect(store.finishStage(stage.id, 'failed', { n: 2 })).rejects.toBeInstanceOf(StageNotClaimedError);
        expect((await store.getStage(stage.id))?.output).toEqual({ n: 1 });
      });

      it('keeps a refused start, or a refused finish, from spoiling the rest of its transaction', async () => {
        const { store } = await fresh();
        const job = await store.createJob({ repo: 'r', title: 't' });
        const stage = await store.startStage(job.id, 'build');
        await store.finishStage(stage.id, 'passed');
        const open = await store.startStage(job.id, 'build');
        await store.transaction(async (tx) => {
          await expect(tx.startStage(job.id, 'build')).rejects.toBeInstanceOf(StageClaimedError);
          await expect(tx.finishStage(stage.id, 'failed')).rejects.toBeInstanceOf(StageNotClaimedError);
          await tx.createJob({ repo: 'r', title: 'still works' });
        });
        expect((await store.listJobs()).map((j) => j.title)).toContain('still works');
        expect((await store.getStage(open.id))?.status).toBe('running');
      });

      it('breaks the queue and writes nothing when a task is run under a lease that was taken away', async () => {
        const { store } = await fresh();
        const a = await store.acquireLease('a', TTL);
        const queue = fenced(store, 'a', a.generation);
        await queue.run('before', (tx) => tx.createJob({ repo: 'r', title: 'ok while it holds the lease' }));
        await sleep(SHORT_WAIT);
        await store.acquireLease('b', 60_000);
        const late = queue.run('late', (tx) => tx.createJob({ repo: 'r', title: 'late' }));
        await expect(late).rejects.toBeInstanceOf(StoreBrokenError);
        await expect(late).rejects.toThrow(/executor lease was lost/);
        await expect(queue.run('read', (tx) => tx.listJobs())).rejects.toBeInstanceOf(StoreBrokenError);
        expect(queue.brokenError).toBeInstanceOf(StoreBrokenError);
      });
    });

    describe('event ids (ADR 0010)', () => {
      it('writes an event under the id it is given, and rejects a second event with the same id, keeping the first', async () => {
        const { store } = await fresh();
        const first = await store.appendEvent({ id: 'evt-1', type: 'a.b', source: 'x', payload: { n: 1 } });
        expect(first.id).toBe('evt-1');
        const err = await store.appendEvent({ id: 'evt-1', type: 'a.b', source: 'x', payload: { n: 2 } }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DuplicateEventError);
        expect((err as DuplicateEventError).existing).toEqual(first); // the event already held, so a caller can hand it back
        expect((await store.eventsAfter()).map((e) => e.payload)).toEqual([{ n: 1 }]);
      });

      it('leaves the transaction usable after a duplicate, so the rest of it still commits', async () => {
        const { store } = await fresh();
        await store.appendEvent({ id: 'evt-1', type: 'a.b', source: 'x', payload: null });
        await store.transaction(async (tx) => {
          await expect(tx.appendEvent({ id: 'evt-1', type: 'a.c', source: 'x', payload: null })).rejects.toBeInstanceOf(DuplicateEventError);
          await tx.appendEvent({ type: 'a.d', source: 'x', payload: null });
        });
        expect((await store.eventsAfter()).map((e) => e.type)).toEqual(['a.b', 'a.d']);
      });

      it('still makes its own id when none is given, and two such events never collide', async () => {
        const { store } = await fresh();
        const [a, b] = [await store.appendEvent({ type: 'a.b', source: 'x', payload: null }), await store.appendEvent({ type: 'a.b', source: 'x', payload: null })];
        expect(a.id).not.toBe(b.id);
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
