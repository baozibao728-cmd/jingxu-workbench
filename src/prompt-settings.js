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

// 不再内置任何提示词规则：五项默认都是空的，由使用者在“接口设置 → 系统提示词”里自己填写。
// 没填时只按程序的固定输出字段约束去拆，效果取决于模型自己发挥。
export const promptDefinitions = [
  { key: 'breakdown', label: '分镜拆解', description: '控制剧本如何拆成多个视频片段，适用于整份剧本的每一段。', default: '' },
  { key: 'characters', label: '角色提取', description: '决定需要定妆的出镜角色、造型与合并规则。', default: '' },
  { key: 'scenes', label: '场景提取', description: '决定空景、空间锚点及昼夜变体。', default: '' },
  { key: 'props', label: '道具提取', description: '决定叙事道具、车辆及状态变体。', default: '' },
  { key: 'storyboardFormat', label: '分镜输出格式要求', description: '每条分镜提示词的版式模板。可用 {{DURATION}}、{{ASPECT}}、{{FRAME_RULE}} 等占位符，时长与画幅跟随项目设置。', default: '' },
];

export const outputContract = '固定结构：资产为 {assets:[{key,kind,name,description,prompt}]}，kind 为 character / scene / prop；分镜为 {shots:[{title,description,duration,promptTemplate}]}。引用使用 {{ref:资产key}}，程序自动转成 @图片文件名。自定义规则不改变这些字段，不能引用未选择的素材。人物生图始终为单张16:9面部＋三视图。';

export function resolvePrompts(overrides = {}) {
  return Object.fromEntries(promptDefinitions.map(item => [item.key, String(overrides[item.key] || '').trim() || item.default]));
}

export class PromptSettings {
  constructor(path) { this.path = path; this.overrides = {}; this.writes = Promise.resolve(); }
  async init() {
    try { this.overrides = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  effective() { return resolvePrompts(this.overrides); }
  view() { return { definitions: promptDefinitions, overrides: this.overrides, outputContract }; }
  async save(input) {
    const next = {};
    for (const item of promptDefinitions) {
      const value = input[item.key] ?? this.overrides[item.key] ?? '';
      if (typeof value !== 'string' || value.length > 20000) throw new Error('每项系统提示词最多2万字');
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
