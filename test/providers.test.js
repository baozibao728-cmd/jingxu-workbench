import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DeepSeekProvider, GrsaiImageProvider, FydmaiVideoProvider, normalizeGrsaiTask, normalizeFydmaiTask } from '../src/providers.js';
import { ApiClient, downloadResult } from '../src/http.js';
import { compileReferences, fydmaiFilenameTag } from '../src/references.js';
import { readConfig } from '../src/config.js';

function mockApi(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), ...options });
      assert.ok(responses.length, '发生了未预期的额外请求');
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return Response.json(next);
    },
  };
}

test('生图使用 Grsai 原生异步接口、camelCase 参数和 Grsai Key', async () => {
  const mock = mockApi([{ id: 'image-1', status: 'running' }]);
  const image = new GrsaiImageProvider({ baseUrl: 'https://grsaiapi.com', apiKey: 'grsai-test', model: 'gpt-image-2', ...mock });
  const result = await image.submit({ prompt: '保持人物外貌，生成侧面全身图', images: ['data:image/png;base64,AA=='], aspectRatio: '9:16' });
  assert.equal(result.status, 'running');
  assert.equal(mock.calls[0].url, 'https://grsaiapi.com/v1/api/generate');
  assert.equal(mock.calls[0].headers.Authorization, 'Bearer grsai-test');
  assert.deepEqual(JSON.parse(mock.calls[0].body), {
    model: 'gpt-image-2', prompt: '保持人物外貌，生成侧面全身图', images: ['data:image/png;base64,AA=='],
    aspectRatio: '9:16', quality: 'auto', replyType: 'async', outputFormat: 'png',
  });
});

test('Grsai 国内节点查询 id，flare 比例转换为文档支持的像素值', async () => {
  const mock = mockApi([{ id: 'image-2', status: 'running' }, { id: 'image-2', status: 'succeeded', results: [{ url: 'https://cdn.example/image.png' }] }]);
  const image = new GrsaiImageProvider({ baseUrl: 'https://grsai.dakka.com.cn', apiKey: 'test', model: 'gpt-image-2.6-flare', ...mock });
  await image.submit({ prompt: '客厅空景', aspectRatio: '16:9' });
  assert.equal(JSON.parse(mock.calls[0].body).aspectRatio, '1280x720');
  const result = await image.getTask('image-2');
  assert.equal(mock.calls[1].url, 'https://grsai.dakka.com.cn/v1/api/result?id=image-2');
  assert.deepEqual(result.urls, ['https://cdn.example/image.png']);
});

test('超时不自动再次提交计费生成，并标记远端可能已经接单', async () => {
  const mock = mockApi([new Error('timeout; secret-request-content')]);
  const image = new GrsaiImageProvider({ baseUrl: 'https://grsaiapi.com', apiKey: 'secret-key', model: 'gpt-image-2', ...mock });
  await assert.rejects(image.submit({ prompt: '人物图' }), error => {
    assert.equal(error.submissionUnknown, true);
    assert.ok(!error.message.includes('secret'));
    return true;
  });
  assert.equal(mock.calls.length, 1);
});

test('菲阳参考图先查内容哈希，上传时文件字段固定为 file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drama-upload-'));
  try {
    const path = join(dir, 'character.png');
    const bytes = Buffer.from('test-image-bytes');
    await writeFile(path, bytes);
    const mock = mockApi([{ exists: false }, { assetId: 'asset-character' }]);
    const video = new FydmaiVideoProvider({ baseUrl: 'https://fydmai.com', apiKey: 'video-test', ...mock });
    const result = await video.uploadImage(path);
    assert.equal(result.assetId, 'asset-character');
    assert.equal(mock.calls[0].url, 'https://fydmai.com/up/check');
    assert.deepEqual(JSON.parse(mock.calls[0].body), { sha256: createHash('sha256').update(bytes).digest('hex') });
    assert.equal(mock.calls[1].url, 'https://fydmai.com/up/');
    assert.ok(mock.calls[1].body instanceof FormData);
    assert.equal(mock.calls[1].body.get('file').name, 'character.png');
    assert.equal(mock.calls[1].headers['Content-Type'], undefined, 'multipart boundary 由 fetch 生成');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('菲阳已存在素材直接复用，不重复上传', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drama-reuse-'));
  try {
    const path = join(dir, 'scene.png');
    await writeFile(path, 'test-scene');
    const mock = mockApi([{ exists: true, assetId: 'scene-existing' }]);
    const video = new FydmaiVideoProvider({ baseUrl: 'https://fydmai.com', apiKey: 'test', ...mock });
    assert.equal((await video.uploadImage(path)).reused, true);
    assert.equal(mock.calls.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('视频提交 referenceImages 为 assetId 对象，查询复用同一任务 ID', async () => {
  const mock = mockApi([
    { id: 'video-1', status: 'queued', progress: 0 },
    { id: 'video-1', status: 'completed', progress: 100, url: 'https://dl.example/video.mp4' },
  ]);
  const video = new FydmaiVideoProvider({ baseUrl: 'https://fydmai.com', apiKey: 'video-test', model: 'account-selected-model', ...mock });
  await video.submit({ prompt: '角色拿起信封', duration: 5, aspectRatio: '16:9', referenceImages: [{ assetId: 'asset-character' }, { assetId: 'asset-envelope' }] });
  assert.deepEqual(JSON.parse(mock.calls[0].body).referenceImages, [{ assetId: 'asset-character' }, { assetId: 'asset-envelope' }]);
  assert.equal(mock.calls[0].url, 'https://fydmai.com/v1/videos');
  assert.equal((await video.getTask('video-1')).status, 'completed');
  assert.equal(mock.calls[1].url, 'https://fydmai.com/v1/videos/video-1');
  await assert.rejects(video.submit({ prompt: '{{ref:character-1}}', duration: 5 }), /未编译/);
  assert.equal(mock.calls.length, 2);
});

test('缺少视频模型时不自行选择截图上的型号或发出生成请求', async () => {
  const mock = mockApi([]);
  const video = new FydmaiVideoProvider({ baseUrl: 'https://fydmai.com', apiKey: 'test', ...mock });
  await assert.rejects(video.submit({ prompt: '测试', duration: 5 }), /菲阳视频模型/);
  assert.equal(mock.calls.length, 0);
});

test('参考图排序与提示词由同一份绑定生成，同一资产多次出现不占多个位置', () => {
  const assets = [
    { id: 'scene-1', version: 'hash-scene', assetId: 'remote-scene' },
    { id: 'character-1', version: 'hash-character', assetId: 'remote-character' },
  ];
  const template = '{{ref:character-1}} 走进 {{ref:scene-1}}，{{ref:character-1}} 回头。';
  // 这里只使用测试语法；正式语法必须按实际视频模型联调确认。
  const compiled = compileReferences(template, assets, slot => `[reference-${slot.index}]`);
  assert.equal(compiled.prompt, '[reference-1] 走进 [reference-2]，[reference-1] 回头。');
  assert.deepEqual(compiled.referenceImages, [{ assetId: 'remote-character' }, { assetId: 'remote-scene' }]);
  assert.throws(() => compileReferences(template, assets), /先确认/);
  assert.throws(() => compileReferences('{{ref:missing}}', assets, slot => String(slot.index)), /找不到/);
  assert.throws(() => compileReferences(template, [...assets, assets[0]], slot => String(slot.index)), /重复/);
});

test('上游标记成功但缺少成品，不能视为生成完成', () => {
  assert.throws(() => normalizeGrsaiTask({ id: 'x', status: 'succeeded' }), /未返回图片/);
  assert.throws(() => normalizeFydmaiTask({ id: 'x', status: 'completed' }), /未返回视频/);
  assert.throws(() => normalizeGrsaiTask({ id: 'x', status: 'unexpected' }), /未知/);
});

test('菲阳引用使用真实上传文件名，缺少文件名不能假定为图片序号', () => {
  const assets = [{ id: 'woman', version: 'hash-1', assetId: 'a_woman', filename: 'character-01.png' }];
  assert.equal(compileReferences('{{ref:woman}} 拿起信封', assets, fydmaiFilenameTag).prompt, '@character-01.png  拿起信封');
  assert.throws(() => fydmaiFilenameTag({ index: 1 }), /文件名/);
  assert.throws(() => fydmaiFilenameTag({ filename: '../character.png' }), /文件名/);
});

test('DeepSeek 用 JSON 输出模式，拒绝截断结果', async () => {
  const mock = mockApi([
    { choices: [{ finish_reason: 'stop', message: { content: '{"characters":[]}' } }] },
    { choices: [{ finish_reason: 'length', message: { content: '{"partial":true}' } }] },
  ]);
  const text = new DeepSeekProvider({ baseUrl: 'https://api.deepseek.com', apiKey: 'text-test', model: 'selected-deepseek-model', ...mock });
  assert.deepEqual(await text.generateJson({ instructions: '提取人物。示例 JSON: {"characters":[]}', input: '剧本内容' }), { characters: [] });
  assert.equal(mock.calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.deepEqual(JSON.parse(mock.calls[0].body).response_format, { type: 'json_object' });
  await assert.rejects(text.generateJson({ instructions: '提取人物', input: '剧本' }), /未正常完成/);
});

test('成品 CDN 下载不携带服务 Key，下载完才写入最终文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drama-download-'));
  try {
    const destination = join(dir, 'video.mp4');
    await downloadResult('https://cdn.example/video.mp4', destination, {
      fetchImpl: async (_url, options) => {
        assert.equal(options.headers, undefined);
        return new Response('video-bytes');
      },
    });
    assert.equal(await readFile(destination, 'utf8'), 'video-bytes');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('生图配置独立于官方 OpenAI Key；拒绝非 HTTPS 和含凭据的 API 地址', () => {
  const config = readConfig({ OPENAI_API_KEY: 'must-not-be-used' });
  assert.equal(config.grsai.apiKey, '');
  assert.equal(config.grsai.baseUrl, 'https://grsaiapi.com');
  assert.throws(() => new ApiClient({ baseUrl: 'http://example.com' }), /HTTPS/);
  assert.throws(() => new ApiClient({ baseUrl: 'https://user:pass@example.com' }), /凭据/);
});
