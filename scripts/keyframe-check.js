import { readFile, writeFile, rename } from 'node:fs/promises';
import { readConfig } from '../src/config.js';
import { GrsaiImageProvider, localImageReference } from '../src/providers.js';
import { downloadResult } from '../src/http.js';

const root = 'data/integration-test';
const taskPath = `${root}/keyframe-task.json`;
const prompt = 'Create one photorealistic cinematic 16:9 opening frame, using the three supplied reference images in order. Reference 1 defines the adult East Asian woman: preserve her face, short black hair, blue short-sleeved zip-up jacket, beige trousers and identity. Reference 2 defines the warm sunlit old study: preserve the wooden desk, left-side window, bookshelves and natural lighting. Reference 3 defines one closed blank red paper envelope. Place the woman standing naturally behind the right side of the wooden desk, her right hand resting close to the red envelope lying flat on the tabletop, ready to pick it up. Her face and upper body should be clearly visible, and the window should remain visible on the left. Medium-wide single continuous-camera composition. Warm daylight, coherent perspective, realistic human scale and natural hands. Only one woman and one envelope. No collage, no split screen, no labels, no text, no watermark.';
await writeFile(`${root}/keyframe-prompt.txt`, prompt);
async function save(value) {
  await writeFile(`${taskPath}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(`${taskPath}.tmp`, taskPath);
}
let task;
try { task = JSON.parse(await readFile(taskPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const config = readConfig().grsai;
const provider = new GrsaiImageProvider({
  ...config,
  fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (options.method === 'POST') await save(await response.clone().json());
    return response;
  },
});
if (!task) {
  const images = await Promise.all(['character-01', 'scene-01', 'prop-01'].map(id => localImageReference(`${root}/${id}.png`)));
  await writeFile(`${root}/keyframe-submit-intent.json`, JSON.stringify({ at: new Date().toISOString(), model: config.model }), { flag: 'wx', mode: 0o600 });
  task = await provider.submit({ prompt, images, aspectRatio: '16:9' });
  await save(task);
  console.log(JSON.stringify({ stage: 'keyframe', task: task.id, status: task.status }));
}
const deadline = Date.now() + 20 * 60 * 1000;
let ticks = 0;
while (true) {
  task = await provider.getTask(task.id);
  await save(task);
  if (task.status === 'completed') {
    console.log(JSON.stringify(await downloadResult(task.urls[0], `${root}/keyframe.png`)));
    break;
  }
  if (task.status === 'failed') throw new Error('参考图合成首帧失败，未自动重新提交');
  if (Date.now() > deadline) throw new Error('等待超时，任务ID已保存，不能重复提交');
  if (++ticks % 6 === 0) console.log(JSON.stringify({ stage: 'keyframe', status: task.status, progress: task.progress }));
  await new Promise(resolve => setTimeout(resolve, 5000));
}
