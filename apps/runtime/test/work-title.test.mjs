import assert from 'node:assert/strict';
import test from 'node:test';

import { titleFromFirstMessage } from '../src/work-title.ts';

test('first Work message becomes a short title without exposing long tokens or URLs', () => {
  assert.equal(titleFromFirstMessage('你再测试一下侧边栏打开百度。然后检查标题'), '你再测试一下侧边栏打开百度');
  assert.equal(titleFromFirstMessage('请访问 https://example.com/a 查看内容'), '请访问 网页 查看内容');
  assert.equal(titleFromFirstMessage('检查 sk_123456789012345678901234567890 是否有效'), '检查 内容 是否有效');
  assert.ok(Array.from(titleFromFirstMessage('任务'.repeat(40))).length <= 27);
});
