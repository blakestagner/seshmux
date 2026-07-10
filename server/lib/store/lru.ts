// Generic LRU cache, keyed by string. Map preserves insertion order, so recency is
// tracked by delete+re-set on every hit (moves the key to the end = newest) and
// eviction just deletes the first key (oldest = least-recently-used).

export class Lru<T> {
  private map = new Map<string, T>();

  constructor(private maxSize = 10) {}

  async get(key: string, compute: () => Promise<T>): Promise<T> {
    const cached = this.map.get(key);
    if (cached !== undefined) {
      // Touch: bump to most-recently-used.
      this.map.delete(key);
      this.map.set(key, cached);
      return cached;
    }

    const value = await compute();
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return value;
  }
}
