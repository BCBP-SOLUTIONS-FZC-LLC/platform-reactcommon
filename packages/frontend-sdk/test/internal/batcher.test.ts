import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Batcher, type BatcherStats } from '../../src/internal/batcher.ts';

/** A send whose batches stay pending until released, to model a slow collector. */
function slowSend() {
  const sent: number[][] = [];
  const pending: ((ok: boolean) => void)[] = [];
  const send = (batch: number[]) =>
    new Promise<boolean>((resolve) => {
      sent.push(batch);
      pending.push(resolve);
    });
  const releaseAll = async (ok = true) => {
    while (pending.length > 0) pending.shift()!(ok);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { sent, send, releaseAll, pending };
}

const newStats = (): BatcherStats => ({ exported: 0, droppedQueueFull: 0, exportFailures: 0 });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Batcher', () => {
  it('sends a full batch at once and a partial one after the delay', async () => {
    const s = slowSend();
    const b = new Batcher(s.send, newStats(), { maxQueueSize: 10, batchSize: 2, delayMs: 1000, maxInFlight: 2 });
    b.add(1);
    expect(s.sent).toEqual([]);
    b.add(2);
    expect(s.sent).toEqual([[1, 2]]);
    b.add(3);
    expect(s.sent).toEqual([[1, 2]]);
    vi.advanceTimersByTime(1000);
    expect(s.sent).toEqual([[1, 2], [3]]);
  });

  it('keeps at most maxInFlight sends and queues the rest, dropping the oldest when full', async () => {
    vi.useRealTimers();
    const s = slowSend();
    const stats = newStats();
    const b = new Batcher(s.send, stats, { maxQueueSize: 3, batchSize: 1, delayMs: 60_000, maxInFlight: 2 });
    for (const n of [1, 2, 3, 4, 5, 6, 7]) b.add(n);
    // 1 and 2 are in flight; 3..7 wait in a queue of 3, so 3 and 4 are dropped.
    expect(s.sent).toEqual([[1], [2]]);
    expect(b.size).toBe(3);
    expect(stats.droppedQueueFull).toBe(2);
    await s.releaseAll();
    expect(s.sent).toEqual([[1], [2], [5], [6]]);
    await s.releaseAll();
    expect(s.sent.at(-1)).toEqual([7]);
    await s.releaseAll();
    expect(stats.exported).toBe(5);
  });

  it('counts failed, rejected and throwing sends and keeps going', async () => {
    vi.useRealTimers();
    const stats = newStats();
    let n = 0;
    const send = async () => {
      n++;
      if (n === 1) return false;
      if (n === 2) throw new Error('boom');
      return true;
    };
    const b = new Batcher<number>(send, stats, { maxQueueSize: 10, batchSize: 1, delayMs: 10, maxInFlight: 1 });
    b.add(1);
    b.add(2);
    b.add(3);
    await b.flush();
    expect(stats).toEqual({ exported: 1, droppedQueueFull: 0, exportFailures: 2 });
  });

  it('flush sends everything, partial batches included, within the in-flight limit', async () => {
    vi.useRealTimers();
    const sent: number[][] = [];
    let inFlight = 0;
    let peak = 0;
    const send = async (batch: number[]) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      sent.push(batch);
      inFlight--;
      return true;
    };
    const b = new Batcher(send, newStats(), { maxQueueSize: 100, batchSize: 3, delayMs: 60_000, maxInFlight: 2 });
    for (let i = 1; i <= 10; i++) b.add(i);
    await b.flush();
    expect(sent.flat().sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(b.size).toBe(0);
  });

  it('hands out its queue and takes items back at the front, still bounded', () => {
    const stats = newStats();
    const b = new Batcher(async () => true, stats, { maxQueueSize: 3, batchSize: 10, delayMs: 1000, maxInFlight: 1 });
    b.add(1);
    b.add(2);
    expect(b.takeAll()).toEqual([1, 2]);
    expect(b.size).toBe(0);
    b.add(3);
    b.requeue([1, 2, 9]);
    expect(b.takeAll()).toEqual([2, 9, 3]);
    expect(stats.droppedQueueFull).toBe(1);
  });
});
