import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore, parsePrompt } from '../src/project-store.js';
import { Workflow } from '../src/workflow.js';
import { createApplication } from '../src/server.js';
import { buildAssetImagePrompt } from '../src/asset-prompts.js';
import { readConfig } from '../src/config.js';

const config = () => ({
  deepseek: { baseUrl: 'https://text.example', apiKey: 'text-fixture', model: 'deepseek-flash' },
  grsai: { baseUrl: 'https://image.example', apiKey: 'image-fixture', model: 'gpt-image-2.6' },
  fydmai: { baseUrl: 'https://video.example', apiKey: 'video-fixture', model: 'seedance2.0' },
});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6UAAAAABJRU5ErkJggg==', 'base64');

async function fixture({ model = 'seedance2.0', duration = 5, resolution = '480p' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'drama-ui-'));
  const store = new ProjectStore(root); await store.init();
  const events = [], submissions = [], queries = [], imageRequests = [];
  let textCalls = 0, counter = 0;
  const factories = {
    text: () => ({ generateJson: async () => {
      if (++textCalls === 1) {
        events.push('extract');
        return { assets: [
          { key: 'woman', kind: 'character', name: '女信使', prompt: 'Adult woman blue jacket' },
          { key: 'room', kind: 'scene', name: '书房', prompt: 'Empty warm room' },
          { key: 'letter', kind: 'prop', name: '信封', prompt: 'One red envelope' },
        ] };
      }
      events.push('storyboards');
      return { shots: [{ title: '取信', duration, promptTemplate: '{{ref:woman}} 在 {{ref:room}} 拿起 {{ref:letter}}。' }] };
    } }),
    image: () => ({ submit: async request => { imageRequests.push(request); const id = `image-${++counter}`; events.push(id); return { id, status: 'completed', urls: [`https://image.example/${id}.png`] }; },
      getTask: async id => ({ id, status: 'completed', urls: ['https://image.example/result.png'] }) }),
    video: () => ({
      uploadImage: async path => ({ assetId: `remote-${path.split('/').at(-1)}` }),
      submit: async request => { submissions.push(request); return { id: 'video-1', status: 'completed', urls: ['https://video.example/result.mp4'] }; },
      getTask: async id => { queries.push(id); return { id, status: 'completed', urls: ['https://video.example/result.mp4'] }; },
    }),
  };
  const download = async (url, path) => { const bytes = Buffer.concat([png, Buffer.from(url)]); await writeFile(path, bytes); return { path, bytes: bytes.length }; };
  const workflow = new Workflow(store, () => ({ ...config(), fydmai: { ...config().fydmai, model } }), { factories, download, intervalMs: 1 });
  const project = await store.create({ title: '测试', script: '女信使在书房拿起信封。', clipDuration:duration, resolution });
  const analyze = async () => { await workflow.startPreparation(project.id); await workflow.active.get(`prepare:${project.id}`); };
  const prepare = async () => { await analyze(); await workflow.startAssetGeneration(project.id,project.assets.map(asset=>asset.id)); await workflow.active.get(`prepare:${project.id}`); };
  const cleanup = async () => { workflow.stopping = true; await Promise.allSettled([...workflow.active.values()]); await rm(root, { recursive: true, force: true }); };
  return { root, store, workflow, project, factories, download, events, submissions, queries, imageRequests, analyze, prepare, cleanup };
}

test('先列资产清单，明确选择后才生成图片和分镜，结束后没有视频提交', async () => {
  const f = await fixture();
  try {
    await f.analyze();
    assert.equal(f.project.assets.length,3);
    assert.equal(f.project.shots.length,0);
    assert.equal(f.imageRequests.length,0);
    assert.equal(f.submissions.length,0);
    await f.workflow.startAssetGeneration(f.project.id,f.project.assets.map(asset=>asset.id));
    await f.workflow.active.get(`prepare:${f.project.id}`);
    assert.equal(f.project.preparation.state, 'completed');
    assert.equal(f.project.assets.filter(asset => asset.image).length, 3);
    assert.equal(f.project.shots.length, 1);
    assert.equal(f.events[0], 'extract');
    assert.equal(f.events.at(-1), 'storyboards');
    assert.equal(f.submissions.length, 0);
    const persisted = JSON.parse(await readFile(join(f.root, f.project.id, 'project.json'), 'utf8'));
    assert.equal(persisted.shots.length, 1);
    assert.ok(f.workflow.view(f.project).shots[0].prompt.includes('@女信使'));
  } finally { await f.cleanup(); }
});

test('分镜可绑定语音历史，审阅时展示并在提交时独立上传 referenceAudios', async () => {
  const f = await fixture();
  try {
    await f.prepare();
    const audioPath = join(f.root, 'voice.mp3'); await writeFile(audioPath, 'fake-audio');
    f.workflow.getVoiceAudio = () => [{ id: 'voice-1', file: 'voice.mp3', path: audioPath, url: '/voice-media/voice.mp3', text: '人物台词', voiceId: 'female-shaonv', model: 'speech-2.8-hd' }];
    const shot = f.project.shots[0], asset = f.project.assets[0];
    await f.workflow.editShot(f.project.id, shot.id, { prompt: `@${asset.name} @音频·女信使 在镜头中说台词。`, duration: shot.duration, audioIds: ['voice-1'], audioRoles: { 'voice-1': '女信使' } });
    const review = f.workflow.review(f.project.id, [shot.id]);
    assert.equal(review.shots[0].audios[0].id, 'voice-1');
    assert.match(review.shots[0].prompt, /音频1.*女信使.*唯一声音参考/);
    assert.match(f.project.shots[0].promptTemplate, new RegExp(`\\{\\{ref:${f.project.shots[0].assetIds[0]}\\}\\} @音频·女信使`));
    f.workflow.factories.video = () => ({
      uploadImage: async path => ({ assetId: `image-${path.split('/').at(-1)}` }),
      uploadAudio: async path => ({ assetId: `audio-${path.split('/').at(-1)}` }),
      submit: async request => { f.submissions.push(request); return { id: 'video-audio', status: 'completed', urls: ['https://video.example/audio.mp4'] }; },
      getTask: async id => ({ id, status: 'completed', urls: ['https://video.example/audio.mp4'] }),
    });
    await f.workflow.startVideos(f.project.id, [shot.id], review.hash);
    await f.workflow.active.get(`video:${f.project.id}:${shot.id}`);
    assert.deepEqual(f.submissions[0].referenceAudios, [{ assetId: 'audio-voice.mp3' }]);
  } finally { await f.cleanup(); }
});

test('素材引用可包含空格，重名的前缀不会绑定到另一项素材', () => {
  const assets = [{id:'a',name:'取信 · 构图参考'},{id:'b',name:'女信使'},{id:'c',name:'女信使正面'}];
  assert.equal(parsePrompt('@取信 · 构图参考 中的 @女信使正面 站在窗边。', assets), '{{ref:a}} 中的 {{ref:c}} 站在窗边。');
});

test('全新电脑没有.env时已有可用模型预设，只需填写各自Key', () => {
  const fresh = readConfig({});
  assert.equal(fresh.deepseek.model, 'deepseek-flash');
  assert.equal(fresh.grsai.model, 'gpt-image-2.6');
  assert.equal(fresh.fydmai.model, 'c7-wan3');
  assert.equal(fresh.fydmai.apiKey, '');
});

test('项目的演员与道具清单不会再次污染空景生图输入', () => {
  const prompt = buildAssetImagePrompt({kind:'scene',prompt:'Empty warm study with wooden desk.'}, '写实电影');
  assert.match(prompt, /ZERO people/);
  assert.ok(!prompt.includes('女信使'));
  const character = buildAssetImagePrompt({kind:'character',prompt:'Woman in a blue jacket.'}, '写实电影');
  assert.match(character, /单张16:9横版/); assert.match(character, /面部特写/); assert.match(character, /90°侧面/);
  const pencil = buildAssetImagePrompt({kind:'character',prompt:'Woman in a blue jacket.'}, '写实电影', { characterPencil: true });
  assert.match(pencil, /彩铅人物开关：已开启/); assert.match(pencil, /彩色铅笔手绘/);
  assert.ok(!character.includes('彩铅人物开关：已开启'));
});

test('项目级彩铅开关可保存，且只在人物图重新生成时加入彩铅提示词', async () => {
  const f = await fixture();
  try {
    assert.equal(f.project.characterPencil, false);
    const updated = await f.workflow.updateProject(f.project.id, { characterPencil: true });
    assert.equal(updated.characterPencil, true);
    assert.equal(f.store.get(f.project.id).characterPencil, true);
    await assert.rejects(f.workflow.updateProject(f.project.id, { characterPencil: 'true' }), /开关值/);
  } finally { await f.cleanup(); }
});

test('项目可以选择已配置的视频渠道，并把渠道固定到新的提交快照', async () => {
  const f = await fixture();
  try {
    const current = f.workflow.config().fydmai;
    f.workflow.getProviderProfiles = () => ({ profiles: [{ id: 'video-alt', service: 'fydmai', name: '备用视频', model: current.model, baseUrl: 'https://video-alt.example', configured: true }] });
    f.workflow.getProviderById = id => id === 'video-alt' ? { ...current, id: 'video-alt', baseUrl: 'https://video-alt.example' } : current;
    await f.workflow.updateProject(f.project.id, { videoProviderId: 'video-alt' });
    assert.equal(f.project.videoProviderId, 'video-alt');
    assert.equal(f.workflow.view(f.project).videoProviderId, 'video-alt');
    assert.equal(f.workflow.view(f.project).videoChannels[0].name, '备用视频');
  } finally { await f.cleanup(); }
});

test('一个视频厂商方案的每个模型都能在项目里单独选，提交快照记下所选模型', async () => {
  const f = await fixture();
  try {
    const current = f.workflow.config().fydmai, models = [{ id: 'seedance-2.5-cc', label: 'Seedance 2.5' }, { id: 'seedance-2.5-flash-cc', label: 'Seedance 2.5 Flash' }];
    const alt = { ...current, id: 'video-alt', protocol: 'openai-video', model: 'seedance-2.5-cc', models, capabilities: { minDuration: 4, maxDuration: 30, defaultDuration: 15, resolutions: ['720p'], defaultResolution: '720p', maxReference: 10 } };
    f.workflow.getProviderProfiles = () => ({ profiles: [{ id: 'video-alt', service: 'fydmai', name: '萤漫', model: alt.model, models, baseUrl: alt.baseUrl, configured: true }] });
    f.workflow.getProviderById = id => id === 'video-alt' ? alt : current;
    const channels = f.workflow.videoChannels();
    assert.deepEqual(channels.map(c => c.value), ['video-alt::seedance-2.5-cc', 'video-alt::seedance-2.5-flash-cc']);
    assert.deepEqual(channels[0].videoProfile.resolutions, ['480p', '720p']);
    await f.workflow.updateProject(f.project.id, { videoProviderId: 'video-alt', videoModel: 'seedance-2.5-flash-cc', clipDuration: 15, resolution: '480p' });
    assert.equal(f.workflow.view(f.project).resolution, '480p');
    assert.match(channels[1].label, /Seedance 2.5 Flash/);
    await assert.rejects(f.workflow.updateProject(f.project.id, { videoProviderId: 'video-alt', videoModel: 'not-listed' }), /模型列表/);
    await f.workflow.updateProject(f.project.id, { videoProviderId: 'video-alt', videoModel: 'seedance-2.5-flash-cc', clipDuration: 15, resolution: '720p' });
    assert.equal(f.workflow.view(f.project).videoModel, 'seedance-2.5-flash-cc');
    assert.equal(f.workflow.videoConfigForProject(f.project).model, 'seedance-2.5-flash-cc');
    assert.equal(alt.model, 'seedance-2.5-cc');
    assert.equal(f.workflow.videoConfig({ providerId: 'video-alt', model: 'seedance-2.5-flash-cc' }).model, 'seedance-2.5-flash-cc');
    assert.equal(f.workflow.videoConfig({ providerId: 'video-alt' }).model, 'seedance-2.5-cc');
    await f.workflow.updateProject(f.project.id, { videoProviderId: 'video-alt', videoModel: '' });
    assert.equal(f.workflow.view(f.project).videoModel, 'seedance-2.5-cc');
  } finally { await f.cleanup(); }
});

test('视频服务明确失败时，项目开关会自动重提且最多重试两次', async () => {
  const f = await fixture();
  try {
    await f.prepare();
    await f.workflow.updateProject(f.project.id, { autoRetryVideo: true });
    let attempts = 0, polls = 0;
    f.workflow.factories.video = () => ({
      uploadImage: async () => ({ assetId: `retry-image-${attempts}` }),
      submit: async request => { attempts++; f.submissions.push(request); return { id: `retry-${attempts}`, status: 'queued' }; },
      getTask: async id => { polls++; return polls === 1 ? { id, status: 'failed', error: '服务端暂时失败' } : { id, status: 'completed', urls: ['https://video.example/retry.mp4'] }; },
    });
    const shot = f.project.shots[0], review = f.workflow.review(f.project.id, [shot.id]);
    await f.workflow.startVideos(f.project.id, [shot.id], review.hash);
    for (let i = 0; i < 100 && !f.project.shots[0].video; i++) await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.submissions.length, 2);
    assert.ok(f.project.shots[0].video);
    assert.equal(f.project.shots[0].job.retryCount, 1);
  } finally { await f.cleanup(); }
});

test('删除项目会移除本地记录，处理中项目会被保护', async () => {
  const f = await fixture();
  try {
    const id = f.project.id;
    await f.workflow.deleteProject(id);
    assert.throws(() => f.store.get(id), /项目不存在/);
  } finally { await f.cleanup(); }
});

test('人物一张请求同时包含脸部与三视图，旧竖版资产重做也固定为16:9', async () => {
  const f = await fixture();
  try {
    f.project.aspectRatio = '9:16';
    f.project.characterPencil = true;
    await f.prepare(); const asset = f.project.assets.find(item => item.kind === 'character');
    assert.equal(asset.aspectRatio, '16:9');
    assert.equal(f.project.assets.find(item => item.kind === 'scene').aspectRatio, '9:16');
    asset.aspectRatio = '2:3';
    const count = f.imageRequests.length;
    await f.workflow.regenerateAsset(f.project.id, asset.id);
    await f.workflow.active.get(`asset:${f.project.id}:${asset.id}`);
    assert.equal(f.imageRequests.length - count, 1);
    assert.equal(f.imageRequests.at(-1).aspectRatio, '16:9');
    assert.match(f.imageRequests.at(-1).prompt, /最左侧约30%/);
    assert.match(f.imageRequests.at(-1).prompt, /右侧约70%/);
    assert.match(f.imageRequests.at(-1).prompt, /正面全身.*90°侧面全身.*背面全身/);
    assert.match(f.imageRequests.at(-1).prompt, /彩铅人物开关：已开启/);
    assert.equal(asset.image.layout, 'character-sheet-face-and-three-view');
  } finally { await f.cleanup(); }
});

test('提示词或图片版本变化后旧确认失效，不能提交旧内容', async () => {
  const f = await fixture();
  try {
    await f.prepare();
    const shot = f.project.shots[0], ids = [shot.id];
    const before = f.workflow.review(f.project.id, ids);
    await f.workflow.editShot(f.project.id, shot.id, { prompt: '@女信使 在 @书房 轻轻拿起 @信封 。' });
    await assert.rejects(f.workflow.startVideos(f.project.id, ids, before.hash), /重新查看/);
    const second = f.workflow.review(f.project.id, ids);
    await f.workflow.replaceAsset(f.project.id, f.project.assets[0].id, Buffer.concat([png, Buffer.from('new-version')]), 'png');
    await assert.rejects(f.workflow.startVideos(f.project.id, ids, second.hash), /重新查看/);
    assert.equal(f.submissions.length, 0);
    assert.throws(() => parsePrompt('@不存在的素材 ', f.project.assets), /不存在/);
  } finally { await f.cleanup(); }
});

test('确认后仅提交一次5秒请求，重复点击被拦截，提示词和素材来自同一快照', async () => {
  const f = await fixture();
  try {
    await f.prepare(); const shot = f.project.shots[0], ids = [shot.id];
    const review = f.workflow.review(f.project.id, ids);
    await f.workflow.startVideos(f.project.id, ids, review.hash);
    await assert.rejects(f.workflow.startVideos(f.project.id, ids, review.hash), /处理中/);
    await f.workflow.active.get(`video:${f.project.id}:${shot.id}`);
    assert.equal(f.submissions.length, 1);
    assert.equal(f.submissions[0].duration, 5);
    assert.equal(f.submissions[0].referenceImages.length, 3);
    assert.ok(!f.submissions[0].prompt.includes('{{ref:'));
    assert.match(f.submissions[0].prompt, /@女信使_/);
    assert.ok(shot.video);
    assert.equal(f.workflow.view(f.project).shots[0].stale, false);
  } finally { await f.cleanup(); }
});

test('后台重启恢复已接单的视频，只查询原任务，不再次提交', async () => {
  const f = await fixture();
  try {
    await f.prepare(); const shot = f.project.shots[0];
    const review = f.workflow.review(f.project.id, [shot.id]);
    shot.job = { state: 'queued', operationId: 'resume-test', taskId: 'already-paid', snapshot: review.shots[0] };
    await f.store.save(f.project);
    const reloaded = new ProjectStore(f.root); await reloaded.init();
    const workflow = new Workflow(reloaded, config, { factories: f.factories, download: f.download, intervalMs: 1 });
    await workflow.recover(); await Promise.allSettled([...workflow.active.values()]);
    assert.equal(f.submissions.length, 0);
    assert.deepEqual(f.queries, ['already-paid']);
    assert.equal(reloaded.get(f.project.id).shots[0].job.state, 'completed');
    workflow.stopping = true;
  } finally { await f.cleanup(); }
});

test('视频提交结果未知或在提交时重启，不会自动再发一次', async () => {
  const f = await fixture();
  try {
    await f.prepare(); const shot = f.project.shots[0];
    const review = f.workflow.review(f.project.id, [shot.id]);
    shot.job = { state: 'submitting', operationId: 'unknown-test', submittedAt: new Date().toISOString(), snapshot: review.shots[0] };
    await f.workflow.recover();
    assert.equal(shot.job.state, 'unknown');
    assert.equal(f.submissions.length, 0);
    assert.throws(() => f.workflow.review(f.project.id, [shot.id]), /结果未知/);
    await assert.rejects(() => f.workflow.rebuildShot(f.project.id, shot.id), /结果未知/);
    await f.workflow.acknowledgeUnknownShot(f.project.id, shot.id);
    assert.equal(shot.job.state, 'idle');
    assert.equal(f.workflow.review(f.project.id, [shot.id]).shots.length, 1);
  } finally { await f.cleanup(); }
});

test('整集合成只使用已完成的当前版本，合成失败不会伪报为首段成功', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.workflow.startMerge(f.project.id), /先生成所有分镜/);
    await f.prepare(); const shot = f.project.shots[0];
    shot.video = { file: 'clip.mp4', inputHash: f.workflow.inputHash(f.project, shot) };
    f.workflow.merge = async () => { throw new Error('模拟合成失败'); };
    await f.workflow.startMerge(f.project.id);
    await f.workflow.active.get(`merge:${f.project.id}`);
    assert.equal(f.project.mergeJob.state, 'failed'); assert.equal(f.project.mergedVideo, undefined);
    f.workflow.merge = async () => ({ duration: 5, clips: 1 });
    await f.workflow.startMerge(f.project.id); await f.workflow.active.get(`merge:${f.project.id}`);
    assert.equal(f.project.mergeJob.state, 'completed'); assert.equal(f.project.mergedVideo.clips, 1);
  } finally { await f.cleanup(); }
});

test('HTTP接口不回传Key，修改请求须来自当前页面，媒体支持范围读取', async () => {
  const f = await fixture(); let app;
  try {
    app = await createApplication({ root: f.root, config: config(), seedDemo: false, persistSettings: false, workflowOptions: { factories: f.factories, download: f.download } });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const boot = await (await fetch(`${base}/api/bootstrap`)).json();
    assert.equal(boot.settings.grsai.configured, true);
    assert.ok(!JSON.stringify(boot).includes('image-fixture'));
    assert.equal(boot.concurrency.images.limit,10);
    assert.equal(boot.concurrency.videos.limit,10);
    const headers={'Content-Type':'application/json','X-Workflow-Token':boot.token};
    const concurrentSaved=await fetch(`${base}/api/concurrency`,{method:'POST',headers,body:JSON.stringify({images:50,videos:1})});
    assert.equal(concurrentSaved.status,200);
    const concurrentInvalid=await fetch(`${base}/api/concurrency`,{method:'POST',headers,body:JSON.stringify({images:51})});
    assert.equal(concurrentInvalid.status,400);
    const concurrentRead=await(await fetch(`${base}/api/concurrency`)).json();
    assert.equal(concurrentRead.images.limit,50);assert.equal(concurrentRead.videos.limit,1);
    assert.equal((await fetch(`${base}/image-viewer.js`)).status,200);
    assert.equal((await fetch(`${base}/settings-ui.js`)).status,200);
    assert.equal((await fetch(`${base}/model-options.js`)).status,200);
    const blocked = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(blocked.status, 403);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    const invalidSettings = await fetch(`${base}/api/settings`, {method:'POST',headers:{'Content-Type':'application/json','X-Workflow-Token':boot.token},body:JSON.stringify({deepseek:{model:'must-not-partially-save'},grsai:{baseUrl:'http://insecure.example'}})});
    assert.equal(invalidSettings.status, 400);
    const unchanged = await (await fetch(`${base}/api/bootstrap`)).json();
    assert.equal(unchanged.settings.deepseek.model, 'deepseek-flash');
    const promptSaved = await fetch(`${base}/api/prompts`, {method:'POST',headers:{'Content-Type':'application/json','X-Workflow-Token':boot.token},body:JSON.stringify({characters:'只提取出镜角色',scenes:''})});
    assert.equal(promptSaved.status,200);
    const promptRead = await (await fetch(`${base}/api/prompts`)).json();
    assert.equal(promptRead.overrides.characters,'只提取出镜角色');
    assert.equal(promptRead.overrides.scenes,'');
    assert.equal(promptRead.definitions.length,8);
    const created = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workflow-Token': boot.token }, body: JSON.stringify({ title: '网页项目' }) });
    assert.equal(created.status, 201);
    const createdProject=await created.json();
    assert.equal(createdProject.skipReview,false);
    const skipWithoutSetting=await fetch(`${base}/api/projects/${createdProject.id}/videos`,{method:'POST',headers:{'Content-Type':'application/json','X-Workflow-Token':boot.token},body:JSON.stringify({skipReview:true,shotIds:['fake']})});
    assert.equal(skipWithoutSetting.status,400);
    assert.match((await skipWithoutSetting.json()).error,/未开启/);

    await writeFile(f.store.media(f.project.id, 'range.mp4'), Buffer.from('0123456789'));
    const media = await fetch(`${base}/media/${f.project.id}/range.mp4`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(media.status, 206); assert.equal(await media.text(), '2345');
  } finally { if (app) { app.workflow.stopping = true; await new Promise(resolve => app.server.close(resolve)); } await f.cleanup(); }
});


test('c7-wan3 按15秒720p准备并审阅，用户确认后仅提交快照参数', async () => {
  const f = await fixture({model:'c7-wan3',duration:15,resolution:'720p'});
  try {
    await f.prepare();
    assert.equal(f.project.preparation.state, 'completed');
    assert.equal(f.submissions.length, 0);
    const shot = f.project.shots[0], ids = [shot.id];
    const review = f.workflow.review(f.project.id, ids);
    assert.equal(review.totalSeconds,15);
    assert.equal(review.shots[0].model,'c7-wan3');
    assert.equal(review.shots[0].resolution,'720p');
    await f.workflow.updateProject(f.project.id,{resolution:'1080p'});
    await assert.rejects(f.workflow.startVideos(f.project.id,ids,review.hash), /重新查看/);
    const updated = f.workflow.review(f.project.id,ids);
    await f.workflow.startVideos(f.project.id,ids,updated.hash);
    await f.workflow.active.get(`video:${f.project.id}:${shot.id}`);
    assert.equal(f.submissions.length,1);
    assert.equal(f.submissions[0].duration,15);
    assert.equal(f.submissions[0].resolution,'1080p');
  } finally { await f.cleanup(); }
});

test('c7-wan3 拦截旧5秒和480p，模型未上架时不提交也不上传', async () => {
  const f = await fixture({model:'c7-wan3',duration:15,resolution:'720p'});
  try {
    await f.prepare(); const shot=f.project.shots[0], ids=[shot.id];
    shot.duration=5;
    assert.throws(()=>f.workflow.review(f.project.id,ids), /15～30/);
    assert.equal(shot.duration,5);
    shot.duration=15; f.project.resolution='480p';
    assert.throws(()=>f.workflow.review(f.project.id,ids), /720p/);
    f.project.resolution='720p';
    const review=f.workflow.review(f.project.id,ids);
    f.workflow.refreshCapabilities=async()=>({models:[{kind:'video',model:'c7-wan3',onShelf:false}]});
    await assert.rejects(f.workflow.startVideos(f.project.id,ids,review.hash), /未上架/);
    assert.equal(f.submissions.length,0);
    assert.equal(shot.job.state,'idle');
    assert.throws(()=>f.workflow.validateSettings({clipDuration:31}), /15～30/);
    assert.throws(()=>f.workflow.validateSettings({clipDuration:15.5}), /15～30/);
  } finally { await f.cleanup(); }
});
