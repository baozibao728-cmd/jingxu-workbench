import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateReviewedVideoTest } from '../src/video-test-policy.js';

function reviewFor(request) {
  return { status: 'awaiting_user_review', submitted: false, request, requestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex') };
}

test('视频测试仅接受用户确认的同一份5秒请求', () => {
  const review = reviewFor({ model: 'seedance2.0', prompt: '拿起信封', duration: 5 });
  assert.equal(validateReviewedVideoTest(review, review.requestSha256).duration, 5);
  assert.throws(() => validateReviewedVideoTest(review), /确认摘要/);
  review.request.prompt = '另一条提示词';
  assert.throws(() => validateReviewedVideoTest(review, review.requestSha256), /重新展示/);
});

test('15秒或已提交请求即使摘要匹配也不能通过', () => {
  const longer = reviewFor({ duration: 15 });
  assert.throws(() => validateReviewedVideoTest(longer, longer.requestSha256), /只允许5秒/);
  const submitted = reviewFor({ duration: 5 });
  submitted.submitted = true;
  assert.throws(() => validateReviewedVideoTest(submitted, submitted.requestSha256), /已提交/);
});
