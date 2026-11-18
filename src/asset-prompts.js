import { readFileSync } from 'node:fs';

export const CHARACTER_SHEET_LAYOUT = 'character-sheet-face-and-three-view';
export function characterSheetSystemPrompt() {
  return readFileSync(new URL('../prompts/character-sheet-system.txt', import.meta.url), 'utf8').trim();
}

const VALID_ASSET_KINDS = new Set(['character', 'scene', 'prop', 'product', 'frame']);

export function buildAssetImagePrompt(asset, style = '', { characterPencil = false, characterSheet = false, hasReference = false } = {}) {
  if (!VALID_ASSET_KINDS.has(asset.kind)) throw new Error('不支持的资产类型');
  const basePrompt = String(asset.prompt || '').trim();
  const cleanStyle = String(style || '').trim();
  if (asset.kind === 'character') {
    const styleLine = cleanStyle ? `\n\n【项目画风】\n${cleanStyle}` : '';
    const pencil = characterPencil ? `\n\n【彩铅人物开关：已开启】\n使用彩色铅笔手绘人物设定图：保留清晰可辨的彩铅笔触、纸张颗粒、叠加排线和自然的手绘边缘；颜色丰富但不脏、不糊，人物结构和服饰细节清楚。使用彩铅插画质感，不要照片写实、油画、水彩晕染或厚重卡通描边。${characterSheet ? '左侧面部特写与右侧三视图必须保持同一人物身份、脸型、肤色、发型、体型和服装。' : ''}` : '';
    const refLock = hasReference ? `\n\n【同角色换装/追加造型参考图锁定】\n已附带该角色的基础参考图：必须严格保持参考图中这个人的脸型、五官特征、肤色、身高与身材比例完全不变，确保是同一个人；仅按以下角色描述更换穿搭服饰或造型细节。` : '';
    if (characterSheet) {
      return `${characterSheetSystemPrompt()}\n\n【角色描述：仅提取身份、外貌与服饰信息】\n${basePrompt}${refLock}${styleLine}${pencil}\n\n【最终输出确认】\n单张16:9横版设定图：最左侧面部特写，右侧依次为正面、90°侧面、背面全身三视图。所有视图为同一角色，不增加单独图片。`;
    }
    return `${basePrompt}${refLock}${styleLine}${pencil}`.trim();
  }
  const refLock = hasReference ? (
    asset.kind === 'scene'
      ? '\n\n【同场景变体/反向参考图锁定】保持与参考图同一个建筑空间，墙、门窗、家具、陈设位置和样式完全不变，仅按描述调整光线、状态或拍摄方向。'
      : asset.kind === 'product'
        ? '\n\n【同商品多角度/细节参考图锁定】保持与参考图同一件商品的外观、包装、材质、配色和文字标识不变，仅按描述展示新角度或细节。'
        : '\n\n【同道具状态变体参考图锁定】保持与参考图同一件物品的轮廓、尺寸比例、材质、颜色和结构不变，仅按描述呈现状态变化。'
  ) : '';
  const styleLine = cleanStyle ? `\n\n【项目画风】\n${cleanStyle}` : '';
  return `${basePrompt}${refLock}${styleLine}`.trim();
}
