import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const storyboardFormatDefault = readFileSync(new URL('../prompts/storyboard-format-system.txt', import.meta.url), 'utf8').trim();

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

export const promptDefinitions = [
  { key: 'breakdown', label: '分镜拆解', description: '控制剧本如何拆成多个视频片段，适用于整份剧本的每一段。', default: '严格按原剧本顺序拆解，不改剧情，不遗漏动作与对白。每条对应一次视频生成，动作、对白和转场必须在指定时长内完成；长对白拆成更多片段。逐句保留原台词，不自行纠错或改写。首镜建立空间，同场保持人物、服装、站位、道具状态和光线连续。提示词写中文，包含景别、运镜、分秒动作时间线、对白原句、说话人和声音。只在正文中实际出现的动作上分镜，人物小传不是拍摄内容。' },
  { key: 'characters', label: '角色提取', description: '决定需要定妆的出镜角色、造型与合并规则。', default: '提取正文中需要出镜的人物，合并别名，沿用已有角色编号；同一人显著不同的服装或年龄可拆造型。仅在电话中出现的声音和人物小传中未实际出场的人物不生成肖像。明确年龄、外貌、发型、服饰和辨识特征。每个造型仅一张16:9横版设定图：左侧正脸面部特写，右侧正面、严格90°侧面、背面全身三视图；同一身份同一服装，白或浅灰背景。不要把视角拆为多个资产。' },
  { key: 'scenes', label: '场景提取', description: '决定空景、空间锚点及昼夜变体。', default: '提取正文实际拍摄的场景，合并相同空间的别名，保持建筑、家具、道路和窗户等空间锚点一致。明显不同的机位空间、室内外或昼夜光照可单列变体并说明关联。场景图必须为空景，无人、无人脸、无手、无人影，不把剧情动作或人物带入图片。明确空间结构、材质、光线和时段，比例跟随项目。' },
  { key: 'props', label: '道具提取', description: '决定叙事道具、车辆及状态变体。', default: '提取在剧情中有作用或需要保持一致的道具，包含需要明确辨识的车辆。相同款式合并为一项，不按持有人重复生成；明显不同的状态可拆变体。只列需要独立参考图的对象，普通布景可放在场景描述中。单件白底无手、无人，写明形状、颜色、材质、大小和关键细节。不要给同款挂坠增加不同花纹。' },
  { key: 'storyboardFormat', label: '分镜输出格式要求', description: '已内置详细短剧模板：人物、场景、道具、机位、调色、逐镜台词和禁止项。时长与画幅跟随项目设置；留空使用此模板。', default: storyboardFormatDefault },
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
