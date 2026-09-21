// 无第三方依赖的静态检查：对 src / test / scripts 下所有 .js / .mjs 跑一遍 node --check
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOTS = ['src', 'test', 'scripts'];
const TARGET = /\.m?js$/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (TARGET.test(entry.name)) out.push(path);
  }
  return out;
}

const files = ROOTS.flatMap((root) => walk(root)).sort();

if (files.length === 0) {
  console.error('没有找到待检查的源文件');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    console.error(`✗ ${file}`);
    console.error((result.stderr || result.stdout || '').trim());
  }
}

console.log(`语法检查：${files.length - failed}/${files.length} 个文件通过`);
process.exit(failed === 0 ? 0 : 1);
