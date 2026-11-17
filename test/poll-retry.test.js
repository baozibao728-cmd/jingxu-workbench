import test from 'node:test';
import assert from 'node:assert/strict';
import { Workflow } from '../src/workflow.js';

const flow = () => Object.assign(Object.create(Workflow.prototype), { intervalMs: 1, stopping: false });

test('查询进度时断网、5xx、限流会重试，不把已提交的任务判成失败', async () => {
  let calls = 0;
  const errors = [new Error('连不上'), Object.assign(new Error('忙'), { status: 503 }), Object.assign(new Error('限流'), { status: 429 })];
  const provider = { getTask: async () => { if (calls < errors.length) throw errors[calls++]; calls++; return { id: 't', status: 'running' }; } };
  assert.equal((await flow().pollTask(provider, 't')).status, 'running');
  assert.equal(calls, 4);
});

test('查询进度遇到 4xx 立即报错，连续断网太多次才放弃', async () => {
  let calls = 0;
  const notFound = { getTask: async () => { calls++; throw Object.assign(new Error('任务不存在'), { status: 404 }); } };
  await assert.rejects(flow().pollTask(notFound, 't'), /任务不存在/); assert.equal(calls, 1);
  calls = 0;
  const offline = { getTask: async () => { calls++; throw new Error('连不上'); } };
  await assert.rejects(flow().pollTask(offline, 't', { tries: 5 }), /连不上/); assert.equal(calls, 5);
});
