import { describe, it, expect, vi } from 'vitest';
import { Lru } from '../../server/lib/store/lru';

describe('Lru', () => {
  it('miss computes and caches', async () => {
    const lru = new Lru<number>(10);
    const compute = vi.fn(async () => 42);
    const v = await lru.get('a', compute);
    expect(v).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('hit returns cached value without recomputing', async () => {
    const lru = new Lru<number>(10);
    const compute = vi.fn(async () => 42);
    await lru.get('a', compute);
    const v = await lru.get('a', compute);
    expect(v).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('exceeding maxSize evicts the least-recently-used key', async () => {
    const lru = new Lru<number>(2);
    const computeA = vi.fn(async () => 1);
    const computeB = vi.fn(async () => 2);
    const computeC = vi.fn(async () => 3);

    await lru.get('a', computeA);
    await lru.get('b', computeB);
    await lru.get('c', computeC); // evicts 'a' (oldest, untouched)

    // 'a' was evicted -> recomputes (cache miss)
    await lru.get('a', computeA);
    expect(computeA).toHaveBeenCalledTimes(2);

    // 'b' and 'c' should still be cached
    await lru.get('c', computeC);
    expect(computeC).toHaveBeenCalledTimes(1);
  });

  it('touching a key via get keeps it from eviction', async () => {
    const lru = new Lru<number>(2);
    const computeA = vi.fn(async () => 1);
    const computeB = vi.fn(async () => 2);
    const computeC = vi.fn(async () => 3);

    await lru.get('a', computeA);
    await lru.get('b', computeB);
    await lru.get('a', computeA); // touch 'a' -> now 'b' is oldest
    await lru.get('c', computeC); // evicts 'b'

    // 'a' should still be cached (was touched)
    await lru.get('a', computeA);
    expect(computeA).toHaveBeenCalledTimes(1);

    // 'b' should have been evicted
    await lru.get('b', computeB);
    expect(computeB).toHaveBeenCalledTimes(2);
  });
});
