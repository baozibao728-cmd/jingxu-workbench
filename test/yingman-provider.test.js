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
    assert.equal((await provider.getTask('video-1')).status, 'completed');
    await provider.downloadTask('video-1', out);
    assert.equal(await readFile(out, 'utf8'), 'fake-video');
    assert.equal(referenceTag(config, { index: 2 }), '@图片2 ');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
