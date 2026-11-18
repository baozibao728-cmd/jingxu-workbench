import { createServer } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { readFile, writeFile, stat, mkdir, rm, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, extname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ProjectStore } from './project-store.js';
import { Workflow } from './workflow.js';
import { importExistingTest } from './demo-project.js';
import { readConfig } from './config.js';
import { ApiClient } from './http.js';
import { FydmaiVideoProvider } from './providers.js';
import { characterSheetSystemPrompt } from './asset-prompts.js';
import { PromptSettings } from './prompt-settings.js';
import { ConcurrencySettings } from './concurrency.js';
import { ProviderSettings, safeProvider } from './provider-settings.js';
import { createProvider } from './custom-providers.js';
import { testProvider } from './provider-test.js';
import { removeLegacyPrompts } from './legacy-cleanup.js';
import { exportPlan, writeExport, importProjects } from './project-transfer.js';
import { UpdateManager } from './update-manager.js';
import { ffmpegTools } from './ffmpeg-tools.js';
import { spawn } from 'node:child_process';
import { MiniMaxTTSProvider } from './minimax-tts.js';
import { VoiceStore } from './voice-store.js';
import { Studio } from './studio.js';

const applicationRoot = fileURLToPath(new URL('..', import.meta.url));
const publicRoot = join(applicationRoot, 'public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.json': 'application/json; charset=utf-8' };

export async function createApplication({ root = join(applicationRoot, 'data', 'projects'), config = readConfig(), seedDemo = true, workflowOptions = {}, persistSettings = true, updateRoot = applicationRoot, restartForUpdate, updateOptions = {} } = {}) {
  config.minimax ||= { baseUrl: 'https://api.minimax.cn', apiKey: '', model: 'speech-2.8-hd' };
  const store = new ProjectStore(root); await store.init();
  const providers=new ProviderSettings(join(root,'provider-settings.json'),config);await providers.init();Object.assign(config,providers.config());
  const prompts = new PromptSettings(join(root, 'system-prompts.json')); await prompts.init();
  const concurrency = new ConcurrencySettings(join(root, 'concurrency.json')); await concurrency.init();
  const voiceStore = new VoiceStore(join(applicationRoot, 'data', 'voice-library')); await voiceStore.init();
  let capabilities = null;
  try { capabilities = JSON.parse(await readFile(join(applicationRoot, 'data', 'integration-test', 'fydmai-capabilities.json'), 'utf8')); } catch {}
  const refreshCapabilities = async () => {
    capabilities = await createProvider('fydmai',config.fydmai).getCapabilities();
    return capabilities;
  };
  const workflow = new Workflow(store, () => config, { getCapabilities: () => capabilities, refreshCapabilities, getPrompts: () => prompts.effective(), getProviderById:id=>providers.byId(id), getProviderProfiles:()=>providers.view(), getVoiceAudio: () => voiceStore.data.history.map(item => ({ ...item, path: voiceStore.file(item.file) })), synthesizeVoice: async input => {
    const result = await new MiniMaxTTSProvider(config.minimax).synthesize({ text: input.text, model: input.model || config.minimax.model, voiceId: input.voiceId, speed: 1, vol: 1, pitch: 0, format: 'mp3' });
    const file = await voiceStore.saveAudio(result.bytes, result.format);
    const history = { id: randomBytes(8).toString('hex'), file, url: `/voice-media/${file}`, name: String(input.name || '').slice(0, 80), text: String(input.text || '').slice(0, 120), model: result.model, voiceId: result.voiceId, characterAssetId: input.characterAssetId || '', createdAt: new Date().toISOString(), durationMs: result.meta.audio_length || 0 };
    await voiceStore.addHistory(history); return history;
  }, ...workflowOptions });
  workflow.setConcurrency(concurrency.value);
  if (seedDemo) await importExistingTest(store, workflow, applicationRoot);
  // Bind original paid tasks and preserve unchanged legacy completion checks.
  for(const project of store.projects.values())if(workflow.migrateProviderBindings(project))await store.save(project);
  await workflow.recover();
  const studio = new Studio(root, workflow); await studio.init();
  const token = randomBytes(24).toString('hex');
  const busy=()=>workflow.active.size>0||[...store.projects.values()].some(p=>[p.preparation,p.mergeJob,...p.assets.map(a=>a.job),...p.shots.flatMap(s=>[s.job,s.rebuildJob])].some(j=>j&&['pending','submitting','queued','running','downloading'].includes(j.state)));
  const pkg=JSON.parse(await readFile(join(applicationRoot,'package.json'),'utf8'));
  const updates=new UpdateManager(updateRoot,{isBusy:busy,restart:restartForUpdate,repository:pkg.updateRepository||'',...updateOptions});await updates.init();
  const retryUpdateTimer=setInterval(()=>{if(updates.status.state==='waiting'&&updates.config.autoCheck&&updates.config.autoInstall&&!updates.busy)updates.install().catch(()=>{});},5000);retryUpdateTimer.unref();
  const updateTimer=setInterval(()=>updates.tick().catch(()=>{}),30*60*1000);updateTimer.unref();

  const settings = () => Object.fromEntries(Object.entries(config).map(([name,item])=>[name,safeProvider(item)]));
  const send = (response, status, data) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(data));
  };
  const body = async request => {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 22 * 1024 * 1024) throw Object.assign(new Error('上传内容过大，请使用20MB以内的图片'), { status: 413 }); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('请求格式无效'), { status: 400 }); }
  };
  const streamFile = async (request, response, path) => {
    const info = await stat(path);
    const headers = { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    let start = 0, end = info.size - 1;
    if (request.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
      if (!match || Number(match[1]) >= info.size) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return; }
      start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end;
      if (end < start) { response.writeHead(416); response.end(); return; }
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    response.writeHead(request.headers.range ? 206 : 200, headers);
    if (request.method === 'HEAD') response.end(); else createReadStream(path, { start, end }).on('error', () => response.destroy()).pipe(response);
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (segments[0] === 'api') {
        if (request.method !== 'GET') {
          if(updates.busy)return send(response,409,{error:'程序正在更新，请稍后再操作'});
          const origin = request.headers.origin;
          if (request.headers['x-workflow-token'] !== token || (origin && new URL(origin).host !== request.headers.host)) {
            return send(response, 403, { error: '页面已过期，请刷新后再操作' });
          }
          const zipUpload = url.pathname === '/api/projects/import' && request.headers['content-type']?.startsWith('application/zip');
          const clipUpload = url.pathname === '/api/studio/clips' && request.headers['content-type']?.startsWith('application/octet-stream');
          if (!zipUpload && !clipUpload && !request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: '请求必须为JSON' });
        }
        if (url.pathname === '/api/bootstrap' && request.method === 'GET') return send(response, 200, { token, settings: settings(), providerProfiles:providers.view(), updates:updates.view(), concurrency: workflow.concurrency(), prompts: prompts.view(), projects: store.list(), capabilities, videoProfile: workflow.videoProfile(), voice: voiceStore.view(Boolean(config.minimax.apiKey)), rules: { characterSheet: characterSheetSystemPrompt() } });
        if (url.pathname === '/api/voice' && request.method === 'GET') return send(response, 200, voiceStore.view(Boolean(config.minimax.apiKey)));
        if (url.pathname === '/api/voice/settings' && request.method === 'POST') {
          const input = await body(request); if (input.apiKey !== undefined && String(input.apiKey).trim()) config.minimax.apiKey = String(input.apiKey).trim();
          if (input.baseUrl !== undefined) config.minimax.baseUrl = String(input.baseUrl).trim() || 'https://api.minimax.cn';
          if (input.model !== undefined) config.minimax.model = String(input.model).trim() || 'speech-2.8-hd';
          await voiceStore.saveSettings(input);
          const envPath = join(applicationRoot, '.env'); let env = ''; try { env = await readFile(envPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          const values = { MINIMAX_BASE_URL: config.minimax.baseUrl, MINIMAX_TTS_MODEL: config.minimax.model, ...(config.minimax.apiKey ? { MINIMAX_API_KEY: config.minimax.apiKey } : {}) };
          for (const [key, value] of Object.entries(values)) { const line = `${key}=${String(value).replace(/\\/g,'\\\\').replace(/\n/g,'')}`; const re = new RegExp(`^${key}=.*$`, 'm'); env = re.test(env) ? env.replace(re, line) : `${env.trimEnd()}\n${line}\n`; }
          await writeFile(envPath, env, { mode: 0o600 }); return send(response, 200, voiceStore.view(Boolean(config.minimax.apiKey)));
        }
        if (url.pathname === '/api/voice/presets' && request.method === 'POST') return send(response, 200, await voiceStore.saveVoice(await body(request)));
        if (url.pathname.startsWith('/api/voice/history/') && request.method === 'DELETE') {
          const id = segments.at(-1); return send(response, 200, await voiceStore.deleteHistory(id));
        }
        if (url.pathname === '/api/voice/synthesize' && request.method === 'POST') {
          const input = await body(request); const text = String(input.text || '').trim(); if (!text) throw new Error('请输入要合成的文字'); if (text.length > 9999) throw new Error('单次语音文字不能超过9999字');
          const merged = { ...voiceStore.data, ...input }; const result = await new MiniMaxTTSProvider(config.minimax).synthesize({ text, model: merged.model, voiceId: merged.voiceId, speed: merged.speed, vol: merged.vol, pitch: merged.pitch, emotion: merged.emotion, format: 'mp3', languageBoost: merged.languageBoost, pronunciation: merged.pronunciation });
          const file = await voiceStore.saveAudio(result.bytes, result.format); const history = { id: randomBytes(8).toString('hex'), file, url: `/voice-media/${file}`, name: String(input.name || '').trim().slice(0, 80) || text.slice(0, 32), text: text.slice(0, 120), model: result.model, voiceId: result.voiceId, characterAssetId: '', createdAt: new Date().toISOString(), durationMs: result.meta.audio_length || 0 }; await voiceStore.addHistory(history); return send(response, 200, { ...history, bytes: result.bytes.length });
        }
        if (segments[1] === 'studio') {
          if (segments.length === 2 && request.method === 'GET') return send(response, 200, studio.view());
          if (segments[2] === 'references' && segments.length === 3 && request.method === 'POST') {
            const input = await body(request);
            return send(response, 201, await studio.addReference(Buffer.from(String(input.base64 || ''), 'base64'), input.name));
          }
          if (segments[2] === 'items' && segments.length === 3 && request.method === 'POST') return send(response, 202, await studio.create(await body(request)));
          if (segments[2] === 'clips' && segments.length === 3 && request.method === 'POST') {
            // 音视频可能很大，不走 JSON，直接按原始字节写进临时文件。
            const temporary = join(studio.root, `upload_${randomBytes(8).toString('hex')}.part`); let size = 0;
            const name = (() => { try { return decodeURIComponent(String(request.headers['x-file-name'] || '')); } catch { return ''; } })();
            try {
              const handle = await open(temporary, 'w', 0o600);
              try { for await (const chunk of request) { size += chunk.length; if (size > 500 * 1024 * 1024) throw Object.assign(new Error('请使用 500MB 以内的音视频文件'), { status: 413 }); await handle.write(chunk); } }
              finally { await handle.close(); }
              if (!size) throw new Error('文件是空的');
            } catch (error) { await rm(temporary, { force: true }); throw error; }
            return send(response, 201, await studio.addClip(temporary, name.replace(/\.[^.]+$/, '')));
          }
          if (segments[2] === 'split' && segments.length === 3 && request.method === 'POST') { const input = await body(request); return send(response, 201, await studio.splitClip(input.file, String(input.name || '').slice(0, 40))); }
          if (segments[2] === 'trim' && segments.length === 3 && request.method === 'POST') { const input = await body(request); return send(response, 201, await studio.trimClip(input.file, input.start, input.end, String(input.name || '').slice(0, 40))); }
          if (segments[2] === 'items' && segments[4] === 'resume' && request.method === 'POST') return send(response, 202, await studio.resume(segments[3]));
          if (segments[2] === 'items' && segments.length === 4 && request.method === 'DELETE') return send(response, 200, await studio.remove(segments[3]));
          if (segments[2] === 'items' && segments[4] === 'reference' && request.method === 'POST') return send(response, 200, await studio.referenceFromItem(segments[3]));
          if (segments[2] === 'canvases' && segments.length === 3 && request.method === 'GET') return send(response, 200, studio.listCanvases());
          if (segments[2] === 'canvases' && segments.length === 3 && request.method === 'POST') return send(response, 201, await studio.createCanvas(await body(request)));
          if (segments[2] === 'canvases' && segments.length === 4) {
            if (request.method === 'GET') return send(response, 200, studio.canvas(segments[3]));
            if (request.method === 'PATCH') return send(response, 200, await studio.updateCanvas(segments[3], await body(request)));
            if (request.method === 'DELETE') return send(response, 200, await studio.removeCanvas(segments[3]));
          }
        }
        if (url.pathname === '/api/concurrency' && request.method === 'GET') return send(response, 200, workflow.concurrency());
        if (url.pathname === '/api/concurrency' && request.method === 'POST') {
          workflow.setConcurrency(await concurrency.save(await body(request)));
          return send(response, 200, workflow.concurrency());
        }
        if (url.pathname === '/api/prompts' && request.method === 'GET') return send(response, 200, prompts.view());
        if (url.pathname === '/api/prompts' && request.method === 'POST') return send(response, 200, await prompts.save(await body(request)));
        if (url.pathname === '/api/projects' && request.method === 'GET') return send(response, 200, store.list());
        if (url.pathname === '/api/projects/export' && request.method === 'GET') {
          // 先核对项目和大小，确认能导出再开始回传。
          const plan = await exportPlan(store, (url.searchParams.get('ids') || '').split(',').filter(Boolean), workflow);
          const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
          const name = `镜序-${plan.length === 1 ? plan[0].project.title.replace(/[\\/:*?"<>|\r\n]/g, '').slice(0, 40) || '剧本' : `${plan.length}个剧本`}-${stamp}.zip`;
          response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="jingxu-export-${stamp}.zip"; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          await writeExport(plan, chunk => new Promise((done, failed) => { if (response.destroyed) return failed(new Error('下载已取消')); response.write(chunk) ? done() : response.once('drain', done); }));
          return response.end();
        }
        if (url.pathname === '/api/projects/import' && request.method === 'POST') {
          if (!request.headers['content-type']?.startsWith('application/zip')) return send(response, 415, { error: '请选择镜序导出的 ZIP 文件' });
          const temporary = join(tmpdir(), `jingxu-import-${randomBytes(8).toString('hex')}.zip`);
          try {
            let size = 0;
            // 不用 pipeline：它结束时会连同请求的连接一起销毁，回应就发不出去了。
            const file = createWriteStream(temporary, { mode: 0o600 });
            try {
              for await (const chunk of request) { size += chunk.length; if (size > 4 * 1024 * 1024 * 1024) throw Object.assign(new Error('压缩包超过 4GB，请分几次导入'), { status: 413 }); if (!file.write(chunk)) await once(file, 'drain'); }
            } finally { await new Promise(done => file.end(done)); }
            const imported = await importProjects(store, workflow, temporary, { videoProviderId: config.fydmai.id || '', hasAudio: id => voiceStore.data.history.some(item => item.id === id) });
            return send(response, 201, { imported, projects: store.list() });
          } finally { await rm(temporary, { force: true }); }
        }
        if (url.pathname === '/api/projects/batch-delete' && request.method === 'POST') {
          const deleted = await workflow.deleteProjects((await body(request)).ids);
          return send(response, 200, { deleted });
        }
        if (url.pathname === '/api/projects' && request.method === 'POST') {
          const input = await body(request); workflow.validateSettings(input);
          if (typeof input.script === 'string' && input.script.length > 100000) throw new Error('单个项目支持10万字以内的剧本，请按集拆分');
          const profile = workflow.videoProfile();
          return send(response, 201, workflow.view(await store.create({ ...input, videoProviderId: input.videoProviderId || config.fydmai.id, clipDuration: input.clipDuration ?? profile.defaultDuration, resolution: input.resolution ?? profile.defaultResolution })));
        }
        if (url.pathname === '/api/provider-profiles' && request.method === 'GET') return send(response,200,providers.view());
        if (url.pathname === '/api/provider-profiles/remove' && request.method === 'POST') { await providers.remove((await body(request)).ids); capabilities = null; return send(response, 200, providers.view()); }
        const providerTest = url.pathname.match(/^\/api\/provider-profiles\/([^/]+)\/test$/);
        if (providerTest && request.method === 'POST') return send(response, 200, await testProvider(providers.byId(decodeURIComponent(providerTest[1]))));
        if (url.pathname === '/api/settings' && request.method === 'POST') {
          if(busy())throw new Error('有任务运行中，请完成后再切换厂商，避免原任务连接改变');
          const input=await body(request);
          Object.assign(config,await providers.save(input));
          capabilities=null;return send(response,200,settings());
        }
        if(url.pathname==='/api/updates'&&request.method==='GET')return send(response,200,updates.view());
        if(url.pathname==='/api/updates/settings'&&request.method==='POST')return send(response,200,await updates.save(await body(request)));
        if(url.pathname==='/api/updates/check'&&request.method==='POST')return send(response,200,await updates.check());
        if(url.pathname==='/api/updates/install'&&request.method==='POST')return send(response,200,await updates.install());
        if (url.pathname === '/api/capabilities' && request.method === 'GET') {
          capabilities = await refreshCapabilities();
          return send(response, 200, capabilities);
        }
        if (segments[1] === 'projects' && segments[2]) {
          const id = segments[2], project = store.get(id);
          if (segments.length === 3 && request.method === 'GET') return send(response, 200, workflow.view(project));
            if (segments.length === 3 && request.method === 'DELETE') { await workflow.deleteProject(id); return send(response, 200, { deleted: id }); }
          if (segments.length === 3 && request.method === 'PATCH') return send(response, 200, await workflow.updateProject(id, await body(request)));
          if (segments[3] === 'prepare' && request.method === 'POST') return send(response, 202, await workflow.startPreparation(id));
          if (segments[3] === 'generate-assets' && request.method === 'POST') return send(response, 202, await workflow.startAssetGeneration(id, (await body(request)).assetIds));
          if (segments[3] === 'reparse-storyboards' && request.method === 'POST') return send(response, 202, await workflow.reparseStoryboards(id, await body(request)));
          if (segments[3] === 'merge' && request.method === 'POST') return send(response, 202, await workflow.startMerge(id));
          if (segments[3] === 'align-following' && request.method === 'POST') return send(response,202,await workflow.alignFollowing(id));
          if (segments[3] === 'duplicate' && request.method === 'POST') {
            const input = await body(request);
            let clipDuration = project.clipDuration, resolution = project.resolution;
            try { workflow.validateSettings({ clipDuration, resolution }); }
            catch { clipDuration = workflow.videoProfile().defaultDuration; resolution = workflow.videoProfile().defaultResolution; }
            return send(response, 201, workflow.view(await store.create({ title: input.title || `${project.title} · 新版本`, script: project.script,
              style: project.style, aspectRatio: project.aspectRatio, ruleNotes: project.ruleNotes,
              clipDuration, resolution: resolution || workflow.videoProfile().defaultResolution,
              characterPencil: project.characterPencil === true, autoVoice: project.autoVoice === true, videoProviderId: project.videoProviderId || config.fydmai.id, autoRetryVideo: project.autoRetryVideo === true, skipReview: input.skipReview === true })));
          }
          if (segments[3] === 'assets' && segments[4]) {
            const assetId = segments[4];
            if (segments.length === 5 && request.method === 'PATCH') return send(response, 200, await workflow.editAsset(id, assetId, await body(request)));
            if (segments[5] === 'generate' && request.method === 'POST') return send(response, 202, await workflow.regenerateAsset(id, assetId, await body(request)));
            if (segments[5] === 'select-image' && request.method === 'POST') return send(response, 200, await workflow.selectAssetImage(id, assetId, (await body(request)).file));
            if (segments[5] === 'image' && request.method === 'POST') {
              const input = await body(request); const bytes = Buffer.from(String(input.base64 || ''), 'base64');
              const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
              const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
              const webp = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
              if (!png && !jpeg && !webp) throw new Error('请选择有效的PNG、JPEG或WebP图片');
              return send(response, 200, await workflow.replaceAsset(id, assetId, bytes, png ? 'png' : jpeg ? 'jpg' : 'webp'));
            }
          }
          if (segments[3] === 'shots' && segments[4] === 'generate-prompts' && request.method === 'POST') return send(response, 202, await workflow.generateShotPrompts(id, (await body(request)).shotIds));
          if (segments[3] === 'shots' && segments[4]) {
            if (segments.length === 5 && request.method === 'PATCH') return send(response, 200, await workflow.editShot(id, segments[4], await body(request)));
            if (segments[5] === 'resume' && request.method === 'POST') return send(response, 202, await workflow.resumeVideo(id, segments[4]));
            if (segments[5] === 'rebuild' && request.method === 'POST') return send(response, 202, await workflow.rebuildShot(id, segments[4], await body(request)));
            if (segments[5] === 'confirm-continuity' && request.method === 'POST') return send(response,200,await workflow.acceptContinuity(id,segments[4]));
          }
          if (segments[3] === 'review' && request.method === 'POST') return send(response, 200, workflow.review(id, (await body(request)).shotIds));
          if (segments[3] === 'videos' && request.method === 'POST') {
            const input = await body(request);
            if (input.skipReview === true) {
              if (!project.skipReview) throw new Error('跳过人工检查未开启，请先审阅确认');
              const review = workflow.review(id, input.shotIds);
              return send(response, 202, await workflow.startVideos(id, input.shotIds, review.hash, { automatic: true }));
            }
            return send(response, 202, await workflow.startVideos(id, input.shotIds, input.approvedHash));
          }
        }
        return send(response, 404, { error: '接口不存在' });
      }
      if (segments[0] === 'media' && segments.length === 3 && ['GET', 'HEAD'].includes(request.method)) return await streamFile(request, response, store.media(segments[1], segments[2]));
      if (segments[0] === 'studio-media' && segments.length === 2 && ['GET', 'HEAD'].includes(request.method)) return await streamFile(request, response, studio.media(segments[1]));
      if (segments[0] === 'voice-media' && segments.length === 2 && ['GET', 'HEAD'].includes(request.method)) return await streamFile(request, response, voiceStore.file(segments[1]));
      if (!['GET', 'HEAD'].includes(request.method)) return send(response, 405, { error: '不支持的请求方法' });
      const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'app.js', 'model-options.js', 'settings-ui.js', 'image-viewer.js', 'mentions.js', 'studio.js', 'canvas.js', 'backdrop.js', 'style.css'].includes(filename)) return send(response, 404, { error: '页面不存在' });
      return await streamFile(request, response, join(publicRoot, filename));
    } catch (error) {
      if (!response.headersSent) send(response, error.status || (error.code === 'ENOENT' ? 404 : 400), { error: error.code === 'ENOENT' ? '文件不存在' : workflow.errorText(error) });
      else response.destroy();
    }
  });
  server.on('close',()=>{clearInterval(updateTimer);clearInterval(retryUpdateTimer);});
  return { server, store, workflow, token, settings, providers, updates, studio };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 清掉旧版本留下的内置提示词文件；失败不影响启动。
  await removeLegacyPrompts(applicationRoot);
  const port = Number(process.env.WORKFLOW_PORT || 6040);
  const lock = join(applicationRoot, 'data', `server-${port}.lock`);
  await mkdir(join(applicationRoot, 'data'), { recursive: true });
  try {
    await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lock, 'utf8'));
    let running = false;
    if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); running = true; } catch {} }
    if (running) { console.log(`工作台已在运行：http://127.0.0.1:${port}`); process.exit(0); }
    await rm(lock, { force: true });
    await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  const app = await createApplication({restartForUpdate:()=>{
    app.workflow.stopping=true;app.server.close(async()=>{
      await rm(lock,{force:true});
      const child=spawn(process.execPath,['--env-file-if-exists=.env','src/server.js'],{cwd:applicationRoot,detached:true,stdio:'inherit'});child.unref();process.exit(0);
    });
  }});
  setTimeout(()=>app.updates.tick().catch(()=>{}),3000).unref();
  // 电脑上没有 FFmpeg 时在后台自动下载安装，分离音视频、截取音频和整集合成都要用。
  setTimeout(()=>ffmpegTools.ensure().catch(error=>console.log(error.message)),5000).unref();
  app.server.listen(port, '127.0.0.1', () => console.log(`短剧工作台已启动：http://127.0.0.1:${port}`));
  const stop = () => { app.workflow.stopping = true; app.server.close(async () => { await rm(lock, { force: true }); process.exit(0); }); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
