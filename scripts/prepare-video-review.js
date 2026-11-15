import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { compileReferences, fydmaiFilenameTag } from '../src/references.js';

// 只编译本地审阅文件。无网络调用，不导入视频提交器。
const root = 'data/integration-test';
const caps = JSON.parse(await readFile(`${root}/fydmai-capabilities.json`, 'utf8'));
const config = readConfig().fydmai;
const model = caps.models.find(item => item.model === config.model && item.onShelf !== false);
if (!model || model.minDuration > 5 || model.maxDuration < 5 || !model.resolutions.includes('480p')) {
  throw new Error('该模型不能按计划以480p生成5秒测试');
}
const ids = ['keyframe', 'character-01', 'scene-01', 'prop-01'];
if (model.maxReference < ids.length) throw new Error('该模型参考图数量不足');
const assets = [];
for (const id of ids) {
  const upload = JSON.parse(await readFile(`${root}/${id}-upload.json`, 'utf8'));
  const bytes = await readFile(`${root}/${id}.png`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== upload.sha256) throw new Error(`参考图版本已改变：${id}`);
  assets.push({ id, version: sha256, assetId: upload.assetId, filename: `${id}.png` });
}
const template = '写实电影风格，横屏16:9，总时长严格5秒，单一连续镜头。以 {{ref:keyframe}} 的构图和人物站位作为起始画面。人物外貌和服装严格参考 {{ref:character-01}} ，书房空间、木桌和左侧窗户参考 {{ref:scene-01}} ，红色信封的外形、颜色和材质参考 {{ref:prop-01}} 。0至1.5秒：女信使站在木桌旁，中景稳定，红色信封平放在她手边的桌面上。1.5至3秒：她用右手自然拿起红色信封。3至4.2秒：她握住信封，身体微转向左侧窗户。4.2至5秒：她抬眼望向窗外，镜头缓慢推近至中近景。保持同一张脸、蓝色上衣、米色长裤、暖色日光和空间连续性。只有一人、一个信封，不分屏、不拼图，不增加人物，无对白、无字幕、无商标。';
const compiled = compileReferences(template, assets, fydmaiFilenameTag);
const request = { model: config.model, prompt: compiled.prompt, duration: 5, resolution: '480p', aspectRatio: '16:9', referenceImages: compiled.referenceImages };
const sha256 = createHash('sha256').update(JSON.stringify(request)).digest('hex');
const review = {
  status: 'awaiting_user_review', submitted: false, requestSha256: sha256,
  rule: '用户要求视频测试仅5秒，并在提交前审阅提示词和参考素材。未收到对这份具体内容的确认不得提交。',
  request, assets: compiled.slots,
  referenceSyntax: '菲阳公开网页客户端使用 @文件名，成片绑定效果尚待真实5秒生成验证。',
};
await writeFile(`${root}/video-review.json`, JSON.stringify(review, null, 2), { mode: 0o600 });
const markdown = `# 5秒视频测试 · 待用户审阅\n\n状态：尚未提交。\n\n模型：${request.model}；时长：5秒；分辨率：480p；比例：16:9。\n\n## 将提交的完整提示词\n\n${request.prompt}\n\n## 参考图顺序\n\n${compiled.slots.map(slot => `${slot.index}. ${slot.filename}（版本 ${slot.version.slice(0, 12)}）`).join('\n')}\n\n请求摘要：${sha256}\n\n需要用户确认此具体提示词、四张参考图和5秒参数后，才能提交一条视频任务。\n`;
await writeFile(`${root}/视频测试_提交前审阅.md`, markdown);
console.log(JSON.stringify({ path: `${root}/video-review.json`, status: review.status, request, requestSha256: sha256 }, null, 2));
