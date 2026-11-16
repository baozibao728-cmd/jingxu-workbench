import {readdir, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';

// 1.3.2 起不再内置系统提示词。自动更新只会新增和替换文件，不会删除旧文件，
// 所以旧版本留下的提示词文件要在启动时清掉：程序目录里的模板文件，以及更新备份里带旧规则的程序文件。
// 只删程序文件，不碰使用者自己保存的提示词、项目和素材。
const TEMPLATE = 'storyboard-format-system.txt';
const MARKERS = ['严格按原剧本顺序拆解', '提取正文中需要出镜的人物'];

async function sweep(directory, depth, removed) {
  if (depth > 6) return;
  let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { await sweep(path, depth + 1, removed); continue; }
    if (entry.name === TEMPLATE) { await rm(path, { force: true }); removed.push(path); continue; }
    if (entry.name === 'prompt-settings.js') {
      try { const text = await readFile(path, 'utf8'); if (MARKERS.some(marker => text.includes(marker))) { await rm(path, { force: true }); removed.push(path); } } catch {}
    }
  }
}

export async function removeLegacyPrompts(applicationRoot) {
  const removed = [];
  try {
    const template = join(applicationRoot, 'prompts', TEMPLATE);
    try { await readFile(template); await rm(template, { force: true }); removed.push(template); } catch {}
    const data = join(applicationRoot, 'data');
    await sweep(join(data, 'program-backups'), 0, removed);
    let entries = []; try { entries = await readdir(data, { withFileTypes: true }); } catch {}
    for (const entry of entries) if (entry.isDirectory() && entry.name.startsWith('pre-upgrade-')) await sweep(join(data, entry.name), 0, removed);
  } catch {}
  return removed;
}
