import { readFileSync } from 'node:fs';

export const CHARACTER_SHEET_LAYOUT = 'character-sheet-face-and-three-view';
export function characterSheetSystemPrompt() {
  return readFileSync(new URL('../prompts/character-sheet-system.txt', import.meta.url), 'utf8').trim();
}

const contracts = {
  scene: 'Create an EMPTY ENVIRONMENT reference image only. There must be ZERO people, ZERO characters, ZERO human faces, ZERO human silhouettes and ZERO human body parts anywhere in the image. Show only the architectural space, furniture and lighting described below. Do not stage any story action.',
  prop: 'Create ONE isolated object reference image. A single specified prop centered on a plain white background. No people, no hands, no characters, no narrative scene, no extra objects. Preserve the object shape, material, colour and intended state.',
  frame: 'Create one coherent cinematic composition from the supplied references. One continuous frame, no collage, no split screen.',
};

export function buildAssetImagePrompt(asset, style) {
  if (asset.kind === 'character') {
    return `${characterSheetSystemPrompt()}\n\n【角色描述：仅提取身份、外貌与服饰信息】\n${asset.prompt}\n\n【项目画风】\n${style}\n\n【最终输出确认】\n单张16:9横版设定图：最左侧面部特写，右侧依次为正面、90°侧面、背面全身三视图。所有视图为同一角色，不增加单独图片。`;
  }
  const contract = contracts[asset.kind];
  if (!contract) throw new Error('不支持的资产类型');
  // 项目规则已在提取阶段落实为这项资产的提示词；不能再把剧本/资产清单混入生图输入。
  return `${contract}\n\nASSET DETAILS:\n${asset.prompt}\n\nVISUAL STYLE: ${style}.\n\nMANDATORY COMPOSITION:\n${contract}\nNo watermark, no logo, no added text.`;
}
