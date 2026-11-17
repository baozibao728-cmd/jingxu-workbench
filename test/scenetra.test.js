import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScenetraVideoProvider, SCENETRA_MODELS, scenetraCapabilities, hostTemporarily, forgetHosted, TEMP_HOSTS } from '../src/scenetra.js';
import { createProvider, referenceTag } from '../src/custom-providers.js';
import { validateProvider, providerCatalog } from '../src/provider-settings.js';
import { testProvider } from '../src/provider-test.js';

const KEY = 'scnk_test_never_real_0123456789';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fakeScenetra(runs = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    calls.push({ method: options.method || 'GET', path: target.pathname + target.search, body: options.body ? JSON.parse(options.body) : null, auth: options.headers?.Authorization });
    if (target.pathname.startsWith('/api/v1/generate/')) return json(202, target.searchParams.has('dryRun') ? { status: 'PENDING', dryRun: true, estimatedCredits: 1350 } : { runId: 'run_1', status: 'PENDING', estimatedCredits: 1350 });
    if (target.pathname.startsWith('/api/v1/runs/')) return json(200, runs[target.pathname.split('/').pop()] || { runId: 'x', status: 'RUNNING' });
    if (target.pathname === '/api/v1/models') return json(200, { models: Object.values(SCENETRA_MODELS).flatMap(model => [{ id: model.t2v }, { id: model.ref }]) });
    return json(404, { error: { code: 'endpoint_not_found', message: 'nope' } });
  };
  return { calls, fetchImpl };
}

test('Scenetra 预设、协议校验和引用写法', () => {
  const preset = providerCatalog.fydmai.find(item => item.id === 'scenetra');
  assert.equal(preset.protocol, 'scenetra'); assert.equal(preset.baseUrl, 'https://app.scenetra.com');
  assert.ok(preset.models.some(item => item.id === 'seedance-2-5'));
  assert.equal(validateProvider('fydmai', { protocol: 'scenetra', baseUrl: preset.baseUrl, model: 'seedance-2-5', timeoutMs: 120000 }).protocol, 'scenetra');
  assert.throws(() => validateProvider('fydmai', { protocol: 'scenetra', baseUrl: preset.baseUrl, model: 'made-up', timeoutMs: 120000 }), /Scenetra 的模型/);
  assert.equal(referenceTag({ protocol: 'scenetra', model: 'seedance-2-5' }, { index: 2 }), '@Image2 ');
  assert.equal(referenceTag({ protocol: 'scenetra', model: 'kling-4' }, { index: 1 }), '@image_1 ');
  assert.equal(referenceTag({ protocol: 'scenetra', model: 'happy-horse-1.1' }, { index: 3 }), '[Image 3] ');
  assert.ok(createProvider('fydmai', { protocol: 'scenetra', model: 'seedance-2-5', baseUrl: 'https://app.scenetra.com', apiKey: KEY }) instanceof ScenetraVideoProvider);
  assert.deepEqual(scenetraCapabilities('seedance-2-5'), { minDuration: 4, maxDuration: 30, defaultDuration: 10, resolutions: ['480p', '720p'], defaultResolution: '720p', maxReference: 30, maxAudio: 10 });
});

test('有参考图走参考生视频，先免费校验再提交，查询结果能拿到成片地址', async () => {
  const done = { runId: 'run_1', status: 'COMPLETED', progress: { completed: 1, total: 1 }, outputs: [{ type: 'video', url: 'https://cdn.example/out.mp4' }] };
  const { calls, fetchImpl } = fakeScenetra({ run_1: done });
  const provider = new ScenetraVideoProvider({ protocol: 'scenetra', model: 'seedance-2-5', baseUrl: 'https://app.scenetra.com', apiKey: KEY, fetchImpl });
  const task = await provider.submit({ prompt: '@Image1 走进 @Image2，@Audio1 说话', duration: 12, resolution: '720p', aspectRatio: '9:16',
    referenceImages: [{ assetId: 'https://n.uguu.se/a.png' }, { assetId: 'https://n.uguu.se/b.png' }], referenceAudios: [{ assetId: 'https://n.uguu.se/c.mp3' }] });
  assert.equal(task.id, 'run_1'); assert.equal(task.status, 'queued'); assert.equal(task.estimatedCredits, 1350);
  assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), ['POST /api/v1/generate/seedance-2-5-ref2v?dryRun=1', 'POST /api/v1/generate/seedance-2-5-ref2v']);
  assert.deepEqual(calls[1].body, { prompt: '@Image1 走进 @Image2，@Audio1 说话', duration: '12', resolution: '720p', aspect_ratio: '9:16',
    reference_images: ['https://n.uguu.se/a.png', 'https://n.uguu.se/b.png'], reference_audios: ['https://n.uguu.se/c.mp3'], generate_audio: 'true' });
  assert.equal(calls[1].auth, `Bearer ${KEY}`);
  assert.deepEqual(await provider.getTask('run_1'), { id: 'run_1', status: 'completed', urls: ['https://cdn.example/out.mp4'], progress: 100, error: null });
});

test('没有参考图走文生视频；各模型的字段名和限制', async () => {
  const { calls, fetchImpl } = fakeScenetra();
  const kling = new ScenetraVideoProvider({ model: 'kling-4', baseUrl: 'https://app.scenetra.com', apiKey: KEY, fetchImpl });
  await kling.submit({ prompt: '海边日落', duration: 5, resolution: '1080p', aspectRatio: '16:9' });
  assert.equal(calls.at(-1).path, '/api/v1/generate/kling-4-t2v');
  assert.deepEqual(calls.at(-1).body, { prompt: '海边日落', duration: '5', resolution: '1080p', aspect_ratio: '16:9' });
  assert.deepEqual(kling.body({ prompt: 'x', duration: 5, referenceImages: [{ assetId: 'https://a/1.png' }] }).json.reference_image_urls, ['https://a/1.png']);
  assert.throws(() => kling.body({ prompt: 'x', duration: 5, referenceImages: [{ assetId: 'https://a/1.png' }], referenceAudios: [{ assetId: 'https://a/1.mp3' }] }), /不支持参考音频/);
  assert.throws(() => kling.body({ prompt: 'x', duration: 31 }), /3～30 秒/);
  assert.throws(() => kling.body({ prompt: 'x', duration: 5, resolution: '480p' }), /不支持 480p/);
  const wan = new ScenetraVideoProvider({ model: 'wan-3.0', baseUrl: 'https://app.scenetra.com', apiKey: KEY, fetchImpl });
  const body = wan.body({ prompt: 'x', duration: 10, resolution: '720p', aspectRatio: '1:1', referenceImages: [{ assetId: 'https://a/1.png' }], referenceAudios: [{ assetId: 'https://a/1.mp3' }] });
  assert.equal(body.endpoint, 'wan-3.0-ref2v');
  assert.deepEqual(body.json, { prompt: 'x', duration: '10', resolution: '720p', aspect_ratio: '1:1', reference_image_urls: ['https://a/1.png'], reference_audio_urls: ['https://a/1.mp3'], audio: 'true' });
  const many = Array.from({ length: 31 }, (_, i) => ({ assetId: `https://a/${i}.png` }));
  assert.throws(() => new ScenetraVideoProvider({ model: 'seedance-2-5', apiKey: KEY }).body({ prompt: 'x', duration: 5, referenceImages: many }), /最多带 30 张/);
  assert.throws(() => new ScenetraVideoProvider({ model: 'minimax-h3', apiKey: KEY }).body({ prompt: 'x', duration: 6, referenceAudios: [{ assetId: 'https://a/1.mp3' }] }), /至少一张参考图/);
});

test('Scenetra 报错原样说明原因，不回显 Key；失败任务说明积分已退回', async () => {
  const provider = new ScenetraVideoProvider({ model: 'seedance-2-5', baseUrl: 'https://app.scenetra.com', apiKey: KEY,
    fetchImpl: async () => json(402, { error: { code: 'insufficient_credits', message: `need more credits for ${KEY}` } }) });
  const error = await provider.submit({ prompt: 'x', duration: 5 }).catch(error => error);
  assert.match(error.message, /积分不足/); assert.doesNotMatch(error.message, /scnk_test/);
  const failed = new ScenetraVideoProvider({ model: 'seedance-2-5', baseUrl: 'https://app.scenetra.com', apiKey: KEY,
    fetchImpl: async () => json(200, { runId: 'r', status: 'FAILED', error: 'content policy', creditsRefunded: true }) });
  const task = await failed.getTask('r');
  assert.equal(task.status, 'failed'); assert.match(task.error, /content policy.*积分已自动退回/);
});

test('临时图床：先用 uguu，连不上换 tmpfiles 并转成直链；同一张图有效期内不重复上传', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jingxu-scenetra-'));
  try {
    forgetHosted();
    const image = join(dir, 'a.png'); await writeFile(image, Buffer.from('fake png bytes'));
    const asked = [];
    const fetchImpl = async url => {
      asked.push(String(url));
      if (String(url).includes('uguu')) throw new Error('tls');
      return json(200, { status: 'success', data: { url: 'https://tmpfiles.org/abc123/a.png' } });
    };
    const first = await hostTemporarily(image, { fetchImpl });
    assert.equal(first.url, 'https://tmpfiles.org/dl/abc123/a.png'); assert.equal(first.host, 'tmpfiles.org');
    assert.deepEqual(asked, ['https://uguu.se/upload', 'https://uguu.se/upload', 'https://tmpfiles.org/api/v1/upload']);
    assert.equal((await hostTemporarily(image, { fetchImpl })).url, first.url); assert.equal(asked.length, 3);
    forgetHosted();
    const ok = await hostTemporarily(image, { fetchImpl: async () => json(200, { success: true, files: [{ url: 'https://n.uguu.se/x.png' }] }) });
    assert.equal(ok.url, 'https://n.uguu.se/x.png'); assert.ok(ok.expiresAt > Date.now() + 3600e3 && ok.expiresAt < Date.now() + 3 * 3600e3);
    forgetHosted();
    await assert.rejects(hostTemporarily(image, { fetchImpl: async () => { throw new Error('down'); } }), /临时图床失败.*不会扣 Scenetra 积分/);
    await assert.rejects(hostTemporarily(join(dir, 'a.gif'), { fetchImpl, hosts: TEMP_HOSTS }), /ENOENT|只支持/);
  } finally { forgetHosted(); await rm(dir, { recursive: true, force: true }); }
});

test('连接测试只查模型列表，不提交生成', async () => {
  const { calls, fetchImpl } = fakeScenetra();
  const result = await testProvider({ service: 'fydmai', protocol: 'scenetra', model: 'seedance-2-5', baseUrl: 'https://app.scenetra.com', apiKey: KEY, timeoutMs: 120000 }, { fetchImpl });
  assert.equal(result.level, 'ok'); assert.match(result.message, /Seedance 2.5/);
  assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), ['GET /api/v1/models']);
  const refused = await testProvider({ service: 'fydmai', protocol: 'scenetra', model: 'seedance-2-5', baseUrl: 'https://app.scenetra.com', apiKey: KEY, timeoutMs: 120000 }, { fetchImpl: async () => json(401, {}) });
  assert.equal(refused.level, 'fail');
});

test('免费校验连不上会重试一次；两次都失败就明确说没有提交', async () => {
  let attempts = 0;
  const flaky = new ScenetraVideoProvider({ model: 'seedance-2-5', baseUrl: 'https://app.scenetra.com', apiKey: KEY, fetchImpl: async url => {
    if (String(url).includes('dryRun')) { if (++attempts === 1) throw new Error('tls'); return json(202, { dryRun: true, estimatedCredits: 5 }); }
    return json(202, { runId: 'run_2', status: 'PENDING' });
  } });
  assert.equal((await flaky.submit({ prompt: 'x', duration: 5 })).id, 'run_2'); assert.equal(attempts, 2);
  const down = new ScenetraVideoProvider({ model: 'seedance-2-5', baseUrl: 'https://app.scenetra.com', apiKey: KEY, fetchImpl: async () => { throw new Error('tls'); } });
  const error = await down.submit({ prompt: 'x', duration: 5 }).catch(error => error);
  assert.equal(error.submissionUnknown, undefined); assert.match(error.message, /没有提交，也没有扣积分/);
});
