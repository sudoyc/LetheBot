import { describe, expect, it, vi } from 'vitest';
import {
  TurnAdmissionController,
  TurnAdmissionRejectedError,
} from '../../../src/pi/turn-admission-controller.js';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('TurnAdmissionController', () => {
  it('serializes one key and overlaps distinct keys up to the global cap', async () => {
    const controller = new TurnAdmissionController(2);
    const releaseA = deferred();
    const releaseB = deferred();
    const started: string[] = [];
    let active = 0;
    let peak = 0;

    const run = (key: string, release: { promise: Promise<void> }) => controller.schedule(key, async () => {
      started.push(key);
      active += 1;
      peak = Math.max(peak, active);
      await release.promise;
      active -= 1;
      return key;
    });

    const firstA = run('a', releaseA);
    const secondA = run('a', releaseA);
    const firstB = run('b', releaseB);
    await Promise.resolve();

    expect(started).toEqual(['a', 'b']);
    expect(controller.activeCount).toBe(2);
    expect(controller.queuedCount).toBe(1);
    expect(peak).toBe(2);

    releaseA.resolve();
    await firstA;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual(['a', 'b', 'a']);

    releaseB.resolve();
    await Promise.all([secondA, firstB, controller.waitForIdle()]);
    expect(controller.activeCount).toBe(0);
    expect(controller.queuedCount).toBe(0);
  });

  it('releases a slot after rejection and lets the next key run', async () => {
    const controller = new TurnAdmissionController(1);
    const calls: string[] = [];
    const failed = controller.schedule('a', async () => {
      calls.push('a');
      throw new Error('synthetic failure');
    });
    const next = controller.schedule('b', async () => {
      calls.push('b');
      return 'ok';
    });

    await expect(failed).rejects.toThrow('synthetic failure');
    await expect(next).resolves.toBe('ok');
    expect(calls).toEqual(['a', 'b']);
    await expect(controller.waitForIdle()).resolves.toBeUndefined();
  });

  it('rejects work beyond the queued limit without invoking it', async () => {
    const controller = new TurnAdmissionController(1, 1);
    const release = deferred();
    const started: string[] = [];

    const active = controller.schedule('active', async () => {
      started.push('active');
      await release.promise;
    });
    const queued = controller.schedule('queued', async () => {
      started.push('queued');
    });
    const overloaded = controller.schedule('overloaded', async () => {
      started.push('overloaded');
    });

    await expect(overloaded).rejects.toMatchObject({
      name: 'TurnAdmissionOverloadedError',
      code: 'overloaded',
    } satisfies Partial<TurnAdmissionRejectedError>);
    expect(controller.activeCount).toBe(1);
    expect(controller.queuedCount).toBe(1);
    expect(started).toEqual(['active']);

    release.resolve();
    await Promise.all([active, queued, controller.waitForIdle()]);
    expect(started).toEqual(['active', 'queued']);
  });

  it('expires queued work at its absolute deadline without starting it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const controller = new TurnAdmissionController(1, 2);
      const release = deferred();
      const started: string[] = [];
      const active = controller.schedule('active', async () => {
        started.push('active');
        await release.promise;
      }, { deadlineAtMs: 10_000 });
      const queued = controller.schedule('queued', async () => {
        started.push('queued');
      }, { deadlineAtMs: 1_100 });

      const queuedRejection = expect(queued).rejects.toMatchObject({
        name: 'TurnAdmissionQueueTimeoutError',
        code: 'queue_timeout',
      } satisfies Partial<TurnAdmissionRejectedError>);
      await vi.advanceTimersByTimeAsync(101);
      await queuedRejection;
      expect(started).toEqual(['active']);
      expect(controller.queuedCount).toBe(0);

      release.resolve();
      await Promise.all([active, controller.waitForIdle()]);
      expect(started).toEqual(['active']);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([0, 17, 1.5])('rejects an invalid global cap %s', (value) => {
    expect(() => new TurnAdmissionController(value)).toThrow(RangeError);
  });

  it.each([-1, 129, 1.5])('rejects an invalid queue cap %s', (value) => {
    expect(() => new TurnAdmissionController(1, value)).toThrow(RangeError);
  });
});
