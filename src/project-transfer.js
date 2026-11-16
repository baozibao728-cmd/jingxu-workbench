import {mkdir, readdir, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ZipWriter, ZipReader} from './zip.js';
import {jobActive, now} from './project-store.js';

// 项目导出、导入。包里只有项目内容和媒体文件：不含 Key、厂商配置、语音库和上传缓存。
export const EXPORT_FORMAT = 'jingxu-projects';
const MEDIA_NAME = /^[\p{L}\p{N}_.-]+$/u;
const ENTRY = /(?:^|\/)projects\/(\d+)\/(project\.json|media\/([^/]+))$/;
const MANIFEST = /(?:^|\/)jingxu-export\.json$/;
const MAX_TOTAL = 3.9 * 1024 * 1024 * 1024;
const text = (value, max, fallback = '') => typeof value === 'string' ? value.slice(0, max) : fallback;
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const mediaFiles = async directory => (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name !== 'project.json' && MEDIA_NAME.test(entry.name) && !/\.(tmp|part)$/.test(entry.name)).map(entry => entry.name);

// 去掉只在原电脑上有意义的状态：进行中的任务、远端任务号、厂商绑定。
export function portable(source) {
  const project = structuredClone(source);
  project.assets = (Array.isArray(project.assets) ? project.assets : []).filter(asset => isObject(asset) && typeof asset.id === 'string' && typeof asset.name === 'string');
  project.shots = (Array.isArray(project.shots) ? project.shots : []).filter(shot => isObject(shot) && typeof shot.id === 'string' && typeof shot.promptTemplate === 'string');
  for (const asset of project.assets) {
    if (!isObject(asset.image) || typeof asset.image.file !== 'string') delete asset.image;
    asset.history = Array.isArray(asset.history) ? asset.history.filter(item => isObject(item) && typeof item.file === 'string') : [];
    asset.job = asset.image ? { state: 'completed', progress: 100 } : { state: 'idle' };
  }
  for (const shot of project.shots) {
    if (!isObject(shot.video) || typeof shot.video.file !== 'string') delete shot.video;
    shot.assetIds = Array.isArray(shot.assetIds) ? shot.assetIds.filter(id => typeof id === 'string') : [];
    shot.audioIds = Array.isArray(shot.audioIds) ? shot.audioIds.filter(id => typeof id === 'string') : [];
    shot.history = Array.isArray(shot.history) ? shot.history : [];
    shot.job = shot.video ? { state: 'completed', progress: 100 } : { state: 'idle' };
    delete shot.rebuildJob;
  }
  if (!isObject(project.preparation)) project.preparation = { state: 'idle', stage: '等待剧本', completed: 0, total: 0 };
  else if (jobActive(project.preparation)) project.preparation = { ...project.preparation, state: 'failed', error: '导出时这一步还没做完，可以点继续。' };
  if (jobActive(project.mergeJob)) delete project.mergeJob;
  if (project.storyboardReparse && project.storyboardReparse.state !== 'completed') delete project.storyboardReparse;
  if (!isObject(project.mergedVideo) || typeof project.mergedVideo.file !== 'string') delete project.mergedVideo;
  project.logs = Array.isArray(project.logs) ? project.logs.filter(isObject).slice(-160) : [];
  if (project.chunks !== undefined && !Array.isArray(project.chunks)) delete project.chunks;
  delete project.videoProviderId;
  return project;
}

export async function exportPlan(store, ids, workflow) {
  const list = [...new Set(Array.isArray(ids) ? ids : [])].map(id => store.get(String(id)));
  if (!list.length) throw Object.assign(new Error('请先勾选要导出的剧本'), { status: 400 });
  let total = 0; const plan = [];
  for (const project of list) {
    const directory = store.directory(project.id), files = await mediaFiles(directory);
    for (const file of files) total += (await stat(join(directory, file))).size;
    // 导出时视频还和当前提示词、素材一致的分镜。导入后厂商不同，靠这份名单保持“已完成”而不是“需重做”。
    // 项目绑定的视频渠道可能已被删掉，那种情况下无法核对，就都按一致处理。
    let freshShots;
    try { freshShots = project.shots.filter(shot => shot.video && shot.video.inputHash === workflow.inputHash(project, shot) && shot.continuityReview?.state !== 'required').map(shot => shot.id); }
    catch { freshShots = project.shots.filter(shot => shot.video).map(shot => shot.id); }
    plan.push({ project, directory, files, freshShots });
  }
  if (total > MAX_TOTAL) throw Object.assign(new Error('所选剧本的素材超过 4GB，请分几次导出'), { status: 413 });
  return plan;
}

export async function writeExport(plan, write) {
  const zip = new ZipWriter(write);
  const manifest = { format: EXPORT_FORMAT, version: 1, exportedAt: now(), projects: plan.map(({ project, freshShots }, index) => ({ dir: `projects/${index + 1}`, title: project.title, freshShots })) };
  await zip.add('jingxu-export.json', JSON.stringify(manifest, null, 2), { compress: true });
  for (const [index, { project, directory, files }] of plan.entries()) {
    await zip.add(`projects/${index + 1}/project.json`, JSON.stringify(portable(project), null, 2), { compress: true });
    // 图片、视频、音频本身已经压缩过，直接存入更快。
    for (const file of files) await zip.add(`projects/${index + 1}/media/${file}`, await readFile(join(directory, file)));
  }
  await zip.finish();
}

export async function importProjects(store, workflow, zipPath, { hasAudio = () => false, videoProviderId = '' } = {}) {
  const reader = await ZipReader.open(zipPath), imported = [];
  try {
    const groups = new Map();
    for (const entry of reader.entries) {
      const match = ENTRY.exec(entry.name); if (!match) continue;
      const key = entry.name.slice(0, match.index) + '|' + match[1];
      const group = groups.get(key) || { number: Number(match[1]), prefix: entry.name.slice(0, match.index), media: [] }; groups.set(key, group);
      if (match[2] === 'project.json') group.json = entry; else if (MEDIA_NAME.test(match[3]) && match[3] !== 'project.json') group.media.push({ entry, file: match[3] });
    }
    const ready = [...groups.values()].filter(group => group.json).sort((a, b) => a.number - b.number);
    if (!ready.length) throw Object.assign(new Error('压缩包里没有找到镜序导出的剧本'), { status: 400 });
    if (ready.length > 200) throw Object.assign(new Error('一次最多导入 200 个剧本'), { status: 400 });
    let manifest = null; const manifestEntry = reader.entries.find(entry => MANIFEST.test(entry.name));
    if (manifestEntry) try { manifest = JSON.parse((await reader.read(manifestEntry, 5 * 1024 * 1024)).toString('utf8')); } catch { manifest = null; }
    for (const group of ready) {
      let raw; try { raw = JSON.parse((await reader.read(group.json, 60 * 1024 * 1024)).toString('utf8')); } catch (error) { throw Object.assign(new Error(error.message.startsWith('压缩包') ? error.message : '压缩包里的项目文件不是有效内容'), { status: 400 }); }
      if (!isObject(raw)) throw Object.assign(new Error('压缩包里的项目文件不是有效内容'), { status: 400 });
      const project = portable(raw), id = randomUUID(), directory = join(store.root, id);
      await mkdir(directory, { recursive: true });
      try {
        const files = new Set();
        for (const { entry, file } of group.media) { await writeFile(join(directory, file), await reader.read(entry), { mode: 0o600 }); files.add(file); }
        Object.assign(project, { id, title: text(raw.title, 80, '导入的剧本') || '导入的剧本', script: text(raw.script, 100000), style: text(raw.style, 40, '写实电影') || '写实电影',
          aspectRatio: ['16:9', '9:16', '1:1'].includes(raw.aspectRatio) ? raw.aspectRatio : '16:9', ruleNotes: text(raw.ruleNotes, 6000),
          clipDuration: Number(raw.clipDuration) || 15, resolution: text(raw.resolution, 20, '720p') || '720p', revision: Number.isInteger(raw.revision) ? raw.revision : 1,
          videoProviderId, createdAt: now(), skipReview: false });
        // 引用了包里没有的文件就当作还没生成，避免界面上出现打不开的图和视频。
        for (const asset of project.assets) {
          if (asset.image && !files.has(asset.image.file)) { delete asset.image; asset.job = { state: 'idle' }; }
          asset.history = asset.history.filter(item => files.has(item.file));
        }
        const fresh = new Set(manifest?.projects?.find?.(item => item?.dir === `projects/${group.number}`)?.freshShots || []);
        const assetIds = new Set(project.assets.map(asset => asset.id));
        for (const shot of project.shots) {
          if (shot.video && !files.has(shot.video.file)) { delete shot.video; shot.job = { state: 'idle' }; }
          shot.assetIds = shot.assetIds.filter(assetId => assetIds.has(assetId));
          shot.audioIds = shot.audioIds.filter(hasAudio);
          if (isObject(shot.audioRoles)) shot.audioRoles = Object.fromEntries(Object.entries(shot.audioRoles).filter(([audioId]) => shot.audioIds.includes(audioId)));
        }
        if (isObject(project.characterAudios)) project.characterAudios = Object.fromEntries(Object.entries(project.characterAudios).filter(([assetId, audioId]) => assetIds.has(assetId) && hasAudio(audioId)));
        else delete project.characterAudios;
        if (project.mergedVideo && !files.has(project.mergedVideo.file)) delete project.mergedVideo;
        store.projects.set(id, project);
        for (const shot of project.shots) if (shot.video && fresh.has(shot.id)) shot.video.inputHash = workflow.inputHash(project, shot);
        store.log(project, `从导出包导入：${project.assets.length}项资产、${project.shots.length}条分镜、${files.size}个媒体文件。`);
        await store.save(project);
        imported.push({ id, title: project.title });
      } catch (error) { store.projects.delete(id); await rm(directory, { recursive: true, force: true }); throw error; }
    }
  } finally { await reader.close(); }
  return imported;
}
