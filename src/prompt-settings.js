import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';


export function renderStoryboardFormat(template, { duration, aspectRatio }) {
  const vertical = aspectRatio === '9:16', horizontal = aspectRatio === '16:9';
  const values = {
    DURATION: String(duration), ASPECT: aspectRatio,
    FRAME_RULE: vertical ? '使用竖屏9:16；人物前后纵深站位，填写竖屏安全区禁用条款。' : horizontal ? '使用横屏16:9，人物位置明确左右关系，不得写竖屏9:16或竖屏边缘禁区。' : '使用方形1:1构图，写清前后和左右关系，不得写横屏16:9或竖屏9:16。',
    FRAME_DESCRIPTION: vertical ? '竖屏9:16剧情短剧构图' : horizontal ? '横屏16:9剧情短剧构图' : '方形1:1剧情短剧构图',
    PHONE_ORIENTATION: vertical ? '竖着' : horizontal ? '横着' : '以方形画幅',
    BLOCKING: vertical ? '人物前后纵深站位' : '人物左右位置与前后距离清楚',
    VERTICAL_SAFETY: vertical ? '；脸、口型、商品、关键动作放进画面右侧六分之一、底部五分之一、顶部十分之一' : '',
  };
  return String(template).replace(/\{\{(DURATION|ASPECT|FRAME_RULE|FRAME_DESCRIPTION|PHONE_ORIENTATION|BLOCKING|VERTICAL_SAFETY)\}\}/g, (_, key) => values[key]);
}

// 不内置任何提示词规则：两个 Gem 默认都是空的，由使用者在“接口设置 → 系统提示词”里自己填写或导入。
export const promptDefinitions = [
  { key: 'gem1', label: 'Gem 1 · 剧本拆分与资产', fileHint: '把剧本或小说拆成带时长的小段，并提取资产', description: '对应第一个 Gemini Gem：把整本剧本或小说拆分成一段段标明时长的可用小段剧本，并梳理出场的人物、场景、道具与商品清单。留空时不附加自定义规则。', default: '' },
  { key: 'gem2', label: 'Gem 2 · 分镜提示词生成', fileHint: '根据拆好的小段剧本生成分镜视频提示词', description: '对应第二个 Gemini Gem：每次只拿 Gem 1 拆好的某一小段剧本与本节资产，严格按你的模板与约束生成分镜视频提示词（支持 {{DURATION}}、{{ASPECT}} 等可选占位符）。留空时不附加自定义规则。', default: '' },
];

export const outputContract = '双 Gem 流程固定对接格式：\n· Gem 1 输出资产清单 {assets:[{key,kind,name,aspectRatio?,referenceKey?,noImage?,description,prompt}]}（kind 为 character / scene / prop / product）与分段小剧本 {shots:[{title,scriptExcerpt,description,duration,assetKeys}]}。\n· Gem 2 只接收当前这一小段的 scriptSegment 与本节对应资产，生成 {shots:[{title,description,duration,promptTemplate}]}，引用自动映射为 @素材名。';

export function resolvePrompts(overrides = {}) {
  return Object.fromEntries(promptDefinitions.map(item => [item.key, String(overrides[item.key] || '').trim() || item.default]));
}

export class PromptSettings {
  constructor(path) { this.path = path; this.overrides = {}; this.writes = Promise.resolve(); }
  async init() {
    try {
      const loaded = JSON.parse(await readFile(this.path, 'utf8'));
      this.overrides = Object.fromEntries(promptDefinitions.map(item => [item.key, String(loaded?.[item.key] || '').trim()]));
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  effective() { return resolvePrompts(this.overrides); }
  view() { return { definitions: promptDefinitions, overrides: this.overrides, outputContract }; }
  async save(input) {
    const next = {};
    for (const item of promptDefinitions) {
      const value = input[item.key] ?? this.overrides[item.key] ?? '';
      if (typeof value !== 'string' || value.length > 200000) throw new Error('每项系统提示词最多20万字');
      next[item.key] = value.trim();
    }
    const write = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(temporary, this.path);
      this.overrides = next;
    });
    this.writes = write; await write; return this.view();
  }
}
