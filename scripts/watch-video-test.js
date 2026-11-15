import { readFile, writeFile, rename } from 'node:fs/promises';
import { readConfig } from '../src/config.js';
import { FydmaiVideoProvider } from '../src/providers.js';
import { downloadResult } from '../src/http.js';

// 只查询已存在的视频任务并下载结果，不具备提交/重提能力。
const root = 'data/integration-test';
const taskPath = `${root}/video-task.json`;
const existing = JSON.parse(await readFile(taskPath, 'utf8'));
if (!existing.id) throw new Error('缺少已提交的视频任务 ID，不能继续查询');
const provider = new FydmaiVideoProvider({ ...readConfig().fydmai, timeoutMs: 25_000 });
const startedAt = Date.now();
let previous = '';
let lastLoggedAt = 0;
let errors = 0;
while (true) {
  let task;
  try {
    task = await provider.getTask(existing.id);
    errors = 0;
  } catch (error) {
    errors++;
    console.log(JSON.stringify({ taskId: existing.id, queryError: error.message, consecutiveErrors: errors }));
    if (errors >= 8 || Date.now() - startedAt > 25 * 60 * 1000) throw error;
    await new Promise(resolve => setTimeout(resolve, 5000));
    continue;
  }
  await writeFile(`${taskPath}.tmp`, JSON.stringify(task, null, 2), { mode: 0o600 });
  await rename(`${taskPath}.tmp`, taskPath);
  const state = `${task.status}:${task.progress}`;
  if (state !== previous || Date.now() - lastLoggedAt >= 30_000) {
    console.log(JSON.stringify({ taskId: task.id, status: task.status, progress: task.progress, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000) }));
    previous = state;
    lastLoggedAt = Date.now();
  }
  if (task.status === 'failed') {
    console.log(JSON.stringify({ taskId: task.id, error: task.error }));
    throw new Error('视频任务失败；保留原任务，不自动重提');
  }
  if (task.status === 'completed') {
    const result = await downloadResult(task.urls[0], `${root}/video-test-5s.mp4`, { timeoutMs: 180_000 });
    await writeFile(`${root}/video-download.json`, JSON.stringify({ taskId: task.id, ...result, downloadedAt: new Date().toISOString() }, null, 2));
    console.log(JSON.stringify({ taskId: task.id, status: 'downloaded', ...result }));
    break;
  }
  if (Date.now() - startedAt > 25 * 60 * 1000) throw new Error('等待超时；任务ID已保留，请继续查询原任务，不要重新提交');
  await new Promise(resolve => setTimeout(resolve, 5000));
}
