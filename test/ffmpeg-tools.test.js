import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFfmpegTools, FFMPEG_BUILDS } from '../src/ffmpeg-tools.js';

const run = promisify(execFile);
const fake = name => gzipSync(Buffer.from(`#!/bin/sh\necho "${name} version fake"\n`));
const entry = bytes => [bytes.length, createHash('sha256').update(bytes).digest('hex')];
// 系统里“没有” ffmpeg；装到本地的文件真的去运行一次。
const check = async command => { if (!command.includes('/')) return false; try { await run(command, ['-version']); return true; } catch { return false; } };

test('每个支持的平台都写了 ffmpeg 和 ffprobe 的大小与摘要', () => {
  for (const build of Object.values(FFMPEG_BUILDS)) for (const name of ['ffmpeg', 'ffprobe']) {
    assert.ok(build[name][0] > 1e6); assert.match(build[name][1], /^[0-9a-f]{64}$/);
  }
});

test('没有 FFmpeg 时自动下载、校验并装到本地，只装一次', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jingxu-ffmpeg-'));
  try {
    const files = { ffmpeg: fake('ffmpeg'), ffprobe: fake('ffprobe') };
    const asked = [];
    const tools = createFfmpegTools({ dir, platform: 'linux', arch: 'x64', base: 'https://example.test/', check,
      builds: { 'linux-x64': { ffmpeg: entry(files.ffmpeg), ffprobe: entry(files.ffprobe) } },
      fetchImpl: async url => { asked.push(url); return new Response(files[url.match(/(ffmpeg|ffprobe)-/)[1]]); } });
    const [a, b] = await Promise.all([tools.ensure(), tools.ensure()]);
    assert.equal(a, b);
    assert.deepEqual(asked, ['https://example.test/ffmpeg-linux-x64.gz', 'https://example.test/ffprobe-linux-x64.gz']);
    assert.equal(tools.status.state, 'ready'); assert.equal(tools.status.progress, 1);
    assert.match((await tools.run('ffprobe', ['-version'])).stdout, /ffprobe version fake/);
    await tools.ensure(); assert.equal(asked.length, 2);
    // 换一个实例（相当于重启工作台）：已经装好的直接用，不再下载。
    const again = createFfmpegTools({ dir, platform: 'linux', arch: 'x64', check, builds: {}, fetchImpl: async () => { throw new Error('不应该再下载'); } });
    assert.equal((await again.ensure()).ffmpeg, join(dir, 'ffmpeg'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('下载的文件被改过就丢弃，不留下半截文件，之后还能重试', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jingxu-ffmpeg-'));
  try {
    const good = { ffmpeg: fake('ffmpeg'), ffprobe: fake('ffprobe') };
    let tampered = true;
    const tools = createFfmpegTools({ dir, platform: 'linux', arch: 'x64', base: 'https://example.test/', check,
      builds: { 'linux-x64': { ffmpeg: entry(good.ffmpeg), ffprobe: entry(good.ffprobe) } },
      fetchImpl: async url => { const name = url.match(/(ffmpeg|ffprobe)-/)[1]; const bytes = Buffer.from(good[name]); if (tampered) bytes[bytes.length - 1] ^= 1; return new Response(bytes); } });
    const error = await tools.ensure().catch(error => error);
    assert.equal(error.install, true); assert.match(error.message, /FFmpeg 自动安装失败/);
    assert.equal(tools.status.state, 'failed');
    assert.deepEqual(await readdir(dir), []);
    tampered = false;
    await tools.ensure(); assert.equal(tools.status.state, 'ready');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('电脑上已经有 FFmpeg 就直接用，不下载', async () => {
  const tools = createFfmpegTools({ dir: join(tmpdir(), 'jingxu-never'), check: async () => true, fetchImpl: async () => { throw new Error('不应该下载'); } });
  assert.deepEqual(await tools.ensure(), { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
  assert.equal(tools.status.source, 'system');
});

test('没有对应版本的平台给出明确提示', async () => {
  const tools = createFfmpegTools({ dir: join(tmpdir(), 'jingxu-never'), platform: 'freebsd', arch: 'x64', check: async () => false });
  await assert.rejects(tools.ensure(), /freebsd-x64.*手动安装/);
});
