// 配置文件损坏时的行为：备份原文件、以默认值继续，不静默丢配置
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'turtle-cfg-bad-'));
const file = join(dir, 'config.json');
const broken = '{ "judge": { "winThreshold": 0.9, ';
await writeFile(file, broken, 'utf8');

process.env.CONFIG_FILE = file;
const { config, configProblems, loadConfig } = await import('../src/config.js');

test('损坏的配置会被备份并回退到默认值', async () => {
  await loadConfig();

  assert.ok(configProblems.length > 0, '应记录配置问题');
  assert.equal(config.judge.winThreshold, 0.8, '应回退到默认阈值');
  assert.equal(config.admin.host, '127.0.0.1');

  const backups = (await readdir(dir)).filter((n) => n.includes('.corrupt-') && n.endsWith('.bak'));
  assert.equal(backups.length, 1, '应生成一份备份');
  assert.equal(await readFile(join(dir, backups[0]), 'utf8'), broken, '备份内容应与原文件一致');
});

test('带 BOM 的配置（记事本存出来的）不算损坏，能正常读入', async () => {
  await rm(file, { force: true });
  // 末尾留一个非空判定：真正带 BOM 的 UTF-8 文件
  await writeFile(file, '\uFEFF' + JSON.stringify({ judge: { winThreshold: 0.42 } }), 'utf8');

  await loadConfig();

  assert.deepEqual(configProblems, [], '带 BOM 不应被当成解析失败');
  assert.equal(config.judge.winThreshold, 0.42, '配置值应被正确读入');
  const backups = (await readdir(dir)).filter((n) => n.includes('.corrupt-') && n.endsWith('.bak'));
  assert.equal(backups.length, 1, '不应再产生备份');
});
