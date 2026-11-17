import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HuimiaoVideoProvider, huimiaoCapabilities } from '../src/huimiao.js';
import { createProvider, referenceTag } from '../src/custom-providers.js';
import { validateProvider, providerCatalog } from '../src/provider-settings.js';
import { testProvider } from '../src/provider-test.js';

const KEY = 'hm_live_test_never_real_0123456789';
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const base = { protocol: 'huimiao', baseUrl: 'https://huimiaovip.com', apiKey: KEY, model: 'sd-2.0-pro-face', capabilities: { resolutions: ['720p'], defaultResolution: '720p' } };

test('惠喵和悟空预设、协议和引用写法', () => {
  const huimiao = providerCatalog.fydmai.find(item => item.id === 'huimiao');
  assert.equal(huimiao.protocol, 'huimiao'); assert.equal(huimiao.baseUrl, 'https://huimiaovip.com');
  assert.ok(huimiao.models.some(item => item.id === 'sd-2.0-pro-face'));
  assert.equal(validateProvider('fydmai', { ...huimiao, timeoutMs: 120000 }).protocol, 'huimiao');
  const wk = providerCatalog.deepseek.find(item => item.id === 'wkapi');
  assert.deepEqual([wk.protocol, wk.baseUrl, wk.submitPath, wk.model], ['openai-chat', 'https://wkapi.work', '/v1/chat/completions', 'gemini-3.8-flash']);
  assert.equal(validateProvider('deepseek', { ...wk, timeoutMs: 120000 }).protocol, 'openai-chat');
  assert.equal(referenceTag(base, { index: 2 }), '参考图2 ');
  assert.ok(createProvider('fydmai', base) instanceof HuimiaoVideoProvider);
  assert.deepEqual(huimiaoCapabilities(base), { minDuration: 4, maxDuration: 15, defaultDuration: 10, resolutions: ['720p'], defaultResolution: '720p', maxReference: 9, maxAudio: 3 });
  assert.equal(huimiaoCapabilities({ model: 'custom-x', capabilities: { maxReference: 4 } }).maxReference, 4);
});

test('参考图走惠喵直传：申请地址、PUT 不带 Key、确认；提交带幂等键；查询和下载', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jingxu-huimiao-'));
  try {
    const image = join(dir, 'a.png'); await writeFile(image, Buffer.from('png-bytes'));
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      const target = new URL(url), headers = options.headers || {};
      calls.push({ method: options.method || 'GET', url: target.href, auth: headers.Authorization, idem: headers['Idempotency-Key'], body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body });
      if (target.pathname === '/v1/uploads/presign') return json(200, { object: 'upload', object_key: 'users/1/a.png', put_url: 'https://storage.example/put?sig=1', headers: { 'Content-Type': 'image/png', 'If-None-Match': '*' } });
      if (target.host === 'storage.example') return new Response(null, { status: 200 });
      if (target.pathname === '/v1/uploads/complete') return json(200, { object: 'upload', object_key: 'users/1/a.png', verified: true });
      if (target.pathname === '/v1/videos/generations' && options.method === 'POST') return json(202, { id: 'task_7', status: 'queued', progress: 0 });
      if (target.pathname === '/v1/videos/generations/task_7') return json(200, { id: 'task_7', status: 'completed', progress: 100, download_url: 'https://huimiaovip.com/v1/videos/task_7/content' });
      if (target.pathname === '/v1/videos/task_7/content') return new Response(null, { status: 302, headers: { location: 'https://cdn.example/v.mp4' } });
      if (target.href === 'https://cdn.example/v.mp4') return calls.filter(call => call.url === target.href).length === 1 ? json(409, { error: { code: 'video_preparing' } }, { 'retry-after': '1' }) : new Response('MP4DATA');
      return json(404, {});
    };
    const provider = new HuimiaoVideoProvider({ ...base, fetchImpl, pauseImpl: async () => {} });
    const uploaded = await provider.uploadImage(image);
    assert.equal(uploaded.assetId, 'users/1/a.png'); assert.ok(Date.parse(uploaded.expiresAt) > Date.now());
    assert.deepEqual(calls[0].body, { filename: 'reference.png', content_type: 'image/png', size: 9, duration_ms: 0 });
    assert.equal(calls[1].method, 'PUT'); assert.equal(calls[1].auth, undefined);
    const task = await provider.submit({ prompt: '参考图1 转身', duration: 8, resolution: '720p', aspectRatio: '9:16', referenceImages: [uploaded] });
    assert.deepEqual(task, { id: 'task_7', status: 'queued', progress: 0, urls: [], error: null });
    const submit = calls.find(call => call.method === 'POST' && call.url.endsWith('/v1/videos/generations'));
    assert.deepEqual(submit.body, { model: 'sd-2.0-pro-face', prompt: '参考图1 转身', duration: 8, resolution: '720p', ratio: '9:16', asset_keys: ['users/1/a.png'] });
    assert.match(submit.idem, /^jingxu_[0-9a-f]{32}$/);
    assert.equal((await provider.getTask('task_7')).status, 'completed');
    const out = join(dir, 'out.mp4');
    await provider.downloadTask('task_7', out);
    assert.equal(await readFile(out, 'utf8'), 'MP4DATA');
    assert.ok(calls.filter(call => call.url === 'https://cdn.example/v.mp4').every(call => call.auth === undefined), '跳转到别的域名时不能带 Key');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('惠喵的限制和报错', async () => {
  const provider = new HuimiaoVideoProvider({ ...base, model: 'seedance2.0', fetchImpl: async () => json(400, { error: { message: `时长不在模型范围内 ${KEY}`, code: 'invalid_duration' } }) });
  assert.throws(() => provider.body({ prompt: 'x', duration: 5, referenceAudios: [{ assetId: 'k' }] }), /不支持参考音频/);
  assert.throws(() => provider.body({ prompt: 'x', duration: 5, referenceImages: Array.from({ length: 10 }, (_, i) => ({ assetId: `k${i}` })) }), /最多带 9 张/);
  const error = await provider.submit({ prompt: 'x', duration: 99 }).catch(error => error);
  assert.match(error.message, /时长不在模型范围内/); assert.doesNotMatch(error.message, /hm_live_test/);
  const failed = new HuimiaoVideoProvider({ ...base, fetchImpl: async () => json(200, { id: 'task_9', status: 'failed', error: { code: 'generation_failed', message: '视频生成失败，积分已退回。' } }) });
  assert.deepEqual(await failed.getTask('task_9'), { id: 'task_9', status: 'failed', progress: 0, urls: [], error: '视频生成失败，积分已退回。' });
});

test('惠喵连接测试只读模型列表和余额', async () => {
  const paths = [];
  const fetchImpl = async url => {
    const target = new URL(url); paths.push(target.pathname);
    if (target.pathname === '/v1/models') return json(200, { object: 'list', data: [{ id: 'sd-2.0-pro-face', name: 'SD Pro', min_duration: 4, max_duration: 15, supported_resolutions: ['720p', '1080p'], max_images: 9, max_audios: 3 }] });
    if (target.pathname === '/v1/balance') return json(200, { available: 960.5 });
    return json(404, {});
  };
  const result = await testProvider({ ...base, service: 'fydmai', timeoutMs: 120000 }, { fetchImpl });
  assert.equal(result.level, 'ok'); assert.match(result.message, /720p\/1080p.*9 张.*可用积分 960.5/);
  assert.deepEqual(paths, ['/v1/models', '/v1/balance']);
  const missing = await testProvider({ ...base, model: 'nope', service: 'fydmai', timeoutMs: 120000 }, { fetchImpl });
  assert.equal(missing.level, 'reachable'); assert.match(missing.message, /没有开放 nope.*sd-2.0-pro-face/);
});
