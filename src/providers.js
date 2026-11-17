import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { ApiClient, ProviderError } from './http.js';

function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  return value;
}

const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4' };

export async function localImageReference(path) {
  const mime = mimeTypes[extname(path).toLowerCase()];
  if (!mime) throw new Error('参考图须为 PNG、JPEG 或 WebP');
  const bytes = await readFile(path);
  if (!bytes.length) throw new Error('参考图为空');
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

// 文字对话没有服务端任务可查，也不会重复生成扣费成品；失败时直接说真实原因，不提示“核对服务端任务”。
// 一次分镜输出最多上万 token，慢模型或中转站要几分钟，超时低于 10 分钟时按 10 分钟等。
export const TEXT_MIN_TIMEOUT_MS = 600_000;
export function textTimeout(timeoutMs) { return Math.max(Number(timeoutMs) || 120_000, TEXT_MIN_TIMEOUT_MS); }
export async function requestText(api, path, json) {
  try { return await api.request(path, { method: 'POST', json }); }
  catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    const cause = error.detail || error.message;
    throw Object.assign(new ProviderError(`文字服务请求失败：${cause}`, { status: error.status, cause }), {
      code: /超时/.test(cause) ? 'TEXT_TIMEOUT' : 'TEXT_REQUEST_FAILED',
    });
  }
}
// 有些模型（如 Gemini 经中转）不理会 json_object，会包一层 ```json 代码块或加一句说明。
export function parseJsonText(content) {
  const text = String(content).trim();
  const attempts = [text, text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')];
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start >= 0 && end > start) attempts.push(text.slice(start, end + 1));
  for (const candidate of attempts) { try { return JSON.parse(candidate); } catch {} }
  throw Object.assign(new Error(`文字服务返回的JSON不完整（收到${text.length}字，开头“${text.slice(0, 20).replace(/\s+/g, ' ')}”），本轮未保存，请重试`), { code: 'TEXT_JSON_INVALID', retryable: true });
}

export class DeepSeekProvider {
  constructor(config) { this.config = config; this.api = new ApiClient({ ...config, timeoutMs: textTimeout(config.timeoutMs) }); }

  async generateJson({ instructions, input, maxTokens = 8192 }) {
    const result = await requestText(this.api, this.config.submitPath || '/chat/completions', {
        model: required(this.config.model, 'DeepSeek 模型'),
        messages: [
          { role: 'system', content: `${required(instructions, '规则')}\n只输出一个 JSON 对象，不要 Markdown。` },
          { role: 'user', content: required(input, '输入内容') },
        ],
        response_format: { type: 'json_object' }, max_tokens: maxTokens, stream: false,
    });
    const choice = result.choices?.[0];
    if (choice?.finish_reason === 'length') throw Object.assign(new Error('DeepSeek 输出未正常完成：达到输出长度限制，结果已截断。本轮未保存，旧分镜保留；可用全部重新解析分镜分段重试。'), {code:'TEXT_OUTPUT_TRUNCATED'});
    if (String(choice?.finish_reason).toLowerCase() !== 'stop') throw new Error('DeepSeek 输出未正常完成，不能作为完整剧本或分镜保存');
    const content = choice.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('DeepSeek 返回了空内容');
    const data = parseJsonText(content);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('DeepSeek 未返回 JSON 对象');
    return data;
  }
}

export function grsaiAspectRatio(model, aspectRatio = '1024x1024') {
  // Grsai 的 vip/flare/sunburst 要求像素尺寸，不能直接提交 16:9。
  if (/(?:-vip|-flare|-sunburst)$/.test(model) && /^\d+:\d+$/.test(aspectRatio)) {
    const sizes = { '1:1': '1024x1024', '16:9': '1280x720', '9:16': '720x1280' };
    if (!sizes[aspectRatio]) throw new Error('该模型请填写文档支持的像素尺寸');
    return sizes[aspectRatio];
  }
  return aspectRatio;
}

export function normalizeGrsaiTask(raw) {
  const states = { running: 'running', succeeded: 'completed', failed: 'failed', violation: 'failed' };
  required(raw?.id, 'Grsai 任务 ID');
  if (!states[raw.status]) throw new Error('Grsai 返回了未知任务状态');
  const urls = Array.isArray(raw.results) ? raw.results.map(item => item.url).filter(Boolean) : [];
  if (raw.status === 'succeeded' && !urls.length) throw new Error('Grsai 标记成功但未返回图片地址');
  return { id: raw.id, status: states[raw.status], progress: raw.progress, urls, error: raw.error || null };
}

export class GrsaiImageProvider {
  constructor(config) { this.config = config; this.api = new ApiClient(config); }

  async submit({ prompt, images = [], aspectRatio = '1024x1024', quality = 'auto', background }) {
    const model = required(this.config.model, 'Grsai GPT Image 型号');
    if (!model.startsWith('gpt-image-')) throw new Error('生图须选择 Grsai 的 GPT Image 系列');
    if (!Array.isArray(images) || images.some(image => typeof image !== 'string' || !image)) {
      throw new Error('images 必须为参考图 URL 或 base64 字符串数组');
    }
    if (background !== undefined && background !== 'transparent') throw new Error('背景参数仅支持 transparent');
    const raw = await this.api.request('/v1/api/generate', {
      method: 'POST',
      json: {
        model, prompt: required(prompt, '图片提示词'), images,
        aspectRatio: grsaiAspectRatio(model, aspectRatio), quality,
        replyType: 'async', outputFormat: 'png', ...(background ? { background } : {}),
      },
    });
    return normalizeGrsaiTask(raw);
  }

  async getTask(id) {
    return normalizeGrsaiTask(await this.api.request(`/v1/api/result?id=${encodeURIComponent(required(id, '任务 ID'))}`));
  }
}

export function normalizeFydmaiTask(raw) {
  required(raw?.id, '菲阳视频任务 ID');
  if (!['queued', 'in_progress', 'completed', 'failed'].includes(raw.status)) throw new Error('菲阳返回了未知任务状态');
  if (raw.status === 'completed' && !raw.url) throw new Error('菲阳标记完成但未返回视频地址');
  return {
    id: raw.id, status: raw.status === 'in_progress' ? 'running' : raw.status,
    progress: raw.progress, urls: raw.url ? [raw.url] : [], error: raw.error || null,
  };
}

export class FydmaiVideoProvider {
  constructor(config) { this.config = config; this.api = new ApiClient(config); }

  async listModels() {
    // 模型、时长、参考素材数量等以服务端返回为准，不硬编码截图上的价格或上限。
    return this.api.request('/v1/models');
  }

  async getCapabilities() {
    // 菲阳公开网页客户端从 /caps 读取详细限制；/v1/models 仅列出模型ID。
    return this.api.request('/caps');
  }

  async uploadImage(path) {
    return this.uploadFile(path, 'image');
  }

  async uploadAudio(path) {
    return this.uploadFile(path, 'audio');
  }

  async uploadFile(path, kind = 'image') {
    const bytes = await readFile(path);
    const mime = mimeTypes[extname(path).toLowerCase()];
    const allowed = kind === 'audio' ? mime?.startsWith('audio/') : mime?.startsWith('image/');
    if (!allowed || !bytes.length) throw new Error(kind === 'audio' ? '上传参考音频须为非空 MP3、WAV 或 M4A' : '上传参考图须为非空 PNG、JPEG 或 WebP');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const existing = await this.api.request('/up/check', { method: 'POST', json: { sha256 } });
    if (existing.exists === true) return { assetId: required(existing.assetId, '已上传素材 ID'), sha256, reused: true };
    if (existing.exists !== false) throw new Error('素材去重查询返回格式不明确，停止上传');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), basename(path));
    const result = await this.api.request('/up/', { method: 'POST', form });
    return { assetId: required(result.assetId, '上传素材 ID'), sha256, reused: false };
  }

  async submit({ prompt, duration, resolution, aspectRatio, referenceImages = [], referenceAudios = [] }) {
    required(prompt, '视频提示词');
    if (/\{\{ref:/.test(prompt)) throw new Error('仍有未编译的资产引用，不能提交视频');
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('视频时长必须为正数');
    if (!Array.isArray(referenceImages) || referenceImages.some(item => typeof item?.assetId !== 'string' || !item.assetId)) {
      throw new Error('referenceImages 须为含 assetId 的对象数组');
    }
    if (!Array.isArray(referenceAudios) || referenceAudios.some(item => typeof item?.assetId !== 'string' || !item.assetId)) {
      throw new Error('referenceAudios 须为含 assetId 的对象数组');
    }
    return normalizeFydmaiTask(await this.api.request('/v1/videos', {
      method: 'POST',
      json: {
        model: required(this.config.model, '菲阳视频模型'), prompt, duration,
        ...(resolution ? { resolution } : {}), ...(aspectRatio ? { aspectRatio } : {}),
        referenceImages: referenceImages.map(({ assetId }) => ({ assetId })),
        ...(referenceAudios.length ? { referenceAudios: referenceAudios.map(({ assetId }) => ({ assetId })) } : {}),
      },
    }));
  }

  async getTask(id) {
    return normalizeFydmaiTask(await this.api.request(`/v1/videos/${encodeURIComponent(required(id, '视频任务 ID'))}`));
  }
}
