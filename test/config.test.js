// 配置层单元测试
import test from 'node:test';
import assert from 'node:assert/strict';

// 必须在动态 import config 之前污染环境变量：验证"非法值回退 + 记录问题"
// （静态 import 会被提升，所以这里用动态 import）
process.env.WIN_THRESHOLD = '八十';
process.env.DISCORD_ENABLED = 'maybe';
process.env.ADMIN_PORT = '99999';
process.env.QQ_PREFIX = '';

const { config, configProblems, isPlaceholder } = await import('../src/config.js');

test('非数字的 WIN_THRESHOLD 回退为默认值并被记录', () => {
  assert.equal(config.judge.winThreshold, 0.8);
  assert.ok(configProblems.some((p) => p.includes('WIN_THRESHOLD')));
});

test('非法布尔值回退为默认值并被记录', () => {
  assert.equal(config.discord.enabled, true);
  assert.ok(configProblems.some((p) => p.includes('DISCORD_ENABLED')));
});

test('超出范围的 ADMIN_PORT 回退为默认值并被记录（端口不会变成 NaN）', () => {
  assert.equal(config.admin.port, 4319);
  assert.ok(configProblems.some((p) => p.includes('ADMIN_PORT')));
});

test('空字符串按默认值处理', () => {
  assert.equal(config.qq.prefix, '#');
});

test('管理 API 默认只监听回环地址', () => {
  assert.equal(config.admin.host, '127.0.0.1');
});

test('isPlaceholder 识别 .env 里的示例占位符', () => {
  assert.equal(isPlaceholder(''), true);
  assert.equal(isPlaceholder(undefined), true);
  assert.equal(isPlaceholder('your-vck-key-here'), true);
  assert.equal(isPlaceholder('your_discord_token'), true);
  assert.equal(isPlaceholder('vck_abc123'), false);
});
