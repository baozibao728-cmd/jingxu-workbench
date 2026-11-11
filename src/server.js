import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, stat, mkdir, rm } from 'node:fs/promises';
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
import { UpdateManager } from './update-manager.js';
import { spawn } from 'node:child_process';

const applicationRoot = fileURLToPath(new URL('..', import.meta.url));
const publicRoot = join(applicationRoot, 'public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.json': 'application/json; charset=utf-8' };

export async function createApplication({ root = join(applicationRoot, 'data', 'projects'), config = readConfig(), seedDemo = true, workflowOptions = {}, persistSettings = true, updateRoot = applicationRoot, restartForUpdate, updateOptions = {} } = {}) {
  const store = new ProjectStore(root); await store.init();
  const providers=new ProviderSettings(join(root,'provider-settings.json'),config);await providers.init();Object.assign(config,providers.config());
  const prompts = new PromptSettings(join(root, 'system-prompts.json')); await prompts.init();
  const concurrency = new ConcurrencySettings(join(root, 'concurrency.json')); await concurrency.init();
  let capabilities = null;
  try { capabilities = JSON.parse(await readFile(join(applicationRoot, 'data', 'integration-test', 'fydmai-capabilities.json'), 'utf8')); } catch {}
  const refreshCapabilities = async () => {
    capabilities = await createProvider('fydmai',config.fydmai).getCapabilities();
    return capabilities;
  };
  const workflow = new Workflow(store, () => config, { getCapabilities: () => capabilities, refreshCapabilities, getPrompts: () => prompts.effective(), getProviderById:id=>providers.byId(id), ...workflowOptions });
  workflow.setConcurrency(concurrency.value);
  if (seedDemo) await importExistingTest(store, workflow, applicationRoot);
  // Bind original paid tasks and preserve unchanged legacy completion checks.
  for(const project of store.projects.values())if(workflow.migrateProviderBindings(project))await store.save(project);
  await workflow.recover();
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
          if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: '请求必须为JSON' });
        }
        if (url.pathname === '/api/bootstrap' && request.method === 'GET') return send(response, 200, { token, settings: settings(), providerProfiles:providers.view(), updates:updates.view(), concurrency: workflow.concurrency(), prompts: prompts.view(), projects: store.list(), capabilities, videoProfile: workflow.videoProfile(), rules: { characterSheet: characterSheetSystemPrompt() } });
        if (url.pathname === '/api/concurrency' && request.method === 'GET') return send(response, 200, workflow.concurrency());
        if (url.pathname === '/api/concurrency' && request.method === 'POST') {
          workflow.setConcurrency(await concurrency.save(await body(request)));
          return send(response, 200, workflow.concurrency());
        }
        if (url.pathname === '/api/prompts' && request.method === 'GET') return send(response, 200, prompts.view());
        if (url.pathname === '/api/prompts' && request.method === 'POST') return send(response, 200, await prompts.save(await body(request)));
        if (url.pathname === '/api/projects' && request.method === 'GET') return send(response, 200, store.list());
        if (url.pathname === '/api/projects' && request.method === 'POST') {
          const input = await body(request); workflow.validateSettings(input);
          if (typeof input.script === 'string' && input.script.length > 100000) throw new Error('单个项目支持10万字以内的剧本，请按集拆分');
          const profile = workflow.videoProfile();
          return send(response, 201, workflow.view(await store.create({ ...input, clipDuration: input.clipDuration ?? profile.defaultDuration, resolution: input.resolution ?? profile.defaultResolution })));
        }
        if (url.pathname === '/api/provider-profiles' && request.method === 'GET') return send(response,200,providers.view());
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
          if (segments.length === 3 && request.method === 'PATCH') return send(response, 200, await workflow.updateProject(id, await body(request)));
          if (segments[3] === 'prepare' && request.method === 'POST') return send(response, 202, await workflow.startPreparation(id));
          if (segments[3] === 'generate-assets' && request.method === 'POST') return send(response, 202, await workflow.startAssetGeneration(id, (await body(request)).assetIds));
          if (segments[3] === 'merge' && request.method === 'POST') return send(response, 202, await workflow.startMerge(id));
          if (segments[3] === 'align-following' && request.method === 'POST') return send(response,202,await workflow.alignFollowing(id));
          if (segments[3] === 'duplicate' && request.method === 'POST') {
            const input = await body(request);
            let clipDuration = project.clipDuration, resolution = project.resolution;
            try { workflow.validateSettings({ clipDuration, resolution }); }
            catch { clipDuration = workflow.videoProfile().defaultDuration; resolution = workflow.videoProfile().defaultResolution; }
            return send(response, 201, workflow.view(await store.create({ title: input.title || `${project.title} · 新版本`, script: project.script,
              style: project.style, aspectRatio: project.aspectRatio, ruleNotes: project.ruleNotes,
              clipDuration, resolution: resolution || workflow.videoProfile().defaultResolution, skipReview: input.skipReview === true })));
          }
          if (segments[3] === 'assets' && segments[4]) {
            const assetId = segments[4];
            if (segments.length === 5 && request.method === 'PATCH') return send(response, 200, await workflow.editAsset(id, assetId, await body(request)));
            if (segments[5] === 'generate' && request.method === 'POST') return send(response, 202, await workflow.regenerateAsset(id, assetId, await body(request)));
            if (segments[5] === 'image' && request.method === 'POST') {
              const input = await body(request); const bytes = Buffer.from(String(input.base64 || ''), 'base64');
              const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
              const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
              const webp = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
              if (!png && !jpeg && !webp) throw new Error('请选择有效的PNG、JPEG或WebP图片');
              return send(response, 200, await workflow.replaceAsset(id, assetId, bytes, png ? 'png' : jpeg ? 'jpg' : 'webp'));
            }
          }
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
      if (!['GET', 'HEAD'].includes(request.method)) return send(response, 405, { error: '不支持的请求方法' });
      const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'app.js', 'settings-ui.js', 'image-viewer.js', 'mentions.js', 'style.css'].includes(filename)) return send(response, 404, { error: '页面不存在' });
      return await streamFile(request, response, join(publicRoot, filename));
    } catch (error) {
      if (!response.headersSent) send(response, error.status || (error.code === 'ENOENT' ? 404 : 400), { error: error.code === 'ENOENT' ? '文件不存在' : workflow.errorText(error) });
      else response.destroy();
    }
  });
  server.on('close',()=>{clearInterval(updateTimer);clearInterval(retryUpdateTimer);});
  return { server, store, workflow, token, settings, providers, updates };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
  app.server.listen(port, '127.0.0.1', () => console.log(`短剧工作台已启动：http://127.0.0.1:${port}`));
  const stop = () => { app.workflow.stopping = true; app.server.close(async () => { await rm(lock, { force: true }); process.exit(0); }); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
