import { mkdir, readFile, writeFile, rename, appendFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const builtinVoices = [
  { id: 'male-qn-qingse', name: '青涩男声', language: '中文普通话' },
  { id: 'male-qn-badao', name: '霸道男声', language: '中文普通话' },
  { id: 'male-qn-daxuesheng', name: '青年大学生', language: '中文普通话' },
  { id: 'female-shaonv', name: '少女', language: '中文普通话' },
  { id: 'male-qn-jingying', name: '精英男声', language: '中文普通话' },
  { id: 'female-yujie', name: '御姐', language: '中文普通话' },
  { id: 'female-chengshu', name: '成熟女性', language: '中文普通话' },
  { id: 'female-tianmei', name: '甜美女性', language: '中文普通话' },
  { id: 'presenter_male', name: '男主持', language: '中文普通话' },
  { id: 'presenter_female', name: '女主持', language: '中文普通话' },
  { id: 'audiobook_male_1', name: '男性有声书1', language: '中文普通话' },
  { id: 'audiobook_male_2', name: '男性有声书2', language: '中文普通话' },
  { id: 'audiobook_female_1', name: '女性有声书1', language: '中文普通话' },
  { id: 'audiobook_female_2', name: '女性有声书2', language: '中文普通话' },
  { id: 'clever_boy', name: '聪明男童', language: '中文普通话' },
  { id: 'cute_boy', name: '可爱男童', language: '中文普通话' },
  { id: 'lovely_girl', name: '萌萌女童', language: '中文普通话' },
  { id: 'cartoon_pig', name: '卡通猪小琪', language: '中文普通话' },
  { id: 'bingjiao_didi', name: '病娇弟弟', language: '中文普通话' },
  { id: 'junlang_nanyou', name: '俊朗男友', language: '中文普通话' },
  { id: 'chunzhen_xuedi', name: '纯真学弟', language: '中文普通话' },
  { id: 'lengdan_xiongzhang', name: '冷淡学长', language: '中文普通话' },
  { id: 'badao_shaoye', name: '霸道少爷', language: '中文普通话' },
  { id: 'tianxin_xiaoling', name: '甜心小玲', language: '中文普通话' },
  { id: 'qiaopi_mengmei', name: '俏皮萌妹', language: '中文普通话' },
  { id: 'wumei_yujie', name: '妩媚御姐', language: '中文普通话' },
  { id: 'diadia_xuemei', name: '嗲嗲学妹', language: '中文普通话' },
  { id: 'danya_xuejie', name: '淡雅学姐', language: '中文普通话' },
];

export class VoiceStore {
  constructor(root) { this.root = root; this.path = join(root, 'voice-settings.json'); this.mediaRoot = join(root, 'audio'); this.data = { model: 'speech-2.8-hd', voiceId: builtinVoices[0].id, speed: 1, vol: 1, pitch: 0, emotion: '', languageBoost: 'auto', pronunciation: '', customVoices: [], history: [] }; }
  async init() { await mkdir(this.mediaRoot, { recursive: true }); try { this.data = { ...this.data, ...JSON.parse(await readFile(this.path, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  async persist() { await mkdir(this.root, { recursive: true }); const tmp = `${this.path}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 }); await rename(tmp, this.path); }
  voices() { const map = new Map(); for (const voice of [...builtinVoices, ...(this.data.customVoices || [])]) map.set(voice.id, voice); return [...map.values()]; }
  view(configured = false) { return { configured, model: this.data.model, voiceId: this.data.voiceId, speed: this.data.speed, vol: this.data.vol, pitch: this.data.pitch, emotion: this.data.emotion, languageBoost: this.data.languageBoost, pronunciation: this.data.pronunciation, voices: this.voices(), history: this.data.history.slice(0, 30) }; }
  async saveSettings(input = {}) { for (const key of ['model','voiceId','emotion','languageBoost','pronunciation']) if (input[key] !== undefined) this.data[key] = String(input[key]).slice(0, 2000); for (const key of ['speed','vol','pitch']) if (input[key] !== undefined) this.data[key] = Number(input[key]); await this.persist(); return this.view(); }
  async saveVoice(input = {}) { const id = String(input.id || '').trim(); const name = String(input.name || '').trim(); if (!id || !name) throw new Error('音色 ID 和名称不能为空'); if (!/^[\w.-]{1,100}$/.test(id)) throw new Error('音色 ID 格式无效'); this.data.customVoices = [...(this.data.customVoices || []).filter(v => v.id !== id), { id, name: name.slice(0, 80), language: String(input.language || '自定义') }]; await this.persist(); return this.view(); }
  async addHistory(item) { this.data.history.unshift(item); this.data.history = this.data.history.slice(0, 30); await this.persist(); }
  async deleteHistory(id) {
    const item = this.data.history.find(entry => entry.id === id);
    if (!item) throw Object.assign(new Error('音频不存在'), { status: 404 });
    this.data.history = this.data.history.filter(entry => entry.id !== id);
    try { await rm(this.file(item.file), { force: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.persist();
    return this.view();
  }
  file(name) { if (!/^[\w.-]+$/.test(name)) throw new Error('音频文件名无效'); return join(this.mediaRoot, name); }
  async saveAudio(bytes, format = 'mp3') { const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16); const file = `${Date.now().toString(36)}_${hash}.${format}`; await writeFile(this.file(file), bytes, { mode: 0o600 }); return file; }
}
