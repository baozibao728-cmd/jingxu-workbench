import { createHash } from 'node:crypto';

export function validateReviewedVideoTest(review, approvedSha256) {
  if (review?.status !== 'awaiting_user_review' || review.submitted !== false) {
    throw new Error('没有待确认的测试请求，或该请求已提交');
  }
  const request = review.request;
  if (request?.duration !== 5) throw new Error('本次视频测试只允许5秒');
  const actualSha256 = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  if (actualSha256 !== review.requestSha256 || approvedSha256 !== actualSha256) {
    throw new Error('确认摘要与当前请求不一致，请重新展示完整提示词和参数');
  }
  return request;
}
