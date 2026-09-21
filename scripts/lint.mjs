// 无第三方依赖的静态检查：
//   1. 对 src / test / scripts / public 下所有 .js / .mjs 跑一遍 node --check
//   2. 跨平台检查：import 路径的大小写必须和真实文件名完全一致
//      （Windows 的文件系统不区分大小写，Linux 区分：写 './Foo.js' 而文件叫 'foo.js'
//        在 Windows 上能跑，一搬到 Linux 就 Cannot find module）
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOTS = ['src', 'test', 'scripts', 'public'];
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

/* ---------- 大小写敏感性检查（Windows 能跑 / Linux 报错的那类问题） ---------- */

// 取相对 import 的模块名：from 'x'、import('x')、import 'x'
function importSpecifiers(code) {
  const out = new Set();
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) out.add(m[1]);
  }
  return [...out];
}

// 逐段和真实目录项比对，返回 {wrong, right} 或 {missing}
function resolveExactCase(fromFile, spec) {
  const parts = spec.split('/');
  let cur = dirname(fromFile);
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      cur = dirname(cur);
      continue;
    }
    let entries;
    try {
      entries = readdirSync(cur);
    } catch {
      return { missing: part };
    }
    if (!entries.includes(part)) {
      const alt = entries.find((e) => e.toLowerCase() === part.toLowerCase());
      return alt ? { wrong: part, right: alt, at: cur } : { missing: part, at: cur };
    }
    cur = join(cur, part);
  }
  return null;
}

const caseProblems = [];
for (const file of files) {
  const code = readFileSync(file, 'utf8');
  for (const spec of importSpecifiers(code)) {
    if (!spec.startsWith('.')) continue; // 包名 / node: 内置模块不查
    const bad = resolveExactCase(file, spec);
    if (bad) caseProblems.push({ file, spec, ...bad });
  }
}

// HTML 里引用的本地文件（src= / href=）也查一遍
for (const html of ROOTS.flatMap((root) => {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.html'))
      .map((e) => join(root, e.name));
  } catch {
    return [];
  }
})) {
  const code = readFileSync(html, 'utf8');
  for (const m of code.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    const ref = m[1];
    if (!ref || ref.startsWith('/') || /^[a-z]+:/i.test(ref) || ref.startsWith('#')) continue;
    const bad = resolveExactCase(html, `./${ref}`);
    if (bad) caseProblems.push({ file: html, spec: ref, ...bad });
  }
}

// 只差大小写的重名路径：Linux 上会互相覆盖
const byLower = new Map();
for (const root of [...ROOTS, 'data']) {
  for (const file of walk(root)) {
    const key = file.toLowerCase();
    if (!byLower.has(key)) byLower.set(key, []);
    byLower.get(key).push(file);
  }
}
const collisionProblems = [...byLower.values()].filter((group) => new Set(group).size > 1);

if (caseProblems.length) {
  failed += caseProblems.length;
  for (const p of caseProblems) {
    const shown = relative(process.cwd(), p.file) || p.file;
    const detail = p.wrong
      ? `大小写不一致：写的是「${p.wrong}」，真实文件名是「${p.right}」（Linux 上会找不到模块）`
      : `找不到：${p.missing}`;
    console.error(`✗ ${shown} → ${p.spec}  ${detail}`);
  }
}

if (collisionProblems.length) {
  failed += collisionProblems.length;
  for (const group of collisionProblems) {
    console.error(`✗ 只差大小写的重名文件：${group.join(' / ')}（Windows 上会互相覆盖）`);
  }
}

if (caseProblems.length === 0 && collisionProblems.length === 0) {
  console.log(`跨平台检查：import 路径大小写、重名文件都正常（Windows / Linux 都能跑）`);
}

process.exit(failed === 0 ? 0 : 1);
