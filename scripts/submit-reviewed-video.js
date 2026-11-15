import { readFile, writeFile, rename } from 'node:fs/promises';
import { readConfig } from '../src/config.js';
import { FydmaiVideoProvider } from '../src/providers.js';
import { validateReviewedVideoTest } from '../src/video-test-policy.js';

// 仅在用户明确确认具体审阅内容后调用。这个文件不会由生图/上传脚本自动调用。
const root = 'data/integration-test';
const reviewPath = `${root}/video-review.json`;
const review = JSON.parse(await readFile(reviewPath, 'utf8'));
const request = validateReviewedVideoTest(review, process.argv[2]);
// 原子创建提交意向：即使超时/重启，也禁止无意重复提交。
await writeFile(`${root}/video-submit-intent.json`, JSON.stringify({ requestSha256: review.requestSha256, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
const provider = new FydmaiVideoProvider({
  ...readConfig().fydmai,
  model: request.model,
  fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (options.method === 'POST') {
      await writeFile(`${root}/video-submit-response.json`, JSON.stringify(await response.clone().json(), null, 2), { mode: 0o600 });
    }
    return response;
  },
});
const task = await provider.submit(request);
await writeFile(`${root}/video-task.json`, JSON.stringify(task, null, 2), { mode: 0o600 });
const next = { ...review, status: 'submitted', submitted: true, taskId: task.id };
await writeFile(`${reviewPath}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
await rename(`${reviewPath}.tmp`, reviewPath);
console.log(JSON.stringify(task));
