import { describe, expect, it } from 'vitest';
import { Store } from '../src/index.ts';
import { tempDb } from './helpers.ts';

describe('store', () => {
  it('migrations are idempotent', () => {
    const path = tempDb();
    const a = new Store(path);
    const job = a.createJob({ repo: 'r', title: 't' });
    const v = a.schemaVersion;
    a.close();
    const b = new Store(path);
    expect(b.schemaVersion).toBe(v);
    expect(b.getJob(job.id)?.title).toBe('t');
    b.close();
  });

  it('starts at the latest schema version', () => {
    const s = new Store(tempDb());
    expect(s.schemaVersion).toBe(3);
    s.close();
  });

  it('job CRUD', () => {
    const s = new Store(tempDb());
    const job = s.createJob({ repo: 'bulig', title: 'first' });
    expect(job.status).toBe('queued');
    s.createJob({ repo: 'bulig', title: 'second' });
    expect(s.setJobStatus(job.id, 'running').status).toBe('running');
    expect(s.listJobs().map((j) => j.title)).toEqual(['first', 'second']);
    expect(s.listJobs({ status: 'running' }).map((j) => j.id)).toEqual([job.id]);
    expect(s.getJob('nope')).toBeUndefined();
    expect(() => s.setJobStatus('nope', 'done')).toThrow(/No such job/);
    s.close();
  });

  it('stage CRUD with attempt counting and JSON output', () => {
    const s = new Store(tempDb());
    const job = s.createJob({ repo: 'r', title: 't' });
    const first = s.startStage(job.id, 'build');
    expect(first).toMatchObject({ status: 'running', attempt: 1, endedAt: null, output: null });
    const done = s.finishStage(first.id, 'failed', { reason: 'tests' });
    expect(done).toMatchObject({ status: 'failed', output: { reason: 'tests' } });
    expect(done.endedAt).not.toBeNull();
    expect(s.startStage(job.id, 'build').attempt).toBe(2);
    expect(s.startStage(job.id, 'test').attempt).toBe(1);
    expect(s.listStages(job.id)).toHaveLength(3);
    expect(() => s.startStage('nope', 'build')).toThrow(/No such job/);
    s.close();
  });

  it('persists events in order with increasing seq', () => {
    const s = new Store(tempDb());
    const a = s.appendEvent({ type: 'a.one', source: 'x', payload: { n: 1 } });
    const b = s.appendEvent({ type: 'a.two', source: 'x', payload: null });
    const c = s.appendEvent({ type: 'a.three', source: 'x', payload: [3] });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(s.eventsAfter().map((e) => e.type)).toEqual(['a.one', 'a.two', 'a.three']);
    expect(s.eventsAfter(1).map((e) => e.type)).toEqual(['a.two', 'a.three']);
    expect(a.payload).toEqual({ n: 1 });
    s.close();
  });

  it('a job keeps its body, and defaults to empty', () => {
    const s = new Store(tempDb());
    expect(s.createJob({ repo: 'r', title: 'a', body: 'details' }).body).toBe('details');
    expect(s.createJob({ repo: 'r', title: 'b' }).body).toBe('');
    s.close();
  });

  it('plugin state is scoped by plugin and survives a reopen', () => {
    const path = tempDb();
    const a = new Store(path);
    expect(a.getState('p', 'offset')).toBeUndefined();
    a.setState('p', 'offset', 41);
    a.setState('p', 'offset', 42);
    a.setState('p', 'obj', { a: [1, 2] });
    a.setState('q', 'offset', 'other');
    a.close();
    const b = new Store(path);
    expect(b.getState('p', 'offset')).toBe(42);
    expect(b.getState('p', 'obj')).toEqual({ a: [1, 2] });
    expect(b.getState('q', 'offset')).toBe('other');
    expect(() => b.setState('p', 'bad', undefined)).toThrow(/not JSON/);
    b.close();
  });
});
