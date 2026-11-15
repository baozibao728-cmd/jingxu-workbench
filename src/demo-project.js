import { readFile, copyFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, now } from './project-store.js';

export async function importExistingTest(store, workflow, baseDirectory) {
  if ([...store.projects.values()].some(project => project.demoImported)) return;
  const source = join(baseDirectory, 'data', 'integration-test');
  let plan, review;
  try {
    plan = JSON.parse(await readFile(join(source, 'test-plan.json'), 'utf8'));
    review = JSON.parse(await readFile(join(source, 'video-review.json'), 'utf8'));
    await access(join(source, 'video-test-5s.mp4'));
  } catch { return; }
  const project = await store.create({ title: '取信望窗', script: plan.script, style: '写实电影', aspectRatio: '16:9', clipDuration: 5 });
  project.demoImported = true;
  const entries = [...plan.assets, { id: 'keyframe', kind: 'frame', name: '取信 · 构图参考', prompt: await readFile(join(source, 'keyframe-prompt.txt'), 'utf8'), aspectRatio: '16:9' }];
  for (const entry of entries) {
    const filename = `${entry.id}.png`;
    await copyFile(join(source, filename), store.media(project.id, filename));
    const bytes = await readFile(join(source, filename));
    project.assets.push({ id: entry.id, sourceKey: entry.id, kind: entry.kind, name: entry.name, description: entry.name,
      prompt: entry.prompt, aspectRatio: entry.aspectRatio, history: [], job: { state: 'completed', progress: 100 },
      image: { file: filename, filename, sha256: digest(bytes), createdAt: now(), model: 'gpt-image-2.6' } });
  }
  let template = review.request.prompt;
  for (const asset of project.assets) template = template.replaceAll(`@${asset.image.filename}`, `{{ref:${asset.id}}}`);
  await copyFile(join(source, 'video-test-5s.mp4'), store.media(project.id, 'video-test-5s.mp4'));
  const shot = { id: 'shot-test-01', title: '拿起信封，望向窗外', description: '暖色书房中，女信使拿起红色信封，再转头望向窗外。',
    duration: 5, promptTemplate: template, assetIds: ['keyframe', 'character-01', 'scene-01', 'prop-01'], history: [],
    job: { state: 'completed', progress: 100, message: '视频已完成', taskId: review.taskId },
  };
  shot.video = { file: 'video-test-5s.mp4', inputHash: workflow.inputHash(project, shot), createdAt: now(), duration: 5, model: 'seedance2.0', taskId: review.taskId };
  project.shots.push(shot);
  project.preparation = { state: 'completed', stage: '资产和分镜已就绪', completed: 4, total: 4 };
  store.log(project, '已导入刚才真实生成的四张图片及5秒成片，可在这里编辑和查看。', 'success');
  await store.save(project);
}
