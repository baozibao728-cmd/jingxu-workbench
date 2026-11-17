// FFmpeg 自动安装：电脑上没有 ffmpeg / ffprobe 时，从 ffmpeg-static 的 GitHub Release 下载对应平台的版本，
// 校验 SHA-256 后放到 data/tools/ffmpeg/。更新程序不会碰 data/，装一次以后一直能用。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, chmod, mkdir, rename, rm, constants } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const NAMES = ['ffmpeg', 'ffprobe'];
export const FFMPEG_RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/';
// 每个平台 .gz 文件的大小和 SHA-256，来自该 Release 在 GitHub 上公布的摘要。
export const FFMPEG_BUILDS = {
  'darwin-arm64': { ffmpeg: [19246198, '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa'], ffprobe: [19207077, 'd986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be'] },
  'darwin-x64': { ffmpeg: [25296431, '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106'], ffprobe: [25239438, 'd4da574d6e2e197bd259b47d69cf262df9e312af24ad960444f6d806d3d4c186'] },
  'win32-x64': { ffmpeg: [29581307, '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77'], ffprobe: [29521644, 'f309e6223ad89d2fe54bccd420a7709b66fd27540674e92309578ed491a43c8d'] },
  'linux-x64': { ffmpeg: [29354986, 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa'], ffprobe: [29276839, '25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067'] },
  'linux-arm64': { ffmpeg: [25568691, '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0'], ffprobe: [25493573, '2ab6aba60ee84412dff9188720703376cb4e7aaf7e0b5e43aa8249f2acae5bf8'] }
};

const works = async command => { try { await execute(command, ['-version'], { timeout: 15000, windowsHide: true }); return true; } catch { return false; } };

export function createFfmpegTools({ dir = fileURLToPath(new URL('../data/tools/ffmpeg', import.meta.url)), fetchImpl = fetch, platform = process.platform, arch = process.arch, base = FFMPEG_RELEASE, builds = FFMPEG_BUILDS, check = works } = {}) {
  // Windows on ARM 没有原生版本，用 x64 版本（系统自带转译）。
  const key = platform === 'win32' ? 'win32-x64' : `${platform}-${arch}`;
  const ext = platform === 'win32' ? '.exe' : '';
  const local = name => join(dir, name + ext);
  const status = { state: 'unknown', source: '', progress: 0, error: '' };
  let paths = null, pending = null;

  const download = async (name, [size, sha256], onBytes) => {
    const target = local(name), part = `${target}.part`;
    const response = await fetchImpl(`${base}${name}-${key}.gz`, { headers: { 'User-Agent': 'Jingxu-Workbench' }, redirect: 'follow', signal: AbortSignal.timeout(20 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）`);
    const hash = createHash('sha256'); let bytes = 0;
    const meter = new Transform({ transform(chunk, _, done) { bytes += chunk.length; if (bytes > size) return done(new Error('下载的文件大小不对')); hash.update(chunk); onBytes(chunk.length); done(null, chunk); } });
    try {
      await pipeline(Readable.fromWeb(response.body), meter, createGunzip(), createWriteStream(part, { mode: 0o755 }));
      if (bytes !== size || hash.digest('hex') !== sha256) throw new Error('下载的文件校验不通过，已丢弃');
      if (platform !== 'win32') await chmod(part, 0o755);
      await rename(part, target);
    } catch (error) { await rm(part, { force: true }); throw error; }
  };

  const install = async () => {
    if (await check('ffmpeg') && await check('ffprobe')) { Object.assign(status, { state: 'ready', source: 'system', progress: 1, error: '' }); return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }; }
    const mine = Object.fromEntries(NAMES.map(name => [name, local(name)]));
    const have = async name => { try { await access(mine[name], constants.X_OK); return await check(mine[name]); } catch { return false; } };
    const build = builds[key];
    const missing = [];
    for (const name of NAMES) if (!(await have(name))) missing.push(name);
    if (missing.length && !build) throw new Error(`这台电脑（${key}）没有可自动安装的 FFmpeg，请手动安装 FFmpeg（含 ffprobe）`);
    if (missing.length) {
      Object.assign(status, { state: 'installing', source: 'local', progress: 0, error: '' });
      await mkdir(dir, { recursive: true });
      const total = missing.reduce((sum, name) => sum + build[name][0], 0); let done = 0;
      for (const name of missing) await download(name, build[name], count => { done += count; status.progress = Math.min(1, done / total); });
      for (const name of missing) if (!(await have(name))) { await rm(mine[name], { force: true }); throw new Error('FFmpeg 已下载但无法运行'); }
    }
    Object.assign(status, { state: 'ready', source: 'local', progress: 1, error: '' });
    return mine;
  };

  // 同一时间只装一次；失败后下次调用会重新尝试。
  const ensure = () => {
    if (paths) return Promise.resolve(paths);
    pending ||= install().then(result => { paths = result; return result; }, error => {
      Object.assign(status, { state: 'failed', error: error.message });
      const failure = new Error(`FFmpeg 自动安装失败：${error.message}。请检查网络后再试`);
      failure.install = true; throw failure;
    }).finally(() => { pending = null; });
    return pending;
  };

  const run = async (name, args, options = {}) => execute((await ensure())[name], args, { windowsHide: true, ...options });
  return { ensure, run, status, key };
}

export const ffmpegTools = createFfmpegTools();
