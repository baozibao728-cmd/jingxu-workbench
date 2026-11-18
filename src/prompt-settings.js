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

// 不再内置任何提示词规则：各项默认都是空的，由使用者在“接口设置 → 系统提示词”里自己填写或批量导入。
// 支持“六模块公共约定 + 模块一～六 + 分镜输出格式覆盖”，也兼容旧版直接填五项。
export const promptDefinitions = [
  { key: 'common', label: '公共约定（总纲）', fileHint: '00_六模块公共约定.txt', description: '六个模块共用的核心规则。填写后，程序会在调用各模块时自动拼在最前面，无需重复粘六遍。', default: '' },
  { key: 'scenes', label: '模块一 · 场景提取', fileHint: '01_模块一_场景提取.txt', description: '决定场景去重、空景布局、文字场景与日夜/状态/反向变体规则。', default: '' },
  { key: 'characters', label: '模块二 · 角色提取', fileHint: '02_模块二_角色提取.txt', description: '决定谁需要出图定妆、基础形象与造型拆分、人物文字形象及待办清单规则。', default: '' },
  { key: 'props', label: '模块三 · 道具提取', fileHint: '03_模块三_道具提取.txt', description: '决定哪些叙事道具必须出图及状态版规则（不含在卖商品）。', default: '' },
  { key: 'products', label: '模块四 · 商品提取', fileHint: '04_模块四_商品.txt', description: '决定剧本里在卖商品的资产名、分镜嵌入写法与商品出场清单。', default: '' },
  { key: 'characterVariants', label: '模块五 · 角色追加形象', fileHint: '05_模块五_角色追加形象.txt', description: '决定如何拿基础形象图作为参考图生成换装/换造型角色图。', default: '' },
  { key: 'breakdown', label: '模块六 · 分镜拆解', fileHint: '06_模块六_分镜.txt', description: '控制剧本如何拆段、台词计时、机位连贯性与每段提示词撰写。', default: '' },
  { key: 'storyboardFormat', label: '分镜输出格式（可选覆盖）', fileHint: '单独覆盖输出版式时填写', description: '留空时直接使用模块六里的输出格式（若已包含）；单独填写时支持 {{DURATION}}、{{ASPECT}}、{{FRAME_RULE}} 等占位符。', default: '' },
];

export const outputContract = '固定结构：资产为 {assets:[{key,kind,name,referenceKey?,description,prompt}]}，kind 为 character / scene / prop（商品也用 prop，方便拖入实拍商品图替换）；分镜为 {shots:[{title,description,duration,promptTemplate}]}。引用使用 {{ref:资产key}}，程序自动转成 @图片文件名。可直接拖拽或批量选择「00_公共约定 + 01~06 模块」TXT 文件一键填入。';

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
