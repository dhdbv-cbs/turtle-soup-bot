// 提交/推送前的敏感信息自查。
//
// 这个仓库是公开的，密钥一旦进了提交历史就删不干净，所以加一道机器检查：
//   1. 从 data/config.json（唯一存放密钥的地方）取出所有真实密钥值
//   2. 拿这些值去比对“将要提交的文件”和“已经入库的整个文件树”
//   3. 再用一组特征正则扫一遍常见的密钥写法
// 命中任一项就以非零退出码结束，方便卡在提交前。
//
// 用法：
//   npm run check:secrets                   # 待提交文件 + 已入库文件
//   npm run check:secrets -- --pending      # 只看待提交的（更快）
//   npm run check:secrets -- --staged       # 只看已 git add 的
//
// 注意：脚本只打印脱敏后的片段，绝不打印完整密钥。
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = join(ROOT, 'data', 'config.json');
const MAX_SCAN_BYTES = 2 * 1024 * 1024; // 超过 2MB 的文件不逐行扫（本项目没有这种文本）

// 会被当成密钥的配置字段名
const SECRET_KEY = /token|secret|password|passwd|api_?key|access_?key|credential/i;

// 常见密钥写法。severity=error 会让脚本失败，warn 只提示
const PATTERNS = [
  ['Discord 机器人 token', /[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27,}/g, 'error'],
  ['OpenAI 风格 API key', /sk-[A-Za-z0-9_-]{20,}/g, 'error'],
  ['Authorization 头里的密钥', /Bearer\s+[A-Za-z0-9._-]{30,}/g, 'error'],
  [
    '赋值式密钥',
    /(?:api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd)\s*[:=]\s*['"]([^'"\s]{16,})['"]/gi,
    'error',
  ],
  ['长十六进制串（可能是密钥或盐）', /\b[0-9a-f]{32,}\b/gi, 'warn'],
];

// 明显的占位符不算泄露（.env.example 里全是这种）
const PLACEHOLDER =
  /^(your|xxx+|placeholder|example|sample|dummy|fake|test|changeme|change[-_]?me|填入|示例|待填|<[^>]*>)/i;

// 未跟踪且没被忽略的文件里，名字像“配置文件”的：这类文件一旦 add 就危险。
// 只认真正的配置/凭据文件名，不是名字里带 secret 的源码（否则脚本自己就先中招）。
const RISKY_NAME =
  /(^|\/)(\.env(\..+)?|config[^/]*\.json|secrets?\.json|credentials?\.json|[^/]*\.(pem|key|p12|pfx))$/i;
// 这些是有意入库的模板，不算危险
const ALLOWED_RISKY = new Set(['.env.example']);

// 测试夹具里会写假密钥，加这行注释可以退出“特征扫描”。
// 注意：真实密钥反查不受影响，写真密钥照样拦得住。
const PATTERN_OPT_OUT = /check-secrets:\s*allow-pattern-hits/;

/** 未跟踪 + 没被忽略 + 名字像配置文件 → 最危险的一类，必须拦 */
export function isRiskyUntrackedName(relPath) {
  return RISKY_NAME.test(relPath) && !ALLOWED_RISKY.has(relPath);
}

/** 文件是否声明了退出特征扫描（真实密钥反查不受影响） */
export function shouldSkipPatternScan(text) {
  return PATTERN_OPT_OUT.test(text);
}

/** 从配置对象里递归收集所有疑似密钥的字符串字段 */
export function collectSecrets(node, prefix = 'config.') {
  const found = [];
  if (!node || typeof node !== 'object') return found;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      if (SECRET_KEY.test(key) && value.length >= 8) found.push({ where: `${prefix}${key}`, value });
    } else if (value && typeof value === 'object') {
      found.push(...collectSecrets(value, `${prefix}${key}.`));
    }
  }
  return found;
}

/** 脱敏显示：只露头尾，长度照实说 */
export function maskValue(value) {
  const text = String(value ?? '');
  if (text.length <= 6) return '*'.repeat(text.length);
  return `${text.slice(0, 3)}…${text.slice(-2)}（${text.length} 字符）`;
}

/** 在文本里找真实密钥（完整值或前 12 位，防止只贴了一半也算漏） */
export function findSecretsInText(text, secrets) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (const secret of secrets) {
    const head = secret.value.length >= 12 ? secret.value.slice(0, 12) : secret.value;
    lines.forEach((line, index) => {
      if (line.includes(secret.value) || line.includes(head)) {
        hits.push({ line: index + 1, where: secret.where });
      }
    });
  }
  return hits;
}

/** 用特征正则扫文本，返回脱敏后的命中列表 */
export function findPatternsInText(text) {
  const hits = [];
  for (const [name, pattern, severity] of PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      const hit = match[1] ?? match[0];
      if (PLACEHOLDER.test(hit)) continue;
      if (/^0{16,}$|^1{16,}$/.test(hit)) continue;
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      hits.push({ line, name, sample: maskValue(hit), severity });
    }
  }
  return hits;
}

/** 二进制或过大的文件不扫内容（本项目里就是图片之类） */
export function shouldSkipFile(relPath, { size, head }) {
  if (size > MAX_SCAN_BYTES) return '文件过大';
  if (head.includes(0)) return '二进制文件';
  return null;
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${(result.stderr || '').trim()}`);
  }
  return (result.stdout || '').split(/\r?\n/).filter(Boolean);
}

/** 待提交 = 已修改 + 已暂存 + 未跟踪（但没被 .gitignore 拦掉） */
function pendingFiles({ stagedOnly = false } = {}) {
  const list = stagedOnly
    ? git(['diff', '--cached', '--name-only'])
    : [
        ...git(['diff', '--name-only']),
        ...git(['diff', '--cached', '--name-only']),
        ...git(['ls-files', '--others', '--exclude-standard']),
      ];
  return [...new Set(list)].sort();
}

function main() {
  const argv = process.argv.slice(2);
  const stagedOnly = argv.includes('--staged');
  const pendingOnly = argv.includes('--pending') || stagedOnly;
  let problems = 0;
  let warnings = 0;

  console.log('敏感信息自查');
  console.log(`仓库：${ROOT}`);

  // 1. 真实密钥集合
  let secrets = [];
  if (existsSync(CONFIG_FILE)) {
    try {
      secrets = collectSecrets(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')));
    } catch (e) {
      console.log(`  ! data/config.json 读取失败（${e.message}），只做特征扫描`);
    }
  }
  if (secrets.length === 0) {
    console.log('本地没有可用的 data/config.json，只做特征扫描（fresh clone 的正常情况）');
  } else {
    console.log(`本地配置里有 ${secrets.length} 个密钥字段（下面只显示脱敏片段）：`);
    for (const secret of secrets) console.log(`  ${secret.where} → ${maskValue(secret.value)}`);
  }
  console.log('');

  // 2. 待提交文件
  let pending = [];
  let untracked = [];
  try {
    pending = pendingFiles({ stagedOnly });
    untracked = stagedOnly ? [] : git(['ls-files', '--others', '--exclude-standard']);
  } catch (e) {
    console.error(`× 取不到 git 文件列表：${e.message}`);
    process.exit(1);
  }
  console.log(`待提交文件 ${pending.length} 个${pendingOnly ? '（只看待提交）' : ''}，逐个扫描：`);

  // 未跟踪 + 没被忽略 + 名字像配置文件
  for (const rel of untracked) {
    if (isRiskyUntrackedName(rel)) {
      console.log(`  × ${rel}：名字像配置文件，而且在 .gitignore 之外，一旦 git add 就会被提交`);
      problems++;
    }
  }

  for (const rel of pending) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    const size = statSync(abs).size;
    const raw = readFileSync(abs);
    const skip = shouldSkipFile(rel, { size, head: raw.subarray(0, 4096) });
    if (skip) {
      console.log(`  - ${rel}：跳过（${skip}）`);
      continue;
    }
    const text = raw.toString('utf8');

    for (const hit of findSecretsInText(text, secrets)) {
      console.log(`  × ${rel}:${hit.line} 命中真实密钥（${hit.where}）`);
      problems++;
    }
    if (shouldSkipPatternScan(text)) {
      console.log(`  - ${rel}：声明了 allow-pattern-hits，跳过特征扫描（真实密钥反查仍然生效）`);
      continue;
    }
    for (const hit of findPatternsInText(text)) {
      const mark = hit.severity === 'error' ? '×' : '?';
      console.log(`  ${mark} ${rel}:${hit.line} 疑似${hit.name}：${hit.sample}`);
      if (hit.severity === 'error') problems++;
      else warnings++;
    }
  }
  console.log(`  待提交文件扫描完毕：${problems === 0 ? '没有敏感信息' : `${problems} 处需要处理`}`);

  // 3. 已入库的整棵树（防止历史里早就躺着密钥）
  if (!pendingOnly) {
    const tracked = git(['ls-files']);
    console.log(`\n已入库文件 ${tracked.length} 个，反查本地真实密钥：`);
    let treeHits = 0;
    for (const rel of tracked) {
      const abs = join(ROOT, rel);
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      if (statSync(abs).size > MAX_SCAN_BYTES) continue;
      const raw = readFileSync(abs);
      if (raw.subarray(0, 4096).includes(0)) continue;
      for (const hit of findSecretsInText(raw.toString('utf8'), secrets)) {
        console.log(`  × ${rel}:${hit.line} 命中真实密钥（${hit.where}）`);
        problems++;
        treeHits++;
      }
    }
    console.log(`  ${treeHits === 0 ? '干净：已入库文件里没有本地密钥' : `${treeHits} 处需要处理`}`);
  }

  // 4. 结论
  console.log('');
  if (problems > 0) {
    console.log(`结论：发现 ${problems} 处敏感信息，先处理再提交。`);
    console.log('提示：不要用 git add -A 一把梭，先 git check-ignore -v <文件> 确认。');
    process.exit(1);
  }
  console.log(
    `结论：可以安全提交 ✅${warnings > 0 ? `（另有 ${warnings} 处提示，请人工扫一眼）` : ''}`,
  );
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(process.argv[1]).href.toLowerCase() === import.meta.url.toLowerCase();
  } catch {
    return false;
  }
}

if (isDirectRun()) main();
