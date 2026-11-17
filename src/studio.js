import { mkdir, readFile, writeFile, rename, readdir, rm, stat, copyFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { now, jobActive } from './project-store.js';
import { localImageReference } from './providers.js';
import { validateVideoSettings } from './video-profile.js';
import { normalizeUpload, splitMedia, trimAudio } from './media-clips.js';
import { scenetraAudioTag } from './scenetra.js';
import { huimiaoAudioTag } from './huimiao.js';

// 自由创作：不经过剧本和分镜，直接用一段提示词加参考图生成视频或图片。
// 数据单独放在 _studio 目录，不属于任何项目，也不进项目导出包。
const FILE = /^[a-z0-9_]+\.(png|jpg|webp|mp4|m4a|mp3)$/;
const MEDIA_URL = /^\/studio-media\/[a-z0-9_]+\.(png|jpg|webp|mp4|m4a|mp3)$/;
const RATIOS = ['16:9', '9:16', '1:1'];
const MAX_PROMPT = 8000;
const pause = ms => new Promise(done => setTimeout(done, ms));
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const number = (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;

// 画布内容由页面维护，这里只做格式和大小上的把关，不信任传进来的任何字段。
export function cleanCanvas(input = {}, previous = {}) {
  const nodes = [], ids = new Set();
  for (const raw of Array.isArray(input.nodes) ? input.nodes.slice(0, 300) : []) {
    if (!raw || typeof raw !== 'object' || !/^[a-z0-9]{6,20}$/.test(raw.id) || ids.has(raw.id)) continue;
    ids.add(raw.id);
    const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
    const type = ['video', 'audio'].includes(raw.type) ? raw.type : 'image';
    nodes.push({ id: raw.id, type, source: raw.source === 'upload' || type === 'audio' ? 'upload' : 'gen', duration: number(raw.duration, 0, 86400, 0),
      x: number(raw.x, -1e6, 1e6, 0), y: number(raw.y, -1e6, 1e6, 0), w: number(raw.w, 120, 900, 300), ratio: number(raw.ratio, .2, 5, 16 / 9),
      refId: /^[a-f0-9]{16}$/.test(raw.refId) ? raw.refId : '', url: MEDIA_URL.test(raw.url) ? raw.url : '',
      itemId: /^[a-f0-9]{16}$/.test(raw.itemId) ? raw.itemId : '', prompt: text(raw.prompt, MAX_PROMPT), label: text(raw.label, 40),
      settings: { channel: text(settings.channel, 200), duration: number(settings.duration, 0, 600, 0), resolution: text(settings.resolution, 20), aspectRatio: RATIOS.includes(settings.aspectRatio) ? settings.aspectRatio : '16:9' } });
  }
  const edges = [], seen = new Set();
  for (const raw of Array.isArray(input.edges) ? input.edges.slice(0, 1000) : []) {
    const key = `${raw?.from}>${raw?.to}`;
    if (!ids.has(raw?.from) || !ids.has(raw?.to) || raw.from === raw.to || seen.has(key)) continue;
    seen.add(key); edges.push({ from: raw.from, to: raw.to });
  }
  const groups = [], grouped = new Set();
  for (const raw of Array.isArray(input.groups) ? input.groups.slice(0, 100) : []) {
    if (!raw || typeof raw !== 'object' || !/^[a-z0-9]{6,20}$/.test(raw.id) || groups.some(group => group.id === raw.id)) continue;
    const members = [...new Set(Array.isArray(raw.nodes) ? raw.nodes : [])].filter(id => ids.has(id) && !grouped.has(id));
    if (!members.length) continue;
    for (const id of members) grouped.add(id);
    groups.push({ id: raw.id, label: text(raw.label, 40).trim() || '分组', nodes: members });
  }
  const view = input.view && typeof input.view === 'object' ? input.view : {};
  return { id: previous.id, title: text(input.title ?? previous.title, 60).trim() || '未命名画布', createdAt: previous.createdAt || now(), updatedAt: now(),
    view: { x: number(view.x, -1e7, 1e7, 0), y: number(view.y, -1e7, 1e7, 0), k: number(view.k, .1, 3, 1) }, nodes, edges, groups };
}

export function imageKind(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return '';
}

// 提示词里的 @图1、@图2 对应参考图的顺序。tag(序号) 返回要替换成的文字。
export function compileMentions(prompt, count, tag, audioCount = 0) {
  return String(prompt).replace(/@图(\d+)\s?/g, (_, digits) => {
    const index = Number(digits);
    if (index < 1 || index > count) fail(`提示词里的 @图${index} 没有对应的参考图，请先上传或删掉这个引用`);
    return tag(index);
  }).replace(/@音频(\d+)/g, (whole, digits) => {
    const index = Number(digits);
    if (index < 1 || index > audioCount) fail(`提示词里的 @音频${index} 没有对应的参考音频，请先连上音频或删掉这个引用`);
    return whole;
  }).trim();
}

// 萤漫这类接口用像素尺寸表示画幅，其余厂商分别传分辨率和画幅。
export function pixelSize(resolution, aspectRatio) {
  const short = { '480p': 480, '720p': 720, '1080p': 1080 }[resolution];
  if (!short) return resolution;
  const long = Math.round(short * 16 / 9 / 2) * 2;
  return aspectRatio === '9:16' ? `${short}x${long}` : aspectRatio === '1:1' ? `${short}x${short}` : `${long}x${short}`;
}

export class Studio {
  constructor(root, workflow, { intervalMs = workflow.intervalMs } = {}) {
    this.root = join(root, '_studio'); this.workflow = workflow; this.intervalMs = intervalMs;
    this.items = []; this.references = new Map(); this.clips = new Map(); this.canvases = new Map(); this.writes = Promise.resolve();
  }

  async init() {
    await mkdir(this.root, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(join(this.root, 'studio.json'), 'utf8'));
      this.items = Array.isArray(saved.items) ? saved.items : [];
      for (const item of Array.isArray(saved.references) ? saved.references : []) this.references.set(item.id, item);
      for (const item of Array.isArray(saved.clips) ? saved.clips : []) this.clips.set(item.id, item);
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('自由创作记录读取失败'); }
    for (const name of await readdir(this.root)) {
      const match = /^canvas_([a-f0-9]{16})\.json$/.exec(name); if (!match) continue;
      try { const canvas = JSON.parse(await readFile(join(this.root, name), 'utf8')); if (canvas.id === match[1]) this.canvases.set(canvas.id, canvas); } catch {}
    }
    await this.sweep();
    let changed = false;
    for (const item of this.items) {
      if (!jobActive(item.job)) continue;
      changed = true;
      if (item.job.taskId) this.queue(item);
      else if (item.job.submittedAt) item.job = { ...item.job, state: 'unknown', error: '重启时这条任务刚提交，结果不明确。请先到厂商后台核对，避免重复扣费。' };
      else item.job = { ...item.job, state: 'failed', error: '重启中断，这条还没有提交，可以重新生成。' };
    }
    if (changed) await this.save();
  }

  // 清掉一天前上传、但没有任何记录在用的参考图。
  async sweep() {
    const used = new Set([...this.items.flatMap(item => [item.refId, ...item.refs.map(ref => ref.id)]), ...[...this.canvases.values()].flatMap(canvas => canvas.nodes.map(node => node.refId))]);
    for (const [id, reference] of this.references) {
      if (used.has(id) || Date.now() - Date.parse(reference.createdAt) < 24 * 60 * 60 * 1000) continue;
      this.references.delete(id); await rm(join(this.root, reference.file), { force: true });
    }
    // 画布上的音视频素材：没有节点在用、又放了一天以上的，一起清掉。
    const urls = new Set([...[...this.canvases.values()].flatMap(canvas => canvas.nodes.map(node => node.url)), ...this.items.flatMap(item => (item.audios || []).map(audio => `/studio-media/${audio.file}`))]);
    for (const [id, clip] of this.clips) {
      if (urls.has(`/studio-media/${clip.file}`) || Date.now() - Date.parse(clip.createdAt) < 24 * 60 * 60 * 1000) continue;
      this.clips.delete(id); await rm(join(this.root, clip.file), { force: true });
    }
    for (const name of await readdir(this.root)) if (/\.(tmp|part)$/.test(name)) await rm(join(this.root, name), { force: true });
  }

  save() {
    const content = JSON.stringify({ items: this.items, references: [...this.references.values()], clips: [...this.clips.values()] }, null, 2);
    this.writes = this.writes.catch(() => {}).then(async () => {
      const temporary = join(this.root, `studio.${randomUUID()}.tmp`);
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, join(this.root, 'studio.json'));
    });
    return this.writes;
  }

  media(file) { if (!FILE.test(file)) fail('文件名无效'); return join(this.root, file); }
  item(id) { const item = this.items.find(entry => entry.id === id); if (!item) fail('这条记录不存在', 404); return item; }

  channels() {
    return this.workflow.videoChannels().map(channel => {
      const profile = this.workflow.videoProfile({ videoProviderId: channel.id, videoModel: channel.model });
      return { value: channel.value, label: channel.label, model: channel.model, unavailable: profile.unavailable === true, error: profile.error || '',
        minDuration: profile.minDuration, maxDuration: profile.maxDuration, defaultDuration: profile.defaultDuration,
        resolutions: profile.resolutions, defaultResolution: profile.defaultResolution, maxReference: Math.min(30, Number(profile.maxReference) || 9) };
    });
  }

  imageChannel() {
    const config = this.workflow.config().grsai || {};
    // OpenAI Images 兼容协议目前只能纯文字生图，不能带参考图。
    return { configured: Boolean(config.apiKey), label: `${config.name || '生图渠道'} · ${config.model || '未选模型'}`, model: config.model || '', maxReference: config.protocol === 'openai-images' ? 0 : 6 };
  }

  view() {
    return {
      channels: this.channels(), image: this.imageChannel(), ratios: RATIOS,
      items: this.items.map(item => ({
        id: item.id, kind: item.kind, prompt: item.prompt, createdAt: item.createdAt, label: item.label, model: item.model,
        channel: item.channel, duration: item.duration, resolution: item.resolution, aspectRatio: item.aspectRatio,
        refs: item.refs.map((ref, index) => ({ id: ref.id, name: `图${index + 1}`, url: `/studio-media/${ref.file}`, missing: !this.references.has(ref.id) })),
        audios: (item.audios || []).map((audio, index) => ({ name: `音频${index + 1}`, url: `/studio-media/${audio.file}` })),
        job: { state: item.job.state, progress: item.job.progress || 0, message: item.job.message || '', error: item.job.error || '', canResume: Boolean(item.job.taskId) && ['failed', 'unknown'].includes(item.job.state) },
        result: item.result ? { url: `/studio-media/${item.result.file}`, file: item.result.file } : null,
      })),
    };
  }

  async addReference(bytes, name = '') {
    const extension = imageKind(bytes);
    if (!extension) fail('参考图须为 PNG、JPEG 或 WebP 图片');
    if (bytes.length > 15 * 1024 * 1024) fail('请使用 15MB 以内的图片', 413);
    const id = randomBytes(8).toString('hex'), file = `ref_${id}.${extension}`;
    await writeFile(join(this.root, file), bytes, { mode: 0o600 });
    const reference = { id, file, name: String(name).slice(0, 80), createdAt: now() };
    this.references.set(id, reference); await this.save();
    return { id, url: `/studio-media/${file}` };
  }

  async create(input = {}) {
    const kind = input.kind === 'image' ? 'image' : 'video';
    const prompt = String(input.prompt || '').trim();
    if (!prompt) fail('请先写提示词');
    if (prompt.length > MAX_PROMPT) fail(`提示词不能超过 ${MAX_PROMPT} 字`);
    const ids = Array.isArray(input.refIds) ? input.refIds.map(String) : [];
    if (new Set(ids).size !== ids.length) fail('同一张参考图不用重复添加');
    const refs = ids.map(id => this.references.get(id) || fail('有参考图已失效，请重新上传'));
    for (const ref of refs) { try { await stat(join(this.root, ref.file)); } catch { fail('有参考图文件已丢失，请重新上传'); } }
    const aspectRatio = RATIOS.includes(input.aspectRatio) ? input.aspectRatio : '16:9';
    // 参考音频只给视频用，来自画布上的音频节点。
    const audioFiles = kind === 'video' && Array.isArray(input.audioFiles) ? input.audioFiles.map(value => String(value).replace(/^\/studio-media\//, '')) : [];
    if (new Set(audioFiles).size !== audioFiles.length) fail('同一段音频不用重复添加');
    if (audioFiles.length > 3) fail('参考音频最多 3 段');
    const clips = [...this.clips.values()], audios = audioFiles.map(file => clips.find(clip => clip.file === file && clip.kind === 'audio') || fail('有参考音频已失效，请重新连接'));
    for (const audio of audios) { try { await stat(join(this.root, audio.file)); } catch { fail('有参考音频文件已丢失'); } }
    compileMentions(prompt, refs.length, index => `图${index}`, audios.length);
    const item = { id: randomBytes(8).toString('hex'), kind, prompt, refs: refs.map(({ id, file }) => ({ id, file })), audios: audios.map(({ id, file, name }) => ({ id, file, name })), aspectRatio, createdAt: now(), job: { state: 'pending', progress: 0, operationId: randomUUID() } };
    if (kind === 'video') {
      const channel = this.workflow.videoChannels().find(entry => entry.value === input.channel);
      if (!channel) fail('请先选择视频渠道；还没有的话到“设置 → 接口配置”里添加视频方案');
      const profile = this.workflow.videoProfile({ videoProviderId: channel.id, videoModel: channel.model });
      const duration = Number(input.duration), resolution = String(input.resolution || profile.defaultResolution);
      validateVideoSettings(profile, duration, resolution);
      if (refs.length > Math.min(30, Number(profile.maxReference) || 9)) fail(`${channel.model} 最多带 ${Math.min(30, Number(profile.maxReference) || 9)} 张参考图`);
      Object.assign(item, { channel: channel.value, providerId: channel.id, model: channel.model, label: channel.label, duration, resolution });
    } else {
      const channel = this.imageChannel();
      if (!channel.configured) fail('还没有配置生图渠道，请到“设置 → 接口配置”里添加');
      if (refs.length > channel.maxReference) fail(channel.maxReference ? `生图最多带 ${channel.maxReference} 张参考图` : '当前生图渠道不支持参考图，请去掉参考图或换一个生图方案');
      const config = this.workflow.config().grsai;
      Object.assign(item, { providerId: config.id || '', model: config.model, label: channel.label });
    }
    this.items.unshift(item); await this.save(); this.queue(item);
    return this.view();
  }

  // 画布里把一张生成好的图当参考图用：复制一份登记为参考图，原作品删掉也不影响。
  async referenceFromItem(id) {
    const item = this.item(id);
    if (item.kind !== 'image' || !item.result) fail('只有生成好的图片才能作为参考图');
    if (!item.refId || !this.references.has(item.refId)) {
      const refId = randomBytes(8).toString('hex'), file = `ref_${refId}.png`;
      await copyFile(join(this.root, item.result.file), join(this.root, file));
      this.references.set(refId, { id: refId, file, name: '', createdAt: now() }); item.refId = refId; await this.save();
    }
    return { id: item.refId, url: `/studio-media/${this.references.get(item.refId).file}` };
  }

  // ---- 画布上的音频、视频素材 ----
  async registerClip(result, name) {
    const id = randomBytes(8).toString('hex'), file = basename(result.output);
    const clip = { id, file, kind: result.kind || (result.video ? 'video' : 'audio'), name: String(name || '').slice(0, 80), duration: Math.round((result.duration || 0) * 1000) / 1000,
      width: Number(result.video?.width) || 0, height: Number(result.video?.height) || 0, createdAt: now() };
    this.clips.set(id, clip); await this.save();
    return { id, kind: clip.kind, url: `/studio-media/${file}`, file, name: clip.name, duration: clip.duration, width: clip.width, height: clip.height };
  }
  // 上传时先落成临时文件，再整理成能播放的格式。
  async addClip(temporary, name) {
    const id = randomBytes(8).toString('hex');
    try { return await this.registerClip(await normalizeUpload(temporary, join(this.root, `clip_${id}`)), name); }
    finally { await rm(temporary, { force: true }); }
  }
  source(file) {
    const name = String(file || '').replace(/^\/studio-media\//, '');
    if (!FILE.test(name) || /\.(png|jpg|webp)$/.test(name)) fail('请选择一个音频或视频节点');
    return join(this.root, name);
  }
  async splitClip(file, name = '') {
    const path = this.source(file); await stat(path).catch(() => fail('原视频文件已经不在了', 404));
    const id = randomBytes(8).toString('hex'), result = await splitMedia(path, join(this.root, `clip_${id}_v`), join(this.root, `clip_${id}_a`));
    return { video: await this.registerClip({ ...result.video, kind: 'video' }, `${name}_无声`), audio: await this.registerClip({ ...result.audio, kind: 'audio' }, `${name}_音轨`) };
  }
  async trimClip(file, start, end, name = '') {
    const path = this.source(file); await stat(path).catch(() => fail('原音频文件已经不在了', 404));
    const id = randomBytes(8).toString('hex');
    return this.registerClip({ ...(await trimAudio(path, start, end, join(this.root, `clip_${id}`))), kind: 'audio' }, `${name}_截取`);
  }

  canvas(id) { const canvas = this.canvases.get(id); if (!canvas) fail('画布不存在', 404); return canvas; }
  listCanvases() {
    return [...this.canvases.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(canvas => ({ id: canvas.id, title: canvas.title, updatedAt: canvas.updatedAt, count: canvas.nodes.length,
      thumbs: canvas.nodes.filter(node => node.url).slice(0, 3).map(node => node.url) }));
  }
  async writeCanvas(canvas) {
    this.canvases.set(canvas.id, canvas);
    const content = JSON.stringify(canvas);
    this.writes = this.writes.catch(() => {}).then(async () => {
      const temporary = join(this.root, `canvas_${canvas.id}.${randomUUID()}.tmp`);
      await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, join(this.root, `canvas_${canvas.id}.json`));
    });
    await this.writes; return canvas;
  }
  async createCanvas(input = {}) {
    if (this.canvases.size >= 200) fail('画布数量已达上限，请先删除不用的画布');
    return this.writeCanvas(cleanCanvas({ title: input.title }, { id: randomBytes(8).toString('hex') }));
  }
  async updateCanvas(id, input) { return this.writeCanvas(cleanCanvas(input, this.canvas(id))); }
  async removeCanvas(id) {
    this.canvas(id); this.canvases.delete(id);
    this.writes = this.writes.catch(() => {}).then(() => rm(join(this.root, `canvas_${id}.json`), { force: true }));
    await this.writes; return this.listCanvases();
  }

  async resume(id) {
    const item = this.item(id);
    if (!item.job.taskId || !['failed', 'unknown'].includes(item.job.state)) fail('这条没有可以继续查询的任务');
    item.job = { ...item.job, state: 'pending', error: '' }; await this.save(); this.queue(item);
    return this.view();
  }

  async remove(id) {
    const item = this.item(id);
    if (jobActive(item.job)) fail('这条还在生成，完成或失败后才能删除', 409);
    this.items = this.items.filter(entry => entry !== item);
    if (item.result) await rm(join(this.root, item.result.file), { force: true });
    await this.save();
    return this.view();
  }

  queue(item) {
    const key = `studio:${item.id}`, workflow = this.workflow;
    if (workflow.active.has(key)) return;
    const pool = item.kind === 'image' ? workflow.imagePool : workflow.videoPool;
    const promise = pool.run(() => this.run(item)).finally(() => workflow.active.delete(key));
    workflow.active.set(key, promise); promise.catch(() => {});
  }

  config(item) {
    const workflow = this.workflow;
    if (item.kind === 'image') return item.providerId && workflow.getProviderById ? workflow.getProviderById(item.providerId) : workflow.config().grsai;
    return workflow.videoConfig({ providerId: item.providerId, model: item.model });
  }

  async run(item) {
    const workflow = this.workflow;
    if (workflow.stopping) return;
    const job = item.job; let submitting = false;
    try {
      const config = this.config(item);
      // 提交请求一返回任务号就先记下来，之后即使断线也能接着查，不会重复提交。
      const provider = workflow.factories[item.kind]({ ...config, model: item.model, fetchImpl: async (url, options = {}) => {
        const response = await (config.fetchImpl || fetch)(url, options);
        if (submitting && options.method === 'POST' && response.ok && !String(url).includes('dryRun=')) { try { const raw = await response.clone().json(); const id = raw?.id || raw?.runId; if (id && !job.taskId) { job.taskId = String(id); await this.save(); } } catch {} }
        return response;
      } });
      const paths = item.refs.map(ref => join(this.root, ref.file));
      let task;
      if (job.result?.status === 'completed') task = job.result;
      else if (job.taskId) task = await workflow.pollTask(provider, job.taskId);
      else if (item.kind === 'image') {
        const images = await Promise.all(paths.map(path => localImageReference(path)));
        Object.assign(job, { state: 'submitting', message: '提交图片', submittedAt: now() }); await this.save();
        submitting = true;
        task = await provider.submit({ prompt: compileMentions(item.prompt, paths.length, index => `图${index}`, 0), aspectRatio: item.aspectRatio, images });
      } else {
        await workflow.checkVideoAvailability({ videoProviderId: item.providerId, videoModel: item.model });
        Object.assign(job, { state: 'running', message: '上传参考图' }); await this.save();
        const slots = [];
        for (const [index, path] of paths.entries()) slots.push({ ...(await provider.uploadImage(path)), index: index + 1, name: `图${index + 1}`, filename: item.refs[index].file });
        const voices = [];
        if ((item.audios || []).length) {
          if (typeof provider.uploadAudio !== 'function') throw new Error('当前视频渠道不支持参考音频，请去掉音频或换一个渠道');
          job.message = '上传参考音频'; await this.save();
          for (const audio of item.audios) voices.push(await provider.uploadAudio(join(this.root, audio.file)));
        }
        let prompt = compileMentions(item.prompt, slots.length, index => workflow.videoTag(slots[index - 1], config), voices.length);
        // Scenetra 各模型引用音频的写法不同（@Audio1、Audio 1……），在这里换成对应写法。
        if (config.protocol === 'scenetra') prompt = prompt.replace(/@音频(\d+)/g, (_, digits) => scenetraAudioTag(item.model, Number(digits)));
        if (config.protocol === 'huimiao') prompt = prompt.replace(/@音频(\d+)/g, (_, digits) => huimiaoAudioTag(Number(digits)));
        Object.assign(job, { state: 'submitting', message: '提交视频', submittedAt: now() }); await this.save();
        submitting = true;
        task = await provider.submit({ model: item.model, prompt, duration: item.duration, aspectRatio: item.aspectRatio,
          resolution: config.protocol === 'openai-video' ? pixelSize(item.resolution, item.aspectRatio) : item.resolution,
          referenceImages: slots.map(({ assetId }) => ({ assetId })), referenceAudios: voices.map(({ assetId }) => ({ assetId })) });
      }
      submitting = false;
      if (!job.taskId) job.taskId = task.id;
      if (task.status === 'completed') job.result = task;
      await this.save();
      const deadline = Date.now() + 60 * 60 * 1000, noun = item.kind === 'image' ? '图片' : '视频';
      while (!workflow.stopping) {
        if (task.status === 'failed') throw new Error(typeof task.error === 'string' && task.error ? task.error : `${noun}服务返回失败`);
        job.state = task.status === 'completed' ? 'downloading' : task.status === 'queued' ? 'queued' : 'running'; job.progress = Number(task.progress) || 0;
        job.message = task.status === 'queued' ? '服务端排队中' : task.status === 'completed' ? '正在下载' : `正在生成${noun}`;
        await this.save();
        if (task.status === 'completed') {
          const file = `out_${item.id}_${Date.now().toString(36)}.${item.kind === 'image' ? 'png' : 'mp4'}`, destination = join(this.root, file);
          if (item.kind === 'video' && typeof provider.downloadTask === 'function') await provider.downloadTask(task.id, destination);
          else await workflow.download(task.urls[0], destination, { timeoutMs: 180000 });
          item.result = { file, createdAt: now() };
          item.job = { state: 'completed', progress: 100, taskId: job.taskId, message: '已完成' };
          await this.save(); return;
        }
        if (Date.now() > deadline) throw new Error('等待时间较长，可以点“继续查询”接着等原任务');
        await pause(this.intervalMs); task = await workflow.pollTask(provider, job.taskId);
      }
    } catch (error) {
      job.state = error.submissionUnknown && !job.taskId ? 'unknown' : 'failed';
      // 结果不明时也把原因留下（例如网络中断），方便判断要不要去厂商后台核对。
      job.error = workflow.errorText(error) + (error.submissionUnknown && !error.detail && error.message ? `。原因：${String(error.message).slice(0, 200)}` : ''); job.message = '';
      await this.save();
    }
  }
}
