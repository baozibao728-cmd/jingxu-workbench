// 惠喵（huimiaovip.com）视频适配，按它的《对外 API 调用文档》原生接口写：
// 参考素材走它自己的直传（presign → PUT → complete），提交 /v1/videos/generations，查询同路径，下载 /v1/videos/{id}/content。
import { readFile, writeFile, rename, rm, mkdir, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { audioForUpload, probeMedia } from './media-clips.js';

// 文档 9B 节列出的主站公开模型（时长、参考图、参考音频上限）。厂商随时会调整，连接测试会按 /v1/models 报出实际能力。
// 清晰度文档没有逐个列出，默认给 720p；不支持的组合惠喵会在扣积分前直接拒绝。
export const HUIMIAO_MODELS = {
  'sd-2.0-pro-face': { label: 'SD 2.0 Pro Face', duration: [4, 15], maxImages: 9, maxAudios: 3 },
  'seedance2.0': { label: 'Seedance 2.0', duration: [4, 15], maxImages: 9, maxAudios: 0 },
  'sd-2.0-mini': { label: 'SD 2.0 Mini', duration: [5, 15], maxImages: 9, maxAudios: 3 },
  'sd-2.0-720p-14s': { label: 'SD 2.0 720p 14秒', duration: [4, 14], maxImages: 9, maxAudios: 0 },
  'vega-video-2.0-fast': { label: 'Vega Video 2.0 Fast', duration: [4, 15], maxImages: 9, maxAudios: 0 },
  'vega-video-2.0': { label: 'Vega Video 2.0', duration: [4, 15], maxImages: 9, maxAudios: 0 },
  'hm-video-sd2.0-933-9': { label: 'HM Video SD2.0 933', duration: [4, 15], maxImages: 9, maxAudios: 3 }
};
export const HUIMIAO_DEFAULT = 'sd-2.0-pro-face';
export const huimiaoPresetModels = () => Object.entries(HUIMIAO_MODELS).map(([id, model]) => ({ id, label: model.label }));
// 表里有的模型按表；自己填的其他模型 ID 用方案里填的视频参数。
export function huimiaoCapabilities(config) {
  const model = HUIMIAO_MODELS[config.model];
  if (!model) return config.capabilities;
  const [min, max] = model.duration, resolutions = config.capabilities?.resolutions?.length ? config.capabilities.resolutions : ['720p'];
  return { minDuration: min, maxDuration: max, defaultDuration: Math.min(max, Math.max(min, 10)), resolutions,
    defaultResolution: resolutions.includes(config.capabilities?.defaultResolution) ? config.capabilities.defaultResolution : resolutions[0], maxReference: model.maxImages, maxAudio: model.maxAudios };
}
// 文档示例用“参考图1”这样的写法，按提交的素材顺序对应。
export const huimiaoImageTag = index => `参考图${index}`;
export const huimiaoAudioTag = index => `参考音频${index}`;

const STATES = { queued: 'queued', in_progress: 'running', completed: 'completed', failed: 'failed' };
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
const RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const pause = ms => new Promise(done => setTimeout(done, ms));
const extension = path => (path.match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase();

export class HuimiaoVideoProvider {
  constructor(config) {
    this.config = config;
    this.base = new URL(config.baseUrl || 'https://huimiaovip.com');
    if (this.base.protocol !== 'https:') throw new Error('惠喵地址必须为 HTTPS');
    this.fetch = config.fetchImpl || fetch;
    this.timeoutMs = config.timeoutMs || 120000;
    this.wait = config.pauseImpl || pause;
  }
  auth() { if (!this.config.apiKey) throw new Error('尚未填写惠喵的 API Key'); return { Authorization: `Bearer ${this.config.apiKey}` }; }
  async call(path, { method = 'GET', json, headers = {} } = {}) {
    let response;
    try {
      response = await this.fetch(new URL(path, this.base), { method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { ...this.auth(), ...(json ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers }, body: json ? JSON.stringify(json) : undefined });
    } catch { throw Object.assign(new Error('连不上惠喵，请检查网络；如果是提交时断开，先“继续查询”，不要重复提交'), { submissionUnknown: method === 'POST' }); }
    const raw = await response.json().catch(() => null);
    if (!response.ok) {
      // 惠喵的错误说明是给用户看的中文，直接显示；不回显请求内容和 Key。
      const detail = String(raw?.error?.message || '').replace(/hm_live_[A-Za-z0-9_-]+/g, 'hm_live_***').slice(0, 300);
      throw Object.assign(new Error(`惠喵返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`), { status: response.status, submissionUnknown: method === 'POST' && response.status >= 500 });
    }
    return raw;
  }
  // 直传三步：申请地址 → PUT 原文件（不带 Key）→ 确认。音频要声明真实时长，且只收 mp3 / wav。
  async upload(path, kind) {
    const { file, cleanup } = kind === 'audio' ? await audioForUpload(path, tmpdir()) : { file: path, cleanup: null };
    try {
      const type = TYPES[extension(file)];
      if (!type || (kind === 'audio') !== type.startsWith('audio/')) throw new Error(kind === 'audio' ? '参考音频格式不支持' : '参考图只支持 png、jpg、webp');
      const bytes = await readFile(file);
      let duration = 0;
      if (kind === 'audio') {
        duration = Math.round((await probeMedia(file)).duration * 1000);
        if (duration < 2000) throw new Error('惠喵的参考音频至少要 2 秒');
      }
      const ticket = await this.call('/v1/uploads/presign', { method: 'POST', json: { filename: `reference${extension(file)}`, content_type: type, size: bytes.length, duration_ms: duration } });
      if (!ticket?.object_key || !String(ticket.put_url || '').startsWith('https://')) throw new Error('惠喵没有返回上传地址');
      let put;
      try { put = await this.fetch(ticket.put_url, { method: 'PUT', headers: { ...(ticket.headers || {}) }, body: bytes, redirect: 'error', signal: AbortSignal.timeout(5 * 60 * 1000) }); }
      catch { throw new Error('参考素材上传到惠喵失败，请检查网络后重试'); }
      if (!put.ok) throw new Error(`参考素材上传到惠喵失败（HTTP ${put.status}）`);
      const done = await this.call('/v1/uploads/complete', { method: 'POST', json: { object_key: ticket.object_key } });
      if (done?.verified !== true) throw new Error('惠喵没有通过这份参考素材的校验');
      // 对象键有使用期限，文档没写多久；工作流缓存只留 1 小时，过期就重新上传。
      return { assetId: ticket.object_key, filename: basename(path), expiresAt: new Date(Date.now() + 3600e3).toISOString() };
    } finally { if (cleanup) await rm(cleanup, { force: true }); }
  }
  uploadImage(path) { return this.upload(path, 'image'); }
  uploadAudio(path) { return this.upload(path, 'audio'); }
  body({ prompt, duration, resolution, aspectRatio, referenceImages = [], referenceAudios = [] }) {
    const model = HUIMIAO_MODELS[this.config.model];
    if (model && referenceImages.length > model.maxImages) throw new Error(`${model.label} 最多带 ${model.maxImages} 张参考图`);
    if (model && referenceAudios.length > model.maxAudios) throw new Error(model.maxAudios ? `${model.label} 最多带 ${model.maxAudios} 段参考音频` : `${model.label} 不支持参考音频，请去掉音频或换 SD 2.0 Pro Face 等模型`);
    const json = { model: this.config.model, prompt: String(prompt || ''), duration: Math.round(Number(duration)) || 5 };
    if (resolution) json.resolution = resolution;
    if (RATIOS.includes(aspectRatio)) json.ratio = aspectRatio;
    if (referenceImages.length) json.asset_keys = referenceImages.map(item => item.assetId);
    if (referenceAudios.length) json.audio_asset_keys = referenceAudios.map(item => item.assetId);
    return json;
  }
  async submit(input) {
    const json = this.body(input);
    // 惠喵要求幂等键：每次提交一个新键，网络重试也不会重复扣费。
    const raw = await this.call('/v1/videos/generations', { method: 'POST', json, headers: { 'Idempotency-Key': `jingxu_${randomUUID().replaceAll('-', '')}` } });
    if (!raw?.id) throw new Error('惠喵没有返回任务号');
    return this.task(raw);
  }
  task(raw) {
    const status = STATES[raw?.status];
    if (!status) throw new Error('惠喵返回了未知任务状态');
    return { id: String(raw.id), status, progress: Number(raw.progress) || 0, urls: raw.download_url ? [String(raw.download_url)] : [],
      error: status === 'failed' ? String(raw.error?.message || '惠喵生成失败，积分已退回') : null };
  }
  async getTask(id) { return this.task(await this.call(`/v1/videos/generations/${encodeURIComponent(id)}`)); }
  // 下载：先带 Key 请求本站 content 地址，跳转到别的域名时不带 Key；文件还在准备（409 video_preparing）就按 Retry-After 等一会儿再要。
  async downloadTask(id, destination) {
    const start = new URL(`/v1/videos/${encodeURIComponent(id)}/content`, this.base);
    for (let attempt = 0; attempt < 20; attempt++) {
      let response, url = start;
      try {
        response = await this.fetch(url, { headers: this.auth(), redirect: 'manual', signal: AbortSignal.timeout(30 * 60 * 1000) });
        for (let hop = 0; hop < 3 && response.status >= 300 && response.status < 400; hop++) {
          url = new URL(response.headers.get('location') || '', url);
          if (url.protocol !== 'https:') throw new Error('惠喵成片下载地址必须为 HTTPS');
          response = await this.fetch(url, { headers: url.origin === this.base.origin ? this.auth() : {}, redirect: 'manual', signal: AbortSignal.timeout(30 * 60 * 1000) });
        }
      } catch (error) { if (/HTTPS/.test(error.message)) throw error; throw new Error('惠喵成片下载中断，可以点“继续查询”重新下载'); }
      if (response.status === 409) {
        const raw = await response.json().catch(() => null);
        if (raw?.error?.code === 'video_preparing') { await this.wait(Math.min(10, Number(response.headers.get('retry-after')) || 3) * 1000); continue; }
      }
      if (response.status === 410) throw new Error('惠喵的成片已超过下载期限');
      if (!response.ok) throw new Error(`惠喵成片下载失败 HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) throw new Error('惠喵成片为空');
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.part`;
      try { await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await rename(temporary, destination); } finally { await rm(temporary, { force: true }); }
      return { path: destination, bytes: (await stat(destination)).size };
    }
    throw new Error('惠喵的成片还在准备，稍后点“继续查询”再下载');
  }
  async getCapabilities() { return { models: [{ kind: 'video', model: this.config.model, ...huimiaoCapabilities(this.config) }] }; }
}
