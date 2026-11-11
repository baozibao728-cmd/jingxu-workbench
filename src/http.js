import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class ProviderError extends Error {
  constructor(message, { status, submissionUnknown = false } = {}) {
    super(message);
    this.status = status;
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
      const payload = await response.json();
      if (!response.ok) {
        throw new ProviderError(`接口返回 HTTP ${response.status}`, {
          status: response.status,
          submissionUnknown: method === 'POST' && response.status >= 500,
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      // 不回显请求头、Key、参考图 base64 或上游原始响应。
      throw new ProviderError('请求中断或响应格式无效；先核对远端任务，勿自动重复提交', {
        status: response?.status,
        submissionUnknown: method === 'POST',
      });
    }
  }
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
