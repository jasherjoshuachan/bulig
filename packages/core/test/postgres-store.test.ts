import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertPostgresUrl, OtherWriterError, PostgresStore, SchemaNotReadyError, type PostgresStoreOptions, StoreBrokenError, StoreFatalError, StoreTimeoutError } from '../src/index.ts';
import { kernelWith, probe } from './helpers.ts';
import { describePg, usePgServer, type PgDatabase } from './pg-throwaway.ts';
import { describeStoreContract, type StoreHandle } from './store-contract.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A Postgres store whose next getJob first runs a real `pg_sleep` on the connection, so the database really is slow. */
class SleepyStore extends PostgresStore {
  sleepBeforeNextGetJob = 0;
  override async getJob(id: string) {
    if (this.sleepBeforeNextGetJob > 0) {
      const seconds = this.sleepBeforeNextGetJob;
      this.sleepBeforeNextGetJob = 0;
      await (this as unknown as { query(sql: string, params: unknown[]): Promise<unknown> }).query('SELECT pg_sleep($1)', [seconds]);
    }
    return super.getJob(id);
  }
}

describePg('PostgresStore', () => {
  const server = usePgServer();

  // The shared behaviour every adapter has to show: the same function SqliteStore runs.
  describeStoreContract(
    'PostgresStore',
    async (): Promise<StoreHandle> => {
      const db = await server().newDatabase();
      const handle: StoreHandle = {
        store: await PostgresStore.open(db.url),
        async reopen() {
          await handle.store.close();
          handle.store = await PostgresStore.open(db.url);
          return handle.store;
        },
        async dispose() {
          await handle.store.close().catch(() => {});
          await db.drop();
        },
      };
      return handle;
    },
    { schemaVersion: 3 },
  );

  // What belongs to Postgres alone.
  describe('PostgresStore specifics', () => {
    const dbs: PgDatabase[] = [];
    const stores: PostgresStore[] = [];
    afterEach(async () => {
      for (const s of stores.splice(0)) await s.close().catch(() => {});
      for (const d of dbs.splice(0)) await d.drop();
    });
    const freshDb = async () => {
      const db = await server().newDatabase();
      dbs.push(db);
      return db;
    };
    const open = async (url: string, options?: PostgresStoreOptions) => {
      const s = await PostgresStore.open(url, options);
      stores.push(s);
      return s;
    };
    /** A second connection, for looking at what the store left behind. */
    const peek = async <T>(url: string, sql: string): Promise<T[]> => {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        return (await c.query(sql)).rows as T[];
      } finally {
        await c.end();
      }
    };
    const raw = (s: PostgresStore) => s as unknown as { connected(): Promise<pg.Client> };

    it('the constructor does not touch the network, and a store that cannot connect rejects its first call', async () => {
      const s = new PostgresStore('postgresql://nobody@127.0.0.1:1/none');
      stores.push(s);
      let promise: Promise<unknown> | undefined;
      expect(() => (promise = s.getJob('x'))).not.toThrow();
      await expect(promise).rejects.toThrow();
      await s.close();
    });

    it('keeps the schema version in a table of its own, and a missing job is a rejection, not a throw', async () => {
      const db = await freshDb();
      const s = await open(db.url);
      expect(await peek(db.url, 'SELECT version FROM bulig_schema')).toEqual([{ version: 3 }]);
      let promise: Promise<unknown> | undefined;
      expect(() => (promise = s.setJobStatus('nope', 'done'))).not.toThrow();
      await expect(promise).rejects.toThrow(/No such job/);
    });

    it('opening the same database again applies nothing twice, and a newer database is refused', async () => {
      const db = await freshDb();
      const a = await open(db.url);
      const job = await a.createJob({ repo: 'r', title: 't' });
      const b = await open(db.url, { mode: 'reader' });
      expect((await b.getJob(job.id))?.title).toBe('t');
      expect(await peek(db.url, 'SELECT version FROM bulig_schema')).toEqual([{ version: 3 }]);
      await peek(db.url, 'UPDATE bulig_schema SET version = 99');
      await expect(PostgresStore.open(db.url, { mode: 'reader' })).rejects.toThrow(/schema version 99/);
    });

    it('two kernels opening a fresh database at the same moment: one gets it, the other is refused, and there is one schema', async () => {
      const db = await freshDb();
      const results = await Promise.allSettled([PostgresStore.open(db.url), PostgresStore.open(db.url)]);
      for (const r of results) if (r.status === 'fulfilled') stores.push(r.value);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(OtherWriterError);
      expect(await peek(db.url, 'SELECT version FROM bulig_schema')).toEqual([{ version: 3 }]);
    });

    describe('a reader never migrates', () => {
      it('on a database with no schema it is refused, with a message that points at the kernel, and creates nothing', async () => {
        const db = await freshDb();
        const err = await PostgresStore.open(db.url, { mode: 'reader' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SchemaNotReadyError);
        expect((err as SchemaNotReadyError).reason).toBe('empty');
        expect((err as Error).message).toMatch(/no Bulig schema yet. Run a job first/);
        expect(await peek(db.url, "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'")).toEqual([{ n: 0 }]);
      });

      it('on an older schema it is refused and the schema is left as it was; the writer upgrades it', async () => {
        const db = await freshDb();
        await (await open(db.url)).close();
        await peek(db.url, 'UPDATE bulig_schema SET version = 2');
        await peek(db.url, 'DROP TABLE plugin_state'); // what version 2 looked like
        const err = await PostgresStore.open(db.url, { mode: 'reader' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SchemaNotReadyError);
        expect((err as SchemaNotReadyError).reason).toBe('old');
        expect((err as Error).message).toMatch(/schema version 2 and this Bulig needs 3\. Start the kernel/);
        expect(await peek(db.url, 'SELECT version FROM bulig_schema')).toEqual([{ version: 2 }]);
        expect(await peek(db.url, "SELECT to_regclass('plugin_state') IS NULL AS missing")).toEqual([{ missing: true }]);
        const writer = await open(db.url);
        expect(await writer.schemaVersion()).toBe(3);
        await (await open(db.url, { mode: 'reader' })).schemaVersion();
      });

      it('on a newer schema it is refused', async () => {
        const db = await freshDb();
        await (await open(db.url)).close();
        await peek(db.url, 'UPDATE bulig_schema SET version = 99');
        await expect(PostgresStore.open(db.url, { mode: 'reader' })).rejects.toThrow(/schema version 99/);
      });
    });

    it('a transaction that carries on after a database error is not reported as committed', async () => {
      const db = await freshDb();
      const s = await open(db.url);
      const client = await raw(s).connected();
      await expect(
        s.transaction(async (tx) => {
          await tx.createJob({ repo: 'r', title: 'doomed' });
          await client.query('SELECT 1 FROM no_such_table').catch(() => {}); // the function swallows the error
          await tx.createJob({ repo: 'r', title: 'also doomed' }).catch(() => {});
        }),
      ).rejects.toThrow(/undone by the server/);
      expect(await s.listJobs()).toEqual([]);
      // and the connection is usable again
      await s.createJob({ repo: 'r', title: 'after' });
      expect((await s.listJobs()).map((j) => j.title)).toEqual(['after']);
    });

    it('the rejections the port promises do not abandon the transaction, so the function can carry on', async () => {
      const db = await freshDb();
      const s = await open(db.url);
      await s.transaction(async (tx) => {
        await tx.createJob({ repo: 'r', title: 'kept' });
        await expect(tx.setJobStatus('nope', 'done')).rejects.toThrow(/No such job/);
        await expect(tx.startStage('nope', 'x')).rejects.toThrow(/No such job/);
        await expect(tx.finishStage('nope', 'passed')).rejects.toThrow(/No such stage/);
        await expect(tx.setState('p', 'k', undefined)).rejects.toThrow(/not JSON/);
        await expect(tx.setState('p', 'k\u0000', 1)).rejects.toThrow(/NUL/);
        await tx.createJob({ repo: 'r', title: 'also kept' });
      });
      expect((await s.listJobs()).map((j) => j.title)).toEqual(['kept', 'also kept']);
    });

    it('a COMMIT that fails is fatal, and the transaction is not left open', async () => {
      const db = await freshDb();
      const s = await open(db.url);
      const client = await raw(s).connected();
      const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
      let failing = true;
      (client as unknown as { query: unknown }).query = (...args: unknown[]) =>
        failing && args[0] === 'COMMIT' ? Promise.reject(new Error('commit failed (simulated)')) : query(...args);
      const err = await s.transaction((tx) => tx.createJob({ repo: 'r', title: 'unsure' })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StoreFatalError);
      expect((err as Error).message).toMatch(/COMMIT failed/);
      failing = false;
      // The ROLLBACK that followed worked, so nothing was kept and nothing is open.
      expect(await s.listJobs()).toEqual([]);
    });

    it('a ROLLBACK that fails is fatal', async () => {
      const db = await freshDb();
      const s = await open(db.url);
      const client = await raw(s).connected();
      const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
      (client as unknown as { query: unknown }).query = (...args: unknown[]) =>
        args[0] === 'ROLLBACK' ? Promise.reject(new Error('rollback failed (simulated)')) : query(...args);
      const err = await s.transaction(async () => {
        throw new Error('the function fails');
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StoreFatalError);
      expect((err as Error).message).toMatch(/ROLLBACK failed after "the function fails"/);
      expect((err as StoreFatalError).cause).toMatchObject({ message: 'rollback failed (simulated)' });
    });

    describe('the writer lock (one kernel writes to a database)', () => {
      it('refuses a second writer while the first is open, and allows one after the first closes', async () => {
        const db = await freshDb();
        const first = await open(db.url);
        await first.createJob({ repo: 'r', title: 'mine' });
        const refused = await PostgresStore.open(db.url).then(() => 'opened', (e: unknown) => e);
        expect(refused).toBeInstanceOf(OtherWriterError);
        expect((refused as Error).message).toMatch(/Another Bulig kernel is already writing to this database/);
        // The refused one wrote nothing and left no connection behind.
        expect((await first.listJobs()).map((j) => j.title)).toEqual(['mine']);
        await first.close();
        const second = await open(db.url);
        expect((await second.listJobs()).map((j) => j.title)).toEqual(['mine']);
      });

      it('a reader is never refused, while a writer is open or when there are several', async () => {
        const db = await freshDb();
        const writer = await open(db.url);
        const job = await writer.createJob({ repo: 'r', title: 'seen' });
        const readers = await Promise.all([open(db.url, { mode: 'reader' }), open(db.url, { mode: 'reader' })]);
        for (const r of readers) expect((await r.getJob(job.id))?.title).toBe('seen');
        // A reader does not hold the lock: closing the writer frees it even while readers stay open.
        await writer.close();
        await open(db.url);
      });

      it('a writer that was aborted gives the lock up when its connection drops', async () => {
        const db = await freshDb();
        const first = await open(db.url);
        first.abort();
        const end = Date.now() + 5000;
        let second: PostgresStore | undefined;
        while (!second && Date.now() < end) {
          second = await open(db.url).catch(async (e: unknown) => {
            if (!(e instanceof OtherWriterError)) throw e;
            await sleep(50);
            return undefined;
          });
        }
        expect(second).toBeDefined();
      });

      it('a writer that fails to start (for example a newer database) does not keep the lock', async () => {
        const db = await freshDb();
        await (await open(db.url)).close();
        await peek(db.url, 'UPDATE bulig_schema SET version = 99');
        await expect(PostgresStore.open(db.url)).rejects.toThrow(/schema version 99/);
        await peek(db.url, 'UPDATE bulig_schema SET version = 3');
        await open(db.url); // would be refused if the failed start had kept the lock
      });
    });

    describe('connection strings', () => {
      it('refuses a string with no postgres:// or postgresql:// scheme, and never repeats it', () => {
        for (const bad of ['bulig:S3cretPW@just-text', 'S3cretPW', 'mysql://u:S3cretPW@h/db', 'http://u:S3cretPW@h/db']) {
          let message = '';
          try {
            new PostgresStore(bad);
          } catch (e) {
            message = (e as Error).message;
          }
          expect(message).toMatch(/must start with postgres:\/\/ or postgresql:\/\//);
          expect(message).not.toContain('S3cretPW');
        }
        expect(() => new PostgresStore('postgres://u@h/db')).not.toThrow();
        expect(() => new PostgresStore('postgres://u:pw@h:5433/db?sslmode=disable')).not.toThrow();
        expect(() => new PostgresStore('postgresql://u@[::1]:5432/db')).not.toThrow();
        expect(() => new PostgresStore('postgresql:///db?host=/var/run/postgresql')).not.toThrow();
        expect(() => new PostgresStore('PostgreSQL://u@h/db')).not.toThrow();
      });

      it('refuses a string with no host, because the driver would dial localhost on the default port; it only parses, it opens nothing', () => {
        for (const bad of ['postgres://', 'postgres:///bulig', 'postgresql://u:S3cretPW@/db', 'postgres://?sslmode=disable', 'postgres://u:S3cretPW@:5432/db', 'postgresql:///db?host=', 'postgres:///db&host=x', 'postgres:///db/&host=/tmp', 'postgres://u:S3cretPW@/db&host=evil']) {
          let message = '';
          try {
            new PostgresStore(bad);
          } catch (e) {
            message = (e as Error).message;
          }
          expect(message).toMatch(/must start with postgres:\/\/ or postgresql:\/\/ and name a host/);
          expect(message).not.toContain('S3cretPW');
          expect(() => assertPostgresUrl(bad)).toThrow(/name a host/);
        }
      });

      it('a string with a scheme that the driver cannot read fails without quoting it', async () => {
        const s = new PostgresStore('postgresql://bulig:S3cretPW@[not-a-host/db');
        stores.push(s);
        const err = await s.getJob('x').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect(String((err as Error).message)).not.toContain('S3cretPW');
      });
    });

    describe('abort()', () => {
      it('drops the connection: a statement in flight is rejected, nothing of the open transaction is kept, and later calls are refused', async () => {
        const db = await freshDb();
        const s = await open(db.url);
        const client = await raw(s).connected();
        const inFlight = s.transaction(async (tx) => {
          await tx.createJob({ repo: 'r', title: 'never committed' });
          await client.query('SELECT pg_sleep(5)'); // a call that does not come back in time
          await tx.createJob({ repo: 'r', title: 'never written' });
        });
        inFlight.catch(() => {});
        await sleep(150);
        const t0 = Date.now();
        s.abort();
        await expect(inFlight).rejects.toThrow(/terminated|aborted/i);
        expect(Date.now() - t0).toBeLessThan(2000);
        await expect(s.getJob('x')).rejects.toThrow(/aborted/);
        await expect(s.createJob({ repo: 'r', title: 'later' })).rejects.toThrow(/aborted/);
        await expect(s.transaction(async () => 1)).rejects.toThrow(/aborted/);
        await s.close(); // fine after an abort
        // The server rolled the open transaction back when the connection went away.
        await sleep(100);
        expect(await peek(db.url, 'SELECT title FROM jobs')).toEqual([]);
      });

      it('a transaction whose function wakes up after the abort sends no COMMIT', async () => {
        const db = await freshDb();
        const s = await open(db.url);
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const inFlight = s.transaction(async (tx) => {
          await tx.createJob({ repo: 'r', title: 'late' }).catch(() => {});
          await gate; // stuck on something that is not the database
          return 'finished';
        });
        inFlight.catch(() => {});
        await sleep(100);
        s.abort();
        release();
        await expect(inFlight).rejects.toThrow(/aborted/);
        expect(await peek(db.url, 'SELECT title FROM jobs')).toEqual([]);
      });
    });

    it('close() is safe twice, and a call after it is refused', async () => {
      const db = await freshDb();
      const s = await open(db.url);
      await s.close();
      await s.close();
      await expect(s.listJobs()).rejects.toThrow(/closed/);
    });

    it('close() on a store that never connected does nothing', async () => {
      const s = new PostgresStore('postgresql://nobody@127.0.0.1:1/none');
      await s.close();
      await expect(s.getJob('x')).rejects.toThrow(/closed/);
    });
  });

  // The queue rules on a real engine (ADR 0007): a call that really is slow because another connection holds a lock on the
  // table. This is not a stand-in wrapper. The server holds the statement, and the pg driver waits for the answer.
  describe('a real slow Postgres call', () => {
    const dbs: PgDatabase[] = [];
    const stores: PostgresStore[] = [];
    afterEach(async () => {
      for (const s of stores.splice(0)) await s.close().catch(() => {});
      for (const d of dbs.splice(0)) await d.drop();
    });

    /** Another connection takes an exclusive lock on `table` now and gives it back after `ms`. Resolves when the lock is held. */
    const holdLock = async (url: string, table: string, ms: number) => {
      const c = new pg.Client({ connectionString: url });
      c.on('error', () => {});
      await c.connect();
      await c.query('BEGIN');
      await c.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
      const heldAt = Date.now();
      const released = sleep(ms).then(async () => {
        await c.query('COMMIT');
        await c.end();
        return Date.now();
      });
      return { heldAt, released };
    };
    const rows = async <T>(url: string, sql: string): Promise<T[]> => {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        return (await c.query(sql)).rows as T[];
      } finally {
        await c.end();
      }
    };
    const setup = async () => {
      const db = await server().newDatabase();
      dbs.push(db);
      const store = await PostgresStore.open(db.url);
      stores.push(store);
      return { db, store };
    };

    it('a write held up past the deadline is rolled back, and the next task waits for it instead of overtaking it', async () => {
      const { db, store } = await setup();
      const { plugin, box } = probe();
      const k = kernelWith({ plugins: [plugin], store, storeTimeoutMs: 150, storeBrokenMs: 10_000 });
      await k.start();

      const lock = await holdLock(db.url, 'plugin_state', 700);
      const late = box.ctx!.state.set('offset', 41); // the INSERT waits on the server for the lock
      const behind = k.jobs.create({ repo: '/r', title: 'behind' }); // a different table, but queued after the late task
      const lateOutcome = await late.then(() => 'ok', (e: unknown) => e);
      const heardAt = Date.now();
      expect(lateOutcome).toBeInstanceOf(StoreTimeoutError);
      expect(heardAt - lock.heldAt).toBeLessThan(500); // the caller heard at the deadline, not when the lock came back

      const job = await behind;
      const releasedAt = await lock.released;
      // The next task started only once the late call had come back and been rolled back.
      expect(Date.now()).toBeGreaterThanOrEqual(releasedAt);
      expect(heardAt - lock.heldAt).toBeLessThan(Date.now() - lock.heldAt);
      expect(Date.now() - lock.heldAt).toBeGreaterThanOrEqual(650);

      // The late write did not stay.
      expect(await box.ctx!.state.get('offset')).toBeUndefined();
      expect(await rows(db.url, 'SELECT * FROM plugin_state')).toEqual([]);
      // The task behind it ran, once, in full.
      expect((await k.jobs.get(job.id))?.title).toBe('behind');
      expect(await rows(db.url, "SELECT type FROM events WHERE type = 'job.created'")).toHaveLength(1);
    });

    it('when the call never comes back in time the kernel gives up: later calls are refused, the connection is dropped, and nothing commits afterwards', async () => {
      const { db, store } = await setup();
      const { plugin, box } = probe();
      const errors: string[] = [];
      const k = kernelWith({
        plugins: [plugin],
        store,
        storeTimeoutMs: 100,
        storeBrokenMs: 300,
        logger: { debug() {}, info() {}, warn() {}, error: (m) => void errors.push(m) },
      });
      await k.start();

      const lock = await holdLock(db.url, 'plugin_state', 1500);
      const stuck = box.ctx!.state.set('offset', 41);
      const behind = k.jobs.create({ repo: '/r', title: 'behind' });
      const [a, b] = await Promise.allSettled([stuck, behind]);
      expect((a as PromiseRejectedResult).reason).toBeInstanceOf(StoreTimeoutError);
      expect((b as PromiseRejectedResult).reason).toBeInstanceOf(StoreBrokenError);
      expect(Date.now() - lock.heldAt).toBeLessThan(1200); // given up long before the lock came back
      await expect(k.jobs.create({ repo: '/r', title: 'later' })).rejects.toBeInstanceOf(StoreBrokenError);
      expect(errors.filter((e) => /record is unusable/.test(e))).toHaveLength(1);

      // Let the lock go. The statement the server was holding may now run, but its connection is gone and no COMMIT was sent.
      await lock.released;
      const gone = async () => (await rows<{ n: number }>(db.url, "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'bulig'"))[0]!.n === 0;
      const end = Date.now() + 5000;
      while (!(await gone()) && Date.now() < end) await sleep(50);
      expect(await gone()).toBe(true);
      expect(await rows(db.url, 'SELECT * FROM plugin_state')).toEqual([]);
      expect(await rows(db.url, 'SELECT * FROM jobs')).toEqual([]);
      // Only what was committed before: the kernel's own start-up event, and no job.created.
      expect((await rows<{ type: string }>(db.url, 'SELECT type FROM events')).map((e) => e.type)).toEqual(['kernel.started']);
      await k.stop(); // stopping a kernel whose store was given up on is quiet
    });

    it('a slow statement inside a task (pg_sleep) is held to the same rules: timed out, rolled back, the next task waits', async () => {
      const db = await server().newDatabase();
      dbs.push(db);
      const sleepy = await SleepyStore.open(db.url);
      stores.push(sleepy);
      const { plugin, box } = probe({ needs: ['jobs.write'] });
      const k = kernelWith({ plugins: [plugin], grants: { demo: ['jobs.write'] }, store: sleepy, storeTimeoutMs: 150, storeBrokenMs: 10_000 });
      await k.start();
      const job = await k.jobs.create({ repo: '/r', title: 't' });

      sleepy.sleepBeforeNextGetJob = 0.5;
      const t0 = Date.now();
      const first = box.ctx!.jobs.setStatus(job.id, 'running'); // reads the job first: held for 500 ms
      const second = box.ctx!.jobs.setStatus(job.id, 'cancelled');
      const [a, b] = await Promise.allSettled([first, second]);
      expect((a as PromiseRejectedResult).reason).toBeInstanceOf(StoreTimeoutError);
      expect(b.status).toBe('fulfilled');
      expect(Date.now() - t0).toBeGreaterThanOrEqual(480); // the second waited for the sleeping call
      expect((await k.jobs.get(job.id))!.status).toBe('cancelled');
      const changes = (await k.history(job.id)).filter((e) => e.type === 'job.status').map((e) => (e.payload as { to: string }).to);
      expect(changes).toEqual(['cancelled']);
      expect(await rows(db.url, 'SELECT count(*)::int AS n FROM jobs')).toEqual([{ n: 1 }]);
    });
  });
});
