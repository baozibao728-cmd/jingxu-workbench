// Scenetra（app.scenetra.com）视频适配。
// 它的参考图、参考音频只收公网 https 地址、没有上传接口，所以生成前先把本机文件传到临时图床
// （uguu.se 3 小时后自动删除；连不上时用 tmpfiles.org，1 小时后删除），拿到地址再提交。
// 每个模型的参数名、引用写法、时长和清晰度都不一样，下面按 Scenetra 的 OpenAPI 文档逐个写明。
import { readFile, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { audioForUpload } from './media-clips.js';

const SEEDANCE_ASPECTS = ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const seedance = (label, t2v, ref, maxImages, maxAudios, max, resolutions, audioNeedsImage = true) => ({ label, t2v, ref, audioNeedsImage, images: 'reference_images', audios: 'reference_audios', maxImages, maxAudios,
  imageTag: '@Image{n}', audioTag: '@Audio{n}', duration: [4, max], resolutions, aspects: SEEDANCE_ASPECTS, refAspects: SEEDANCE_ASPECTS, switches: { generate_audio: 'true' } });
const WAN_ASPECTS = ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'];
const wan = (label, prefix) => ({ label, t2v: `${prefix}-t2v`, ref: `${prefix}-ref2v`, images: 'reference_image_urls', audios: 'reference_audio_urls', maxImages: 10, maxAudios: 5,
  imageTag: 'Image {n}', audioTag: 'Audio {n}', duration: [2, 30], resolutions: ['480p', '720p', '1080p'], aspects: WAN_ASPECTS, refAspects: WAN_ASPECTS, switches: { audio: 'true' } });

export const SCENETRA_MODELS = {
  'seedance-2-5': seedance('Seedance 2.5', 'seedance-2-5-t2v', 'seedance-2-5-ref2v', 30, 10, 30, ['480p', '720p'], false),
  'seedance-2-5-flash': seedance('Seedance 2.5 Flash', 'seedance-2-5-flash-t2v', 'seedance-2-5-flash-ref2v', 10, 5, 30, ['480p', '720p'], false),
  'seedance-2': seedance('Seedance 2', 'seedance-2-t2v', 'seedance-2-ref2v', 9, 3, 15, ['480p', '720p', '1080p', '4k']),
  'seedance-2-fast': seedance('Seedance 2 Fast', 'seedance-2-t2v-fast', 'seedance-2-ref2v-fast', 9, 3, 15, ['480p', '720p']),
  'seedance-2-mini': seedance('Seedance 2 Mini', 'seedance-2-mini-t2v', 'seedance-2-mini-ref2v', 9, 3, 15, ['480p', '720p', '1080p', '4k']),
  'kling-4': { label: 'Kling 4.0', t2v: 'kling-4-t2v', ref: 'kling-4-ref2v', images: 'reference_image_urls', maxImages: 10, maxAudios: 0, imageTag: '@image_{n}',
    duration: [3, 30], resolutions: ['720p', '1080p'], aspects: ['16:9', '9:16', '1:1', '21:9'], refAspects: ['auto', '16:9', '9:16', '1:1', '21:9'] },
  'wan-3.0': wan('Wan 3.0', 'wan-3.0'),
  'wan-3.0-prime': wan('Wan 3.0 Prime', 'wan-3.0-prime'),
  'minimax-h3': { label: 'MiniMax H3', audioNeedsImage: true, t2v: 'minimax-h3-t2v', ref: 'minimax-h3-ref2v', images: 'reference_image_urls', audios: 'reference_audio_urls', maxImages: 9, maxAudios: 3,
    imageTag: 'Image {n}', audioTag: 'Audio {n}', duration: [5, 15], resolutions: ['768P', '2K', '4K'], aspects: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], refAspects: SEEDANCE_ASPECTS },
  'happy-horse-1.1': { label: 'Happy Horse 1.1', t2v: 'happy-horse-1.1-t2v', ref: 'happy-horse-1.1-ref2v', images: 'images', maxImages: 9, maxAudios: 0, imageTag: '[Image {n}]',
    duration: [3, 15], resolutions: ['480p', '720p', '1080p'], aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4', '9:21', '21:9'], refAspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4', '9:21', '21:9'] },
  'grok-imagine-video-1.5': { label: 'Grok Imagine Video 1.5', t2v: 'grok-imagine-video-1.5-t2v', ref: 'grok-imagine-video-1.5-ref2v', images: 'reference_image_urls', maxImages: 7, maxAudios: 0, imageTag: '@Image{n}',
    duration: [1, 15], resolutions: ['480p', '720p'], aspects: ['auto', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'], refAspects: ['auto', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'] },
  'pixverse-v6': { label: 'PixVerse v6', t2v: 'pixverse-v6-t2v', ref: 'pixverse-v6-ref2v', images: 'images', maxImages: 7, maxAudios: 0, imageTag: '@image{n}',
    duration: [1, 15], resolutions: ['360p', '540p', '720p', '1080p'], aspects: ['16:9', '4:3', '1:1', '3:4', '9:16', '2:3', '3:2', '21:9'], refAspects: ['16:9', '4:3', '1:1', '3:4', '9:16', '2:3', '3:2', '21:9'], switches: { generate_audio_switch: 'true' } },
  'gemini-omni-1.2-flash': { label: 'Gemini Omni 1.2 Flash', t2v: 'gemini-omni-1.2-flash-t2v', ref: 'gemini-omni-1.2-flash-ref2v', images: 'reference_images', maxImages: 6, maxAudios: 0, imageTag: 'Image {n}',
    duration: [3, 15], resolutions: ['360p', '720p', '1080p', '4k'], aspects: ['16:9', '9:16'], refAspects: ['16:9', '9:16'] }
};
export const SCENETRA_DEFAULT = 'seedance-2-5';

export function scenetraModel(id) {
  const model = SCENETRA_MODELS[id];
  if (!model) throw new Error(`Scenetra 没有 ${id} 这个模型，请在接口设置里重新选择`);
  return model;
}
// 给工作流用的视频参数：时长范围、清晰度、最多几张参考图。默认 720p（短剧常用），没有就取第一个。
export function scenetraCapabilities(id) {
  const model = SCENETRA_MODELS[id];
  if (!model) return null;
  const [min, max] = model.duration;
  return { minDuration: min, maxDuration: max, defaultDuration: Math.min(max, Math.max(min, 10)), resolutions: model.resolutions,
    defaultResolution: model.resolutions.includes('720p') ? '720p' : model.resolutions[0], maxReference: model.maxImages, maxAudio: model.maxAudios };
}
export const scenetraImageTag = (id, index) => scenetraModel(id).imageTag.replace('{n}', String(index));
export function scenetraAudioTag(id, index) {
  const model = scenetraModel(id);
  if (!model.audioTag) throw new Error(`${model.label} 不支持参考音频，请去掉音频或换 Seedance、Wan、MiniMax 模型`);
  return model.audioTag.replace('{n}', String(index));
}
export const scenetraPresetModels = () => Object.entries(SCENETRA_MODELS).map(([id, model]) => ({ id, label: model.label }));

// ---------- 临时图床 ----------
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const AUDIO_TYPES = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
const extension = path => (path.match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase();
export const TEMP_HOSTS = [
  { name: 'uguu.se', ttl: 3 * 3600e3, async upload(fetchImpl, blob, name) {
    const form = new FormData(); form.append('files[]', blob, name);
    const response = await fetchImpl('https://uguu.se/upload', { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    const raw = await response.json().catch(() => null);
    return response.ok && raw?.success ? raw.files?.[0]?.url : null;
  } },
  { name: 'tmpfiles.org', ttl: 3600e3, async upload(fetchImpl, blob, name) {
    const form = new FormData(); form.append('file', blob, name);
    const response = await fetchImpl('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    const raw = await response.json().catch(() => null);
    // 返回的是预览页地址，直链要在路径前加 /dl。
    const page = response.ok && raw?.status === 'success' ? raw.data?.url : null;
    return page ? page.replace(/^https?:\/\/tmpfiles\.org\//, 'https://tmpfiles.org/dl/') : null;
  } }
];
// 同一个文件在有效期内不重复上传（按内容算，重启后重新上传）。留 40% 余量，免得提交时刚好过期。
const hosted = new Map();

export async function hostTemporarily(path, { fetchImpl = fetch, hosts = TEMP_HOSTS, kind = 'image' } = {}) {
  // Scenetra 的参考音频只收 wav / mp3：画布里截出来的 m4a 先转成 mp3。
  const { file, cleanup } = kind === 'audio' ? await audioForUpload(path, tmpdir()) : { file: path, cleanup: null };
  try {
    const bytes = await readFile(file);
    const type = (kind === 'audio' ? AUDIO_TYPES : IMAGE_TYPES)[extension(file)];
    if (!type) throw new Error(kind === 'audio' ? '参考音频格式不支持' : '参考图只支持 png、jpg、webp');
    const key = createHash('sha256').update(bytes).digest('hex');
    const cached = hosted.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const name = `${key.slice(0, 12)}${extension(file)}`;
    const errors = [];
    for (const host of hosts) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const url = await host.upload(fetchImpl, new Blob([bytes], { type }), name);
          if (typeof url === 'string' && url.startsWith('https://')) {
            const record = { url, host: host.name, expiresAt: Date.now() + host.ttl * .6 };
            hosted.set(key, record); return record;
          }
          errors.push(`${host.name} 没有返回地址`); break;
        } catch { if (attempt) errors.push(`${host.name} 连不上`); }
      }
    }
    throw new Error(`参考${kind === 'audio' ? '音频' : '图'}上传到临时图床失败（${errors.join('，')}），没有提交生成，不会扣 Scenetra 积分`);
  } finally { if (cleanup) await rm(cleanup, { force: true }); }
}
export const forgetHosted = () => hosted.clear();

// ---------- 接口 ----------
const STATES = { PENDING: 'queued', RUNNING: 'running', COMPLETED: 'completed', FAILED: 'failed' };
const ERRORS = { unauthorized: 'Scenetra 拒绝了 Key：Key 填错、已删除或已失效', insufficient_credits: 'Scenetra 积分不足', rate_limited: 'Scenetra 限流了，稍后再试',
  model_not_available: '这个模型暂时不能通过 API 使用', invalid_parameter: '参数不被接受', missing_parameter: '缺少必填参数' };

export class ScenetraVideoProvider {
  constructor(config) {
    this.config = config;
    this.base = new URL(config.baseUrl || 'https://app.scenetra.com');
    if (this.base.protocol !== 'https:') throw new Error('Scenetra 地址必须为 HTTPS');
    this.fetch = config.fetchImpl || fetch;
    this.hostFetch = config.hostFetchImpl || fetch;
    this.timeoutMs = config.timeoutMs || 120000;
  }
  async call(path, { method = 'GET', json } = {}) {
    if (!this.config.apiKey) throw new Error('尚未填写 Scenetra 的 API Key');
    const headers = { Authorization: `Bearer ${this.config.apiKey}` };
    if (json) headers['Content-Type'] = 'application/json';
    let response;
    try { response = await this.fetch(new URL(`/api/v1${path}`, this.base), { method, headers, redirect: 'error', body: json ? JSON.stringify(json) : undefined, signal: AbortSignal.timeout(this.timeoutMs) }); }
    catch { throw Object.assign(new Error('连不上 Scenetra，请检查网络；如果是提交时断开，先“继续查询”，不要重复提交'), { submissionUnknown: method === 'POST' }); }
    const raw = await response.json().catch(() => null);
    if (!response.ok) {
      // 只显示 Scenetra 给的错误码和说明，不回显请求内容和 Key。
      const code = String(raw?.error?.code || ''), detail = String(raw?.error?.message || '').replace(/scnk_[A-Za-z0-9]+/g, 'scnk_***').slice(0, 300);
      throw Object.assign(new Error(`${ERRORS[code] || `Scenetra 返回 HTTP ${response.status}`}${detail ? `：${detail}` : ''}`), { status: response.status, submissionUnknown: method === 'POST' && response.status >= 500 });
    }
    return raw;
  }
  async uploadImage(path) { const record = await hostTemporarily(path, { fetchImpl: this.hostFetch }); return { assetId: record.url, filename: basename(path), expiresAt: new Date(record.expiresAt).toISOString() }; }
  async uploadAudio(path) { const record = await hostTemporarily(path, { fetchImpl: this.hostFetch, kind: 'audio' }); return { assetId: record.url, filename: basename(path), expiresAt: new Date(record.expiresAt).toISOString() }; }
  // 按有没有参考素材选文生视频或参考生视频。先用 dryRun 免费校验参数和价格，通过了再真正提交。
  body({ prompt, duration, resolution, aspectRatio, referenceImages = [], referenceAudios = [] }) {
    const model = scenetraModel(this.config.model), images = referenceImages.map(item => item.assetId), audios = referenceAudios.map(item => item.assetId);
    if (images.length > model.maxImages) throw new Error(`${model.label} 最多带 ${model.maxImages} 张参考图`);
    if (audios.length && !model.audios) throw new Error(`${model.label} 不支持参考音频，请去掉音频或换 Seedance、Wan、MiniMax 模型`);
    if (audios.length > model.maxAudios) throw new Error(`${model.label} 最多带 ${model.maxAudios} 段参考音频`);
    if (audios.length && !images.length && model.audioNeedsImage) throw new Error(`${model.label} 的参考音频要和至少一张参考图一起用`);
    const reference = images.length > 0 || audios.length > 0, [min, max] = model.duration, seconds = Math.round(Number(duration));
    if (!(seconds >= min && seconds <= max)) throw new Error(`${model.label} 的时长只能是 ${min}～${max} 秒`);
    if (resolution && !model.resolutions.includes(resolution)) throw new Error(`${model.label} 不支持 ${resolution}，可选 ${model.resolutions.join('、')}`);
    const json = { prompt: String(prompt || ''), duration: String(seconds) };
    if (resolution) json.resolution = resolution;
    const aspects = reference ? model.refAspects : model.aspects;
    if (aspects.includes(aspectRatio)) json.aspect_ratio = aspectRatio;
    if (images.length) json[model.images] = images;
    if (audios.length) json[model.audios] = audios;
    Object.assign(json, model.switches || {});
    return { endpoint: reference ? model.ref : model.t2v, json };
  }
  async submit(input) {
    const { endpoint, json } = this.body(input), path = `/generate/${endpoint}`;
    // 免费校验不会建任务：连不上就重试一次，还不行就明确说“没有提交”，不当成结果不明。
    let price;
    for (let attempt = 0; ; attempt++) {
      try { price = await this.call(`${path}?dryRun=1`, { method: 'POST', json }); break; }
      catch (error) {
        if (!error.submissionUnknown) throw error;
        if (attempt) throw new Error('提交前校验时连不上 Scenetra（网络中断），这次没有提交，也没有扣积分，可以直接重新生成');
        await new Promise(done => setTimeout(done, 1500));
      }
    }
    const run = await this.call(path, { method: 'POST', json });
    if (!run?.runId) throw new Error('Scenetra 没有返回任务号');
    return { id: String(run.runId), status: STATES[run.status] || 'queued', progress: 0, urls: [], error: null, estimatedCredits: Number(run.estimatedCredits ?? price?.estimatedCredits) || 0 };
  }
  async getTask(id) {
    const run = await this.call(`/runs/${encodeURIComponent(id)}`);
    const status = STATES[run?.status];
    if (!status) throw new Error('Scenetra 返回了未知任务状态');
    const urls = (Array.isArray(run.outputs) ? run.outputs : []).filter(item => item?.url && (!item.type || /video/i.test(item.type))).map(item => String(item.url));
    const total = Number(run.progress?.total), done = Number(run.progress?.completed);
    return { id: String(run.runId || id), status, urls, progress: total > 0 ? Math.round(done / total * 100) : 0,
      error: status === 'failed' ? `Scenetra 生成失败${run.error ? `：${String(run.error).slice(0, 300)}` : ''}${run.creditsRefunded ? '（积分已自动退回）' : ''}` : null };
  }
  async getCapabilities() { return { models: [{ kind: 'video', model: this.config.model, ...scenetraCapabilities(this.config.model) }] }; }
}
