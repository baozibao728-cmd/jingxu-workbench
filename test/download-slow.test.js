import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadResult } from '../src/http.js';

const slowBody = (chunks, gapMs) => new ReadableStream({ async start(c) { for (const chunk of chunks) { await new Promise(r => setTimeout(r, gapMs)); c.enqueue(new TextEncoder().encode(chunk)); } c.close(); } });

test('下载慢但一直有数据，总时长超过 timeoutMs 也能下完', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jingxu-dl-'));
  try {
    const out = join(dir, 'v.mp4');
    // 每 30ms 来一块，共 6 块（约 180ms），空闲上限 80ms：总时长超过上限但不算超时。
    const result = await downloadResult('https://cdn.example/v.mp4', out, { timeoutMs: 80, fetchImpl: async () => new Response(slowBody(['a', 'b', 'c', 'd', 'e', 'f'], 30)) });
    assert.equal(result.bytes, 6); assert.equal(await readFile(out, 'utf8'), 'abcdef');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('长时间没有数据会重试，最后给出中文原因且不留半截文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jingxu-dl-'));
  try {
    let calls = 0;
    const fetchImpl = async (url, { signal }) => { calls++; return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('x')); signal.addEventListener('abort', () => c.error(signal.reason)); } })); };
    await assert.rejects(downloadResult('https://cdn.example/v.mp4', join(dir, 'v.mp4'), { timeoutMs: 40, fetchImpl }), /成品下载太慢或中断/);
    assert.equal(calls, 3);
    assert.deepEqual(await readdir(dir), []);
    let notFound = 0;
    await assert.rejects(downloadResult('https://cdn.example/v.mp4', join(dir, 'v.mp4'), { fetchImpl: async () => { notFound++; return new Response('', { status: 404 }); } }), /HTTP 404/);
    assert.equal(notFound, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
