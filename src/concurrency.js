import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const defaultConcurrency = Object.freeze({ images: 10, videos: 10 });
export function validateConcurrency(input, current = defaultConcurrency) {
  const result = { ...current };
  for (const key of ['images', 'videos']) if (input[key] !== undefined) {
    if (!Number.isInteger(input[key]) || input[key] < 1 || input[key] > 50) throw new Error('并发数必须为1～50之间的整数');
    result[key] = input[key];
  }
  return result;
}

export class ConcurrencySettings {
  constructor(path) { this.path = path; this.value = { ...defaultConcurrency }; this.writes = Promise.resolve(); }
  async init() {
    try { this.value = validateConcurrency(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async save(input) {
    validateConcurrency(input, this.value);
    const next = this.writes.catch(() => {}).then(async () => {
      const value = validateConcurrency(input, this.value);
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
      await rename(temp, this.path); this.value = value;
      return { ...value };
    });
    this.writes = next; return next;
  }
}

// One shared pool per media type, including work from different projects and retries.
// A slot stays occupied through remote polling and download.
export class TaskPool {
  constructor(limit = 10) { this.limit = limit; this.running = 0; this.waiting = []; }
  setLimit(limit) { this.limit = limit; this.drain(); }
  stats() { return { limit: this.limit, running: this.running, queued: this.waiting.length }; }
  run(fn) {
    return new Promise((resolve, reject) => { this.waiting.push({ fn, resolve, reject }); this.drain(); });
  }
  drain() {
    while (this.running < this.limit && this.waiting.length) {
      const job = this.waiting.shift(); this.running++;
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { this.running--; this.drain(); });
    }
  }
}
