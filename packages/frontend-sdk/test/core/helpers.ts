import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A shared fixture from contracts/fixtures (copied from platform-interop-tests by contracts:sync). */
export function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(import.meta.dirname, '../../contracts/fixtures', name), 'utf8')) as T;
}

/** A minimal in-memory Storage, with switches to make access or writes throw. */
export class FakeStorage implements Storage {
  private map = new Map<string, string>();
  failReads = false;
  failWrites = false;
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    if (this.failReads) throw new DOMException('denied', 'SecurityError');
    return this.map.get(key) ?? null;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException('full', 'QuotaExceededError');
    this.map.set(key, String(value));
  }
}
