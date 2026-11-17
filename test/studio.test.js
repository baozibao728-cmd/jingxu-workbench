import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectStore } from '../src/project-store.js';
import { Workflow } from '../src/workflow.js';
import { Studio, compileMentions, pixelSize } from '../src/studio.js';
import { createApplication } from '../src/server.js';

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('fake-png')]);
const config = () => ({ deepseek: { apiKey: 'fake-text', baseUrl: 'https://text.example', model: 'mock' }, grsai: { id: 'i1', name: '生图', apiKey: 'fake-image', baseUrl: 'https://image.example', model: 'gpt-image-2' }, fydmai: { id: 'v1', name: '视频', apiKey: 'fake-video', baseUrl: 'https://video.example', model: 'c7-wan3' } });

async function setup(factories, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-'));
  const store = new ProjectStore(root); await store.init();
  const workflow = new Workflow(store, config, { factories, intervalMs: 1, download: async (url, destination) => { await writeFile(destination, `downloaded:${url}`); }, ...options });
  const studio = new Studio(root, workflow); await studio.init();
  return { root, store, workflow, studio, done: async () => { await Promise.allSettled([...workflow.active.values()]); }, close: () => rm(root, { recursive: true, force: true }) };
}

test('提示词里的 @图N 按参考图顺序替换，引用了不存在的图会报错', () => {
  assert.equal(compileMentions('@图1 走向 @图2，镜头推进', 2, index => `<${index}> `), '<1> 走向 <2> ，镜头推进');
  assert.equal(compileMentions('@图10 @图1', 10, index => `[${index}]`), '[10][1]');
  assert.throws(() => compileMentions('看 @图3', 2, index => String(index)), /@图3 没有对应的参考图/);
  assert.equal(pixelSize('720p', '9:16'), '720x1280');
  assert.equal(pixelSize('1080p', '16:9'), '1920x1080');
  assert.equal(pixelSize('720p', '1:1'), '720x720');
});

test('自由创作生成视频：上传参考图、替换引用、提交一次并下载成片', async () => {
  const submitted = [], uploaded = [];
  let polls = 0;
  const context = await setup({ video: () => ({
    uploadImage: async path => { uploaded.push(path); return { assetId: `remote-${uploaded.length}` }; },
    submit: async input => { submitted.push(input); return { id: 'task-1', status: 'queued', progress: 0, urls: [] }; },
    getTask: async () => ++polls < 2 ? { id: 'task-1', status: 'running', progress: 40, urls: [] } : { id: 'task-1', status: 'completed', progress: 100, urls: ['https://cdn.example/a.mp4'] },
  }) });
  try {
    const { studio } = context;
    const first = await studio.addReference(PNG, '人物.png'), second = await studio.addReference(PNG, '场景.png');
    const channel = studio.view().channels[0];
    assert.equal(channel.value, 'v1::c7-wan3');
    await assert.rejects(studio.create({ kind: 'video', prompt: '测试', channel: channel.value, duration: 5, resolution: '720p' }), /15～30 秒/);
    await assert.rejects(studio.create({ kind: 'video', prompt: '看 @图3', refIds: [first.id], channel: channel.value, duration: 15, resolution: '720p' }), /@图3/);
    assert.equal(studio.view().items.length, 0);
    const view = await studio.create({ kind: 'video', prompt: '@图1 走进 @图2', refIds: [first.id, second.id], channel: channel.value, duration: 15, resolution: '720p', aspectRatio: '9:16' });
    assert.equal(view.items.length, 1);
    await context.done();
    assert.equal(submitted.length, 1);
    assert.equal(uploaded.length, 2);
    assert.match(submitted[0].prompt, /^@ref_[0-9a-f]+\.png\s+走进 @ref_[0-9a-f]+\.png$/);
    assert.deepEqual(submitted[0].referenceImages, [{ assetId: 'remote-1' }, { assetId: 'remote-2' }]);
    assert.equal(submitted[0].duration, 15); assert.equal(submitted[0].aspectRatio, '9:16'); assert.equal(submitted[0].resolution, '720p');
    const item = studio.view().items[0];
    assert.equal(item.job.state, 'completed');
    assert.equal(await readFile(studio.media(item.result.file), 'utf8'), 'downloaded:https://cdn.example/a.mp4');
    // 重新打开后记录还在，已完成的不会再次提交。
    const reopened = new Studio(context.root, context.workflow); await reopened.init(); await context.done();
    assert.equal(reopened.view().items[0].job.state, 'completed'); assert.equal(submitted.length, 1);
    await reopened.remove(item.id);
    assert.equal(reopened.view().items.length, 0);
    assert.ok(!(await readdir(join(context.root, '_studio'))).includes(item.result.file));
  } finally { await context.close(); }
});

test('自由创作：失败后可继续查询原任务，不重复提交；重启时刚提交的任务标为待核对', async () => {
  let submits = 0, broken = true;
  const context = await setup({ video: () => ({
    uploadImage: async () => ({ assetId: 'x' }),
    submit: async () => { submits++; return { id: 'task-9', status: 'queued', urls: [] }; },
    getTask: async () => { if (broken) throw new Error('网络断了'); return { id: 'task-9', status: 'completed', urls: ['https://cdn.example/b.mp4'] }; },
  }) });
  try {
    const { studio } = context, channel = studio.view().channels[0].value;
    await studio.create({ kind: 'video', prompt: '一只猫', channel, duration: 15, resolution: '720p' });
    await context.done();
    let item = studio.view().items[0];
    assert.equal(item.job.state, 'failed'); assert.equal(item.job.canResume, true);
    await assert.rejects(studio.remove('nope'), /不存在/);
    broken = false; await studio.resume(item.id); await context.done();
    item = studio.view().items[0];
    assert.equal(item.job.state, 'completed'); assert.equal(submits, 1);
    // 模拟：提交时间已记下、任务号还没拿到就重启。
    studio.items.unshift({ id: 'aaaa', kind: 'video', prompt: 'x', refs: [], aspectRatio: '16:9', createdAt: new Date().toISOString(), job: { state: 'submitting', submittedAt: new Date().toISOString() } });
    await studio.save();
    const reopened = new Studio(context.root, context.workflow); await reopened.init(); await context.done();
    assert.equal(reopened.view().items[0].job.state, 'unknown'); assert.equal(submits, 1);
  } finally { await context.close(); }
});

test('自由创作生成图片：参考图以 data URL 提交，@图N 变成文字', async () => {
  const submitted = [];
  const context = await setup({ image: () => ({ submit: async input => { submitted.push(input); return { id: 'img-1', status: 'completed', urls: ['https://cdn.example/a.png'] }; } }) });
  try {
    const { studio } = context, ref = await studio.addReference(PNG);
    await assert.rejects(studio.addReference(Buffer.from('not an image')), /PNG、JPEG 或 WebP/);
    await studio.create({ kind: 'image', prompt: '把 @图1 换成夜景', refIds: [ref.id], aspectRatio: '1:1' });
    await context.done();
    assert.equal(submitted[0].prompt, '把 图1换成夜景'); assert.equal(submitted[0].aspectRatio, '1:1');
    assert.match(submitted[0].images[0], /^data:image\/png;base64,/);
    const item = studio.view().items[0];
    assert.equal(item.job.state, 'completed'); assert.match(item.result.file, /\.png$/);
  } finally { await context.close(); }
});

test('自由创作接口：需要页面令牌，参考图能上传并取回，不泄露 Key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-http-'));
  await writeFile(join(root, 'package.json'), '{"version":"1.0.0"}');
  const app = await createApplication({ root, config: { ...config(), minimax: { apiKey: '', baseUrl: 'https://api.minimax.cn', model: 'speech-2.8-hd' } }, seedDemo: false, updateRoot: root });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const denied = await fetch(`${base}/api/studio/references`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 403);
    const headers = { 'Content-Type': 'application/json', 'X-Workflow-Token': app.token };
    const created = await fetch(`${base}/api/studio/references`, { method: 'POST', headers, body: JSON.stringify({ base64: PNG.toString('base64'), name: 'a.png' }) });
    assert.equal(created.status, 201);
    const reference = await created.json();
    const picture = await fetch(base + reference.url);
    assert.equal(picture.status, 200); assert.equal(picture.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/studio-media/..%2Fprovider-settings.json`)).status, 400);
    const view = await (await fetch(`${base}/api/studio`)).text();
    assert.ok(!view.includes('fake-video') && !view.includes('fake-image'));
    const empty = await fetch(`${base}/api/studio/items`, { method: 'POST', headers, body: JSON.stringify({ kind: 'video', prompt: '' }) });
    assert.equal(empty.status, 400);
  } finally { app.workflow.stopping = true; await new Promise(done => app.server.close(done)); await rm(root, { recursive: true, force: true }); }
});

test('画布：保存时清洗字段，生成图可以转成参考图，参考图不会被清理', async () => {
  const context = await setup({ image: () => ({ submit: async () => ({ id: 'img-2', status: 'completed', urls: ['https://cdn.example/b.png'] }) }) });
  try {
    const { studio } = context, ref = await studio.addReference(PNG);
    const canvas = await studio.createCanvas({ title: '  测试画布  ' });
    assert.equal(canvas.title, '测试画布');
    const saved = await studio.updateCanvas(canvas.id, { title: '改名', view: { x: 10, y: 'bad', k: 99 }, nodes: [
      { id: 'node01', type: 'image', source: 'upload', x: 5, y: 6, w: 9999, refId: ref.id, url: ref.url, prompt: 'x'.repeat(9000) },
      { id: 'node02', type: 'video', x: 1, y: 2, settings: { aspectRatio: '4:3', duration: 15 }, url: 'https://evil.example/a.png' },
      { id: 'node01', type: 'image' }, { id: '../bad' }, null,
    ], edges: [{ from: 'node01', to: 'node02' }, { from: 'node01', to: 'node02' }, { from: 'node01', to: 'node01' }, { from: 'ghost', to: 'node02' }],
      groups: [{ id: 'group01', label: '  人物  ', nodes: ['node01', 'node02', 'ghost'] }, { id: 'group02', nodes: ['node01'] }, { id: 'bad id', nodes: ['node02'] }] });
    assert.deepEqual(saved.groups, [{ id: 'group01', label: '人物', nodes: ['node01', 'node02'] }]);
    assert.equal(saved.nodes.length, 2); assert.equal(saved.nodes[0].w, 900); assert.equal(saved.nodes[0].prompt.length, 8000);
    assert.equal(saved.nodes[1].url, ''); assert.equal(saved.nodes[1].settings.aspectRatio, '16:9');
    assert.deepEqual(saved.edges, [{ from: 'node01', to: 'node02' }]); assert.deepEqual(saved.view, { x: 10, y: 0, k: 3 });
    await studio.create({ kind: 'image', prompt: '一张图' }); await context.done();
    const item = studio.view().items[0], promoted = await studio.referenceFromItem(item.id);
    assert.equal((await studio.referenceFromItem(item.id)).id, promoted.id);
    await studio.remove(item.id);
    assert.ok((await readFile(studio.media(promoted.url.split('/').pop()))).length > 0);
    // 重新打开：画布还在；画布节点用着的参考图即使过了一天也不清理。
    studio.references.get(ref.id).createdAt = '2020-01-01T00:00:00.000Z'; await studio.save();
    const reopened = new Studio(context.root, context.workflow); await reopened.init();
    assert.equal(reopened.listCanvases()[0].title, '改名'); assert.ok(reopened.references.has(ref.id));
    await assert.rejects(async () => reopened.canvas('nope'), /画布不存在/);
    assert.deepEqual(await reopened.removeCanvas(canvas.id), []);
  } finally { await context.close(); }
});

test('画布音视频：上传整理、分离音视频、截取音频，旧文件和非法路径都挡住', async t => {
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { return t.skip('本机没有 FFmpeg'); }
  const root = await mkdtemp(join(tmpdir(), 'studio-clips-'));
  await writeFile(join(root, 'package.json'), '{"version":"1.0.0"}');
  const source = join(root, 'source.mov');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x284:rate=12:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', source]);
  const app = await createApplication({ root, config: { ...config(), minimax: { apiKey: '', baseUrl: 'https://api.minimax.cn', model: 'speech-2.8-hd' } }, seedDemo: false, updateRoot: root });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${app.server.address().port}`, json = { 'Content-Type': 'application/json', 'X-Workflow-Token': app.token };
  try {
    const raw = { 'Content-Type': 'application/octet-stream', 'X-Workflow-Token': app.token, 'X-File-Name': encodeURIComponent('片段 1.mov') };
    assert.equal((await fetch(`${base}/api/studio/clips`, { method: 'POST', headers: { ...raw, 'X-Workflow-Token': 'x' }, body: await readFile(source) })).status, 403);
    const uploaded = await (await fetch(`${base}/api/studio/clips`, { method: 'POST', headers: raw, body: await readFile(source) })).json();
    assert.equal(uploaded.kind, 'video'); assert.match(uploaded.url, /^\/studio-media\/clip_[a-f0-9]+\.mp4$/); assert.equal(uploaded.name, '片段 1'); assert.ok(Math.abs(uploaded.duration - 3) < 0.3); assert.equal(uploaded.height, 284);
    const split = await (await fetch(`${base}/api/studio/split`, { method: 'POST', headers: json, body: JSON.stringify({ file: uploaded.url, name: '片段 1' }) })).json();
    assert.equal(split.video.kind, 'video'); assert.equal(split.audio.kind, 'audio'); assert.match(split.audio.url, /\.m4a$/); assert.equal(split.video.name, '片段 1_无声');
    const audioResponse = await fetch(base + split.audio.url); assert.equal(audioResponse.headers.get('content-type'), 'audio/mp4');
    const silent = await fetch(`${base}/api/studio/split`, { method: 'POST', headers: json, body: JSON.stringify({ file: split.video.url }) });
    assert.equal(silent.status, 400); assert.match((await silent.json()).error, /没有声音/);
    const cut = await (await fetch(`${base}/api/studio/trim`, { method: 'POST', headers: json, body: JSON.stringify({ file: split.audio.url, start: 0.5, end: 1.5, name: '片段 1_音轨' }) })).json();
    assert.equal(cut.kind, 'audio'); assert.ok(Math.abs(cut.duration - 1) < 0.15, String(cut.duration)); assert.equal(cut.name, '片段 1_音轨_截取');
    for (const body of [{ file: split.audio.url, start: 1, end: 1.02 }, { file: split.audio.url, start: 0, end: 30 }, { file: '../provider-settings.json', start: 0, end: 1 }, { file: '/studio-media/ref_x.png', start: 0, end: 1 }]) {
      const bad = await fetch(`${base}/api/studio/trim`, { method: 'POST', headers: json, body: JSON.stringify(body) }); assert.notEqual(bad.status, 201);
    }
    const garbage = await fetch(`${base}/api/studio/clips`, { method: 'POST', headers: raw, body: 'not media' }); assert.notEqual(garbage.status, 201);
    assert.ok(!(await readdir(join(root, '_studio'))).some(name => /^upload_/.test(name)));
    // 画布节点引用的音视频保存后能原样读回来。
    const canvas = await (await fetch(`${base}/api/studio/canvases`, { method: 'POST', headers: json, body: '{}' })).json();
    const saved = await (await fetch(`${base}/api/studio/canvases/${canvas.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ nodes: [{ id: 'audio1', type: 'audio', source: 'gen', x: 0, y: 0, w: 320, url: cut.url, duration: cut.duration, label: '音频' }, { id: 'video1', type: 'video', source: 'upload', x: 0, y: 0, w: 320, url: '/studio-media/../x.mp4' }] }) })).json();
    assert.equal(saved.nodes[0].type, 'audio'); assert.equal(saved.nodes[0].source, 'upload'); assert.equal(saved.nodes[0].url, cut.url); assert.equal(saved.nodes[1].url, '');
  } finally { app.workflow.stopping = true; await new Promise(done => app.server.close(done)); await rm(root, { recursive: true, force: true }); }
});
