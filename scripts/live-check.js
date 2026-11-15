import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { readConfig } from '../src/config.js';
import { DeepSeekProvider, GrsaiImageProvider, FydmaiVideoProvider } from '../src/providers.js';
import { downloadResult } from '../src/http.js';

// 真实文本/生图联调入口。这里有意不调用任何视频生成方法。
const root = 'data/integration-test';
await mkdir(root, { recursive: true });
const config = readConfig();
const stage = process.argv[2];

async function save(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

async function load(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

if (stage === 'text') {
  const path = join(root, 'test-plan.json');
  if (await load(path)) throw new Error('已有测试剧本，请先检查已有内容，不自动重复生成');
  const plan = await new DeepSeekProvider(config.deepseek).generateJson({
    instructions: `为 API 联调写一个原创、简单、无对白的5秒镜头，并给三张独立参考图写英文生图提示词。
必须为一名成年东亚女信使，约30岁，短黑发、蓝色短外套、米色长裤；在明亮而温暖的旧式书房里，拿起木桌上的一个无文字红色信封，然后看向窗外。
单一连续镜头，动作可在5秒内完成，不要复杂剧情、人物增加、字幕或商标。
角色资产图为单人完整全身、自然站姿、浅灰纯背景、不带信封。场景资产为无人空景、一张木桌和一扇窗、没有信封。道具资产为单个封闭红色纸质信封、白底、没有手、人物和文字。
三张图统一写实电影风格。角色比例2:3、场景16:9、道具1:1。
JSON示例结构严格为 {"title":"...","script":"...","assets":[{"id":"character-01","kind":"character","name":"女信使","aspectRatio":"2:3","prompt":"英文"},{"id":"scene-01","kind":"scene","name":"书房","aspectRatio":"16:9","prompt":"英文"},{"id":"prop-01","kind":"prop","name":"红色信封","aspectRatio":"1:1","prompt":"英文"}],"video":{"duration":5,"aspectRatio":"16:9","prompt":"完整中文视频提示词，说明0到5秒内动作、画面和运镜。人物、场景、道具分别用{{ref:character-01}}、{{ref:scene-01}}、{{ref:prop-01}}占位，不自行编造@语法。"}}。
以上角色设定、独立资产要求以及确切5秒时长不可改变。`,
    input: '生成用于核对剧本→独立资产→参考图→视频链路的完整测试 JSON。',
    maxTokens: 4096,
  });
  const expected = ['character-01', 'scene-01', 'prop-01'];
  if (!Array.isArray(plan.assets) || plan.assets.length !== 3 || !expected.every(id => plan.assets.filter(a => a.id === id).length === 1)) throw new Error('资产清单不符合约定');
  if (plan.video?.duration !== 5 || !expected.every(id => plan.video.prompt.includes(`{{ref:${id}}}`))) throw new Error('测试视频必须为5秒且含三项资产引用');
  await save(path, plan);
  console.log(JSON.stringify({ stage: 'text', model: config.deepseek.model, plan }, null, 2));
} else if (stage === 'images') {
  const plan = await load(join(root, 'test-plan.json'));
  if (!plan) throw new Error('请先完成 text 阶段');
  const outcomes = await Promise.allSettled(plan.assets.map(async asset => {
    const taskPath = join(root, `${asset.id}-task.json`);
    const output = join(root, `${asset.id}.png`);
    let task = await load(taskPath);
    const observedFetch = async (url, options) => {
      const response = await fetch(url, options);
      if (options.method === 'POST' && new URL(url).pathname === '/v1/api/generate') {
        const raw = await response.clone().json();
        // 在适配器解析之前先持久化任务ID；不保存鉴权头。
        await save(taskPath, { ...raw, model: config.grsai.model, assetId: asset.id, receivedAt: new Date().toISOString() });
      }
      return response;
    };
    const provider = new GrsaiImageProvider({ ...config.grsai, fetchImpl: observedFetch });
    if (!task) {
      // 请求结果不明确时保留意向文件，下次不得盲目重提。
      await writeFile(join(root, `${asset.id}-submit-intent.json`), JSON.stringify({ assetId: asset.id, model: config.grsai.model, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
      task = await provider.submit({ prompt: asset.prompt, aspectRatio: asset.aspectRatio });
      await save(taskPath, task);
      console.log(JSON.stringify({ asset: asset.id, task: task.id, status: task.status }));
    }
    if (!task.id) throw new Error('提交结果缺少任务ID，需人工核对');
    const deadline = Date.now() + 20 * 60 * 1000;
    let ticks = 0;
    while (true) {
      task = await provider.getTask(task.id);
      await save(taskPath, task);
      if (task.status === 'completed') {
        const downloaded = await downloadResult(task.urls[0], output);
        console.log(JSON.stringify({ asset: asset.id, status: 'downloaded', ...downloaded }));
        return downloaded;
      }
      if (task.status === 'failed') throw new Error(`生图失败：${asset.id}`);
      if (Date.now() > deadline) throw new Error(`等待超时，已有任务ID已保存：${asset.id}`);
      if (++ticks % 6 === 0) console.log(JSON.stringify({ asset: asset.id, status: task.status, progress: task.progress }));
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }));
  for (let i = 0; i < outcomes.length; i++) {
    const result = outcomes[i];
    if (result.status === 'rejected') console.log(JSON.stringify({ asset: plan.assets[i].id, error: result.reason.message }));
  }
  if (outcomes.some(result => result.status === 'rejected')) process.exitCode = 1;
} else if (stage === 'uploads') {
  const plan = await load(join(root, 'test-plan.json'));
  if (!plan) throw new Error('请先完成 text 和 images 阶段');
  const provider = new FydmaiVideoProvider(config.fydmai);
  for (const asset of plan.assets) {
    const output = join(root, `${asset.id}-upload.json`);
    if (await load(output)) { console.log(JSON.stringify({ asset: asset.id, status: 'already-uploaded' })); continue; }
    const uploaded = await provider.uploadImage(join(root, `${asset.id}.png`));
    await save(output, { id: asset.id, version: uploaded.sha256, ...uploaded });
    console.log(JSON.stringify({ asset: asset.id, status: 'uploaded', reused: uploaded.reused }));
  }
  console.log('素材准备完成；尚未提交任何视频任务。');
} else {
  throw new Error('用法：node --env-file=.env scripts/live-check.js text|images|uploads');
}
