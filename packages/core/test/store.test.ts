import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../src/index.ts';
import { tempDb } from './helpers.ts';
import { describeStoreContract, type StoreHandle } from './store-contract.ts';

// The shared behaviour every adapter has to show. postgres-store.test.ts runs the same function for PostgresStore.
describeStoreContract(
  'SqliteStore',
  async (): Promise<StoreHandle> => {
    const dir = mkdtempSync(join(tmpdir(), 'bulig-contract-'));
    const path = join(dir, 'bulig.sqlite');
    const handle: StoreHandle = {
      store: new SqliteStore(path),
      async reopen() {
        await handle.store.close();
        handle.store = new SqliteStore(path);
        return handle.store;
      },
      async dispose() {
        await handle.store.close().catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      },
    };
    return handle;
  },
  { schemaVersion: 6 },
);

// What belongs to SQLite alone.
describe('SqliteStore', () => {
  it('a missing job is a rejection, not a throw before the promise exists', async () => {
    const s = new SqliteStore(tempDb());
    let promise: Promise<unknown> | undefined;
    expect(() => (promise = s.setJobStatus('nope', 'done'))).not.toThrow();
    await expect(promise).rejects.toThrow(/No such job/);
    await s.close();
  });

  it('the same file can be opened twice in a row', async () => {
    const path = tempDb();
    const a = new SqliteStore(path);
    const job = await a.createJob({ repo: 'r', title: 't' });
    await a.close();
    const b = new SqliteStore(path);
    expect((await b.getJob(job.id))?.title).toBe('t');
    await b.close();
  });

  it('the database itself allows one live claim per job stage, whatever the code above it does (the partial unique index)', async () => {
    const path = tempDb();
    const s = new SqliteStore(path);
    const job = await s.createJob({ repo: 'r', title: 't' });
    await s.startStage(job.id, 'build');
    const raw = new Database(path);
    const claim = raw.prepare("INSERT INTO claims (job_id, stage, generation, attempt, claimed_at) VALUES (?, 'build', 0, 2, 'now')");
    expect(() => claim.run(job.id)).toThrow(/UNIQUE/);
    // a released claim does not count, and other stages and jobs are free
    raw.prepare("UPDATE claims SET released_at = 'now' WHERE job_id = ?").run(job.id);
    expect(() => claim.run(job.id)).not.toThrow();
    raw.close();
    await s.close();
  });

  it('the database itself refuses a second event with the same id', async () => {
    const path = tempDb();
    const s = new SqliteStore(path);
    await s.appendEvent({ id: 'evt-1', type: 'a.b', source: 'x', payload: null });
    const raw = new Database(path);
    expect(() => raw.prepare("INSERT INTO events (id, type, source, at) VALUES ('evt-1', 'a.b', 'x', 'now')").run()).toThrow(/UNIQUE/);
    raw.close();
    await s.close();
  });
});
