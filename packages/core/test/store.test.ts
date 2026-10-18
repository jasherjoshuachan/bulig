import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
