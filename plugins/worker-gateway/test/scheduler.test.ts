import { describe, expect, it } from 'vitest';
import { Scheduler, type Active, type Pending } from '../src/scheduler.ts';

let n = 0;
const pending = (s: Scheduler, over: Partial<Pending> = {}): Pending => {
  const key = over.key ?? `s${++n}`;
  return { key, stageId: key, jobId: `j${n}`, stage: 'plan', attempt: 1, project: '/a', payload: {}, reoffers: 0, seq: s.nextSeq(), ...over };
};
const active = (p: Pending, workerId = 'mac'): Active => ({ workerId, pending: p, generation: 1, lastBeat: 0, applied: false, finishing: false, lost: false });

describe('Scheduler', () => {
  it('serves the oldest stage first, per project', () => {
    const s = new Scheduler();
    const a1 = pending(s, { project: '/a' });
    const b1 = pending(s, { project: '/b' });
    const a2 = pending(s, { project: '/a' });
    s.add(a1);
    s.add(b1);
    s.add(a2);
    expect(s.take((p) => p.project === '/a')).toBe(a1);
    expect(s.take((p) => p.project === '/a')).toBe(a2);
    expect(s.take(() => true)).toBe(b1);
    expect(s.take(() => true)).toBeUndefined();
  });

  it('keeps one lane per job: its next stage waits while one is in someone\'s hands', () => {
    const s = new Scheduler();
    const first = pending(s, { jobId: 'j' });
    const next = pending(s, { jobId: 'j' });
    s.add(next);
    s.hold(active(first));
    expect(s.take(() => true)).toBeUndefined();
    s.release(first.key);
    expect(s.take(() => true)).toBe(next);
  });

  it('puts a stage back in its arrival order', () => {
    const s = new Scheduler();
    const [a, b, c] = [pending(s), pending(s), pending(s)];
    s.add(a);
    s.add(c);
    s.requeue(b);
    expect([s.take(() => true), s.take(() => true), s.take(() => true)]).toEqual([a, b, c]);
  });

  it('does not add a stage twice, queued or held', () => {
    const s = new Scheduler();
    const a = pending(s);
    expect(s.add(a)).toBe(true);
    expect(s.add({ ...a })).toBe(false);
    s.take(() => true);
    s.hold(active(a));
    expect(s.add({ ...a })).toBe(false);
  });

  it('counts what each worker holds', () => {
    const s = new Scheduler();
    s.hold(active(pending(s), 'mac'));
    s.hold(active(pending(s), 'mac'));
    s.hold(active(pending(s), 'pi'));
    expect([s.heldBy('mac'), s.heldBy('pi'), s.heldBy('local')]).toEqual([2, 1, 0]);
  });
});
