import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const now = () => new Date().toISOString();
export const jobActive = job => job && ['pending', 'submitting', 'queued', 'running', 'downloading'].includes(job.state);

export class ProjectStore {
  constructor(root) { this.root = resolve(root); this.projects = new Map(); this.writes = new Map(); }
  async init() {
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const project = JSON.parse(await readFile(join(this.root, entry.name, 'project.json'), 'utf8'));
        if (project.id === entry.name) this.projects.set(project.id, project);
      } catch (error) { if (error.code !== 'ENOENT') throw new Error(`项目文件读取失败：${entry.name}`); }
    }
  }
  get(id) { const project = this.projects.get(id); if (!project) throw Object.assign(new Error('项目不存在'), { status: 404 }); return project; }
  directory(id) { this.get(id); return join(this.root, id); }
  media(id, file) {
    if (!/^[\p{L}\p{N}_.-]+$/u.test(file) || file === '.' || file === '..') throw new Error('文件名无效');
    return join(this.directory(id), file);
  }
  async save(project) {
    project.updatedAt = now();
    const content = JSON.stringify(project, null, 2);
    const directory = this.directory(project.id);
    const previous = this.writes.get(project.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `project.${randomUUID()}.tmp`);
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, join(directory, 'project.json'));
    });
    this.writes.set(project.id, next);
    await next;
  }
  async create(input = {}) {
    const id = randomUUID();
    const project = {
      id, title: String(input.title || '未命名短剧').slice(0, 80), script: String(input.script || ''),
      style: String(input.style || '写实电影'), aspectRatio: input.aspectRatio || '16:9',
      clipDuration: Number(input.clipDuration || 15), resolution: input.resolution || '720p', ruleNotes: String(input.ruleNotes || ''),
      skipReview: input.skipReview === true,
      revision: 1, assets: [], shots: [], logs: [],
      preparation: { state: 'idle', stage: '等待剧本', completed: 0, total: 0 }, createdAt: now(), updatedAt: now(),
    };
    this.projects.set(id, project);
    await this.save(project);
    return project;
  }
  log(project, message, level = 'info', target = '') {
    project.logs.push({ id: randomUUID(), at: now(), level, message, target });
    project.logs = project.logs.slice(-160);
  }
  list() {
    return [...this.projects.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(project => ({
      id: project.id, title: project.title, createdAt: project.createdAt, updatedAt: project.updatedAt,
      assetCount: project.assets.length, shotCount: project.shots.length,
      preparation: project.preparation,
      thumbnail: project.assets.find(asset => asset.kind === 'frame' && asset.image)?.image?.file || project.assets.find(asset => asset.kind === 'scene' && asset.image)?.image?.file,
    }));
  }
}

export function safeFilename(name, suffix, extension = 'png') {
  const base = String(name).normalize('NFKC').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 30) || '参考图';
  return `${base}_${suffix}.${extension}`;
}

export function displayPrompt(template, assets) {
  return String(template || '').replace(/\{\{ref:([^}]+)\}\}/g, (_, id) => `@${assets.find(asset => asset.id === id)?.name || '已移除素材'} `);
}

export function parsePrompt(text, assets) {
  const source = String(text || '');
  const byLength = [...assets].sort((a, b) => b.name.length - a.name.length);
  let result = '', cursor = 0;
  while (cursor < source.length) {
    const at = source.indexOf('@', cursor);
    if (at < 0) { result += source.slice(cursor); break; }
    result += source.slice(cursor, at);
    const asset = byLength.find(item => {
      if (!source.startsWith(item.name, at + 1)) return false;
      const next = source[at + 1 + item.name.length];
      return !next || /[\s@，。！？；：,!?;:()（）]/.test(next);
    });
    if (!asset) throw new Error(`引用“${source.slice(at + 1).split(/[\s@，。！？；：,!?;:]/)[0]}”不存在，请从素材按钮插入`);
    result += `{{ref:${asset.id}}}`;
    cursor = at + 1 + asset.name.length;
  }
  const referenced = [...result.matchAll(/\{\{ref:([^}]+)\}\}/g)].map(match => match[1]);
  if (referenced.some(id => !assets.some(asset => asset.id === id))) throw new Error('提示词引用了已移除的素材');
  if (/\{\{ref:/.test(result.replace(/\{\{ref:[^}]+\}\}/g, ''))) throw new Error('素材引用格式不完整');
  return result;
}
