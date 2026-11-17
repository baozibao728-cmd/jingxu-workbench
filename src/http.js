import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class ProviderError extends Error {
  constructor(message, { status, submissionUnknown = false, cause } = {}) {
    super(message);
    this.status = status;
    this.detail = cause;
    this.submissionUnknown = submissionUnknown;
  }
}

export class ApiClient {
  constructor({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = 120_000, authHeader = 'Authorization', authPrefix = 'Bearer ' }) {
    const base = new URL(baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
      throw new Error('API 基础地址必须为不含凭据和查询参数的 HTTPS 地址');
    }
    this.baseUrl = base.href.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.authHeader=authHeader;this.authPrefix=authPrefix;
  }

  async request(path, { method = 'GET', json, form } = {}) {
    if (!this.apiKey) throw new Error('尚未填写该服务的 API Key');
    const url = new URL(`${this.baseUrl}${path}`);
    if (url.origin !== new URL(this.baseUrl).origin || !path.startsWith('/') || path.startsWith('//')) {
      throw new Error('API 路径无效');
    }
    const headers = { [this.authHeader]: `${this.authPrefix}${this.apiKey}` };
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    // POST 超时可能已在服务端建立计费任务，禁止在此自动重提。
    let response;
    try {
      response = await this.fetchImpl(url, {
        method, headers, redirect: 'error',
        body: form ?? (json === undefined ? undefined : JSON.stringify(json)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw this.failure(method, transportCause(error, this.timeoutMs));
    }
    let payload;
    try {
      const text = await response.text();
      try { payload = JSON.parse(text); } catch { payload = undefined; if (response.ok || text.trim()) payload = NOT_JSON; }
    } catch (error) {
      throw this.failure(method, transportCause(error, this.timeoutMs), response.status);
    }
    if (!response.ok) {
      const detail = payload === NOT_JSON ? '' : upstreamMessage(payload, this.apiKey);
      throw new ProviderError(`接口返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`, {
        status: response.status, cause: `HTTP ${response.status}${detail ? `：${detail}` : ''}`,
        submissionUnknown: method === 'POST' && response.status >= 500,
      });
    }
    if (payload === NOT_JSON || payload === undefined) {
      const type = String(response.headers?.get?.('content-type') || '').split(';')[0].trim();
      throw this.failure(method, `返回内容不是JSON（HTTP ${response.status}${type ? `，${type.slice(0, 60)}` : ''}），可能是中转站错误页或流式数据`, response.status);
    }
    return payload;
  }

  failure(method, cause, status) {
    // 不回显请求头、Key、参考图 base64 或上游原始响应。
    return new ProviderError(`请求中断或响应格式无效（${cause}）；先核对远端任务，勿自动重复提交`, {
      status, cause, submissionUnknown: method === 'POST',
    });
  }
}

const NOT_JSON = Symbol('not-json');

function transportCause(error, timeoutMs) {
  if (error?.name === 'TimeoutError') return `等待超过${Math.round(timeoutMs / 1000)}秒仍未返回，已超时`;
  if (error?.name === 'AbortError') return '请求被中止';
  const code = error?.cause?.code || error?.code;
  return /^[A-Z][A-Z0-9_]{1,40}$/.test(String(code || '')) ? `网络中断（${code}）` : '网络中断或连接被重置';
}

function upstreamMessage(payload, apiKey) {
  const raw = payload?.error?.message ?? payload?.error ?? payload?.message ?? payload?.msg;
  if (typeof raw !== 'string') return '';
  let text = raw.replace(/[\r\n\t]+/g, ' ');
  if (apiKey) text = text.split(apiKey).join('***');
  return text.replace(/\b(?:sk|hm_live|scnk)[-_][A-Za-z0-9_-]{6,}/g, '***').trim().slice(0, 160);
}

export async function downloadResult(url, destination, { fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  if (/^data:image\/(png|jpeg|webp);base64,/.test(url)) {
    const bytes = Buffer.from(url.slice(url.indexOf(',')+1),'base64');
    if (!bytes.length || bytes.length > 30*1024*1024) throw new Error('图片base64结果为空或超过30MB');
    await mkdir(dirname(destination),{recursive:true});const temp=`${destination}.${randomUUID()}.part`;
    try { await writeFile(temp,bytes,{mode:0o600});await rename(temp,destination); }finally{await rm(temp,{force:true});}
    return {path:destination,bytes:bytes.length};
  }
  if (new URL(url).protocol !== 'https:') throw new Error('成品下载地址必须为 HTTPS');
  // 成品 CDN 使用公开链接；绝不附带任何服务的 API Key。
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('下载结果为空');
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.part`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return { path: destination, bytes: bytes.length };
}
