// 资产使用稳定 ID + 内容哈希版本；人名和 @图片序号都不能充当资产主键。
export function compileReferences(template, assets, tagForSlot) {
  if (typeof tagForSlot !== 'function') throw new Error('须先确认视频模型的引用语法，才能编译提示词');
  const byId = new Map();
  for (const asset of assets) {
    if (!asset.id || !asset.version || !asset.assetId) throw new Error('引用资产缺少稳定 ID、版本或远端 assetId');
    if (byId.has(asset.id)) throw new Error(`资产 ID 重复：${asset.id}`);
    byId.set(asset.id, asset);
  }
  const slots = [];
  const indices = new Map();
  const prompt = template.replace(/\{\{ref:([^}]+)\}\}/g, (_, id) => {
    const asset = byId.get(id);
    if (!asset) throw new Error(`找不到已上传的引用资产：${id}`);
    if (!indices.has(id)) {
      indices.set(id, slots.length);
      slots.push({ ...asset, index: slots.length + 1 });
    }
    const slot = slots[indices.get(id)];
    const tag = tagForSlot(slot);
    if (typeof tag !== 'string' || !tag.trim()) throw new Error('引用语法转换返回空值');
    return tag;
  });
  if (/\{\{ref:/.test(prompt)) throw new Error('引用占位符格式有误');
  return { prompt, slots, referenceImages: slots.map(({ assetId }) => ({ assetId })) };
}

// 菲阳网页客户端的原生标记为 @上传文件名.扩展名，随后由服务端绑定为模型引用。
// 文件名必须与实际 multipart 上传名一致；实际成片的绑定效果仍需生成验证。
export function fydmaiFilenameTag(slot) {
  if (typeof slot.filename !== 'string' || !/^[\p{L}\p{N}_.-]+\.(png|jpe?g|webp)$/u.test(slot.filename)) {
    throw new Error('菲阳引用需要上传时使用的明确图片文件名');
  }
  return `@${slot.filename} `;
}
