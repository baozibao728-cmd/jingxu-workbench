import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProvider, referenceTag } from '../src/custom-providers.js';

test('萤漫 OpenAI 兼容视频适配器用 multipart 传图音，完成后从 content 下载', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yingman-provider-'));
  const image = join(root, '角色.png');
  const audio = join(root, '角色.mp3');
  const out = join(root, 'result.mp4');
  await writeFile(image, 'fake-image');
  await writeFile(audio, 'fake-audio');
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/content')) return new Response(Buffer.from('fake-video'), { status: 200 });
    if (options.method === 'POST') return new Response(JSON.stringify({ id: 'video-1', status: 'queued' }), { status: 200 });
    return new Response(JSON.stringify({ id: 'video-1', status: 'completed', progress: 100 }), { status: 200 });
  };
  try {
    const config = { protocol: 'openai-video', baseUrl: 'https://yingman.example', apiKey: 'secret', model: 'seedance-2.5-cc', fetchImpl };
    const provider = createProvider('fydmai', config);
    const imageRef = await provider.uploadImage(image);
    const audioRef = await provider.uploadAudio(audio);
    const task = await provider.submit({ prompt: '@图片1 @音频1', duration: 30, resolution: '720p', referenceImages: [imageRef], referenceAudios: [audioRef] });
    assert.deepEqual(task, { id: 'video-1', status: 'queued', progress: 0, urls: [], error: null });
    const form = calls[0].options.body;
    assert.equal(form.get('model'), 'seedance-2.5-cc');
    assert.equal(form.get('seconds'), '30');
    assert.equal(form.get('size'), '1280x720');
    assert.equal(form.getAll('input_reference').length, 1);
    assert.equal(form.getAll('input_audio').length, 1);
    await provider.submit({ prompt: '竖屏480p', duration: 15, resolution: '480p', aspectRatio: '9:16' });
    assert.equal(calls[1].options.body.get('size'), '480x854');
    const caps = await provider.getCapabilities();
    assert.deepEqual(caps.models[0].resolutions, ['480p', '720p']);
    assert.equal((await provider.getTask('video-1')).status, 'completed');
    await provider.downloadTask('video-1', out);
    assert.equal(await readFile(out, 'utf8'), 'fake-video');
    assert.equal(referenceTag(config, { index: 2 }), '@图片2 ');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('萤漫成片下载跟随一次跳转，且不把 Key 带到别的域名', async () => {
  const { createProvider } = await import('../src/custom-providers.js');
  const { mkdtemp, rm, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'yingman-redirect-')); const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers || {} });
    if (String(url).endsWith('/content')) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/file.mp4?sig=1' } });
    return new Response(Buffer.from('redirected-video'), { status: 200 });
  };
  try {
    const provider = createProvider('fydmai', { protocol: 'openai-video', baseUrl: 'https://yingman.example', apiKey: 'secret-key', model: 'm', fetchImpl });
    const out = join(root, 'a.mp4'); await provider.downloadTask('video-1', out);
    assert.equal(await readFile(out, 'utf8'), 'redirected-video');
    assert.ok(calls[0].headers.Authorization.includes('secret-key')); assert.deepEqual(calls[1].headers, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});
