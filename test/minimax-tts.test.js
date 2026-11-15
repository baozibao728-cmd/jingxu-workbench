import test from 'node:test';
import assert from 'node:assert/strict';
import { MiniMaxTTSProvider } from '../src/minimax-tts.js';
import { VoiceStore } from '../src/voice-store.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('MiniMax TTS 使用官方 v1/t2a_v2 请求并解析 hex 音频', async () => {
  let request;
  const provider = new MiniMaxTTSProvider({ baseUrl: 'https://api.minimax.cn', apiKey: 'fixture', fetchImpl: async (url, options) => {
    request = { url: String(url), options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ data: { audio: '000102ff', status: 2 }, extra_info: { audio_length: 120 }, base_resp: { status_code: 0, status_msg: 'success' } }));
  }});
  const result = await provider.synthesize({ text: '你好', voiceId: 'female-shaonv', speed: 1.2, vol: 0.8, pitch: 2, emotion: 'happy' });
  assert.equal(request.url, 'https://api.minimax.cn/v1/t2a_v2');
  assert.equal(request.options.headers.Authorization, 'Bearer fixture');
  assert.equal(request.body.voice_setting.voice_id, 'female-shaonv');
  assert.equal(request.body.voice_setting.speed, 1.2);
  assert.equal(request.body.output_format, 'hex');
  assert.deepEqual([...result.bytes], [0, 1, 2, 255]);
});

test('MiniMax 余额不足时给出可操作的中文提示', async () => {
  const provider = new MiniMaxTTSProvider({ baseUrl: 'https://api.minimax.cn', apiKey: 'test', fetchImpl: async () => Response.json({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }) });
  await assert.rejects(provider.synthesize({ text: '测试' }), error => error.code === 'MINIMAX_INSUFFICIENT_BALANCE' && /余额不足/.test(error.message));
});

test('语音存储保存自定义音色和历史音频，不回传 Key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jingxu-voice-'));
  try {
    const store = new VoiceStore(root); await store.init();
    await store.saveVoice({ id: 'my-voice', name: '我的音色', language: '中文' });
    const file = await store.saveAudio(Buffer.from('audio'));
    await store.addHistory({ id: 'h1', file, url: `/voice-media/${file}`, text: '测试', voiceId: 'my-voice', model: 'speech-2.8-hd', createdAt: new Date().toISOString() });
    const view = store.view(true);
    assert.equal(view.configured, true);
    assert.ok(view.voices.some(item => item.id === 'my-voice'));
    assert.equal(view.history[0].file, file);
    assert.ok(!JSON.stringify(view).includes('apiKey'));
    const persisted = JSON.parse(await readFile(join(root, 'voice-settings.json'), 'utf8'));
    assert.equal(persisted.history.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('语音历史支持删除并清理本地音频文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drama-voice-delete-'));
  try {
    const store = new VoiceStore(root); await store.init();
    const file = await store.saveAudio(Buffer.from('delete-me'));
    await store.addHistory({ id: 'voice-delete', file, text: '待删除', voiceId: 'male-qn-qingse', model: 'speech-2.8-hd' });
    await store.deleteHistory('voice-delete');
    assert.equal(store.data.history.length, 0);
    await assert.rejects(readFile(store.file(file)));
  } finally { await rm(root, { recursive: true, force: true }); }
});
