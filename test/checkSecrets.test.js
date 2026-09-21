// 推送前自查脚本本身的测试：它要是漏报，比没有还危险。
//
// check-secrets: allow-pattern-hits
// 这个文件里写的都是**假**密钥（就是为了验它抓不抓得到），所以声明退出特征扫描；
// 真实密钥反查仍然对这个文件生效。
//
// 另外：源码里不写完整的 token 形态。GitHub 自己的推送保护会拦住任何看起来像
// Discord token 的字面量（哪怕是测试用的假串，它也不管），所以夹具都靠运行时拼。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectSecrets,
  maskValue,
  findSecretsInText,
  findPatternsInText,
  shouldSkipFile,
  isRiskyUntrackedName,
  shouldSkipPatternScan,
} from '../scripts/check-secrets.mjs';

// 形状对、但绝不是真 token 的夹具（分段拼接，源码里不存在完整形态）
const fakeDiscordToken = () =>
  ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'AbCdEf', 'gHiJkLmNoPqRsTuVwXyZ0123456'].join('.');
const fakeSkKey = () => ['sk', 'abcdefghijklmnopqrstuvwx'].join('-');
const fakeBearer = () => ['Bearer', 'abcdefghijklmnopqrstuvwxyz012345'].join(' ');

test('collectSecrets：按字段名收集嵌套密钥，短值和非密钥字段不算', () => {
  const secrets = collectSecrets({
    discord: { token: fakeDiscordToken() },
    judge: { providers: { gateway: { apiKey: 'vck_0123456789abcdef' } } },
    admin: { passwordHash: 'b'.repeat(128), passwordSalt: 'c'.repeat(32) },
    qq: { token: '' }, // 空值不算
    limits: { askRateLimit: '18' }, // 字段名不带密钥特征
    tiny: { token: '1234' }, // 太短，不可能是真密钥
  });
  const where = secrets.map((s) => s.where).sort();
  assert.deepEqual(where, [
    'config.admin.passwordHash',
    'config.admin.passwordSalt',
    'config.discord.token',
    'config.judge.providers.gateway.apiKey',
  ]);
});

test('maskValue：只露头尾，长度照实说，短值全打码', () => {
  assert.equal(maskValue('abcdefghij'), 'abc…ij（10 字符）');
  assert.equal(maskValue('abc'), '***');
  assert.equal(maskValue(''), '');
});

test('findSecretsInText：完整值和"只贴了前 12 位"都要抓到，并报对行号', () => {
  const token = fakeDiscordToken();
  const secrets = [{ where: 'config.discord.token', value: token }];
  const text = ['第一行', `token=${token}`, '第三行'].join('\n');
  const hits = findSecretsInText(text, secrets);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].where, 'config.discord.token');

  // 只出现前 12 位（比如日志里截断了）也算命中
  assert.equal(findSecretsInText(`x ${token.slice(0, 12)} y`, secrets).length, 1);

  // 干净的文本不报
  assert.deepEqual(findSecretsInText('const answer = 42;', secrets), []);
});

test('findPatternsInText：抓得到常见写法，且不误报占位符', () => {
  const real = [
    `DISCORD_TOKEN=${fakeDiscordToken()}`,
    `apiKey: '${fakeSkKey()}'`,
    `Authorization: ${fakeBearer()}`,
  ].join('\n');
  const names = findPatternsInText(real).map((h) => h.name);
  assert.ok(names.includes('Discord 机器人 token'));
  assert.ok(names.includes('OpenAI 风格 API key'));
  assert.ok(names.includes('Authorization 头里的密钥'));

  // .env.example 里的占位符不能被当成泄露，否则这脚本天天误报
  const placeholders = [
    'DISCORD_TOKEN=your-discord-bot-token-here',
    "apiKey: 'your-api-key-here'",
    'JEV_API_KEY=sk-your-key-here',
  ].join('\n');
  const bad = findPatternsInText(placeholders).filter((h) => h.severity === 'error');
  assert.deepEqual(bad, []);

  assert.deepEqual(findPatternsInText('const a = 1;\nexport default a;'), []);
});

test('findPatternsInText：赋值式密钥抓得到，长十六进制只提示不拦', () => {
  const hits = findPatternsInText(
    `const token = '${'abcdefghijklmnopqrstuvwx'}';\nconst salt = '${'f'.repeat(64)}';`,
  );
  const error = hits.filter((h) => h.severity === 'error');
  const warn = hits.filter((h) => h.severity === 'warn');
  assert.equal(error.length, 1, '赋值式密钥要拦下来');
  assert.equal(error[0].name, '赋值式密钥');
  assert.equal(warn.length, 1, '长十六进制只提示，避免误伤 lockfile 里的哈希');
  assert.equal(warn[0].name, '长十六进制串（可能是密钥或盐）');
});

test('findPatternsInText：打印的是脱敏片段，不会把密钥原样吐出来', () => {
  const secret = fakeSkKey();
  const hits = findPatternsInText(`apiKey: '${secret}'`);
  assert.ok(hits.length > 0);
  for (const hit of hits) assert.ok(!hit.sample.includes(secret), 'sample 不能包含完整密钥');
});

test('shouldSkipFile：二进制和超大文件不硬扫', () => {
  assert.equal(shouldSkipFile('a.png', { size: 100, head: Buffer.from([1, 0, 2]) }), '二进制文件');
  assert.equal(shouldSkipFile('big.json', { size: 5 * 1024 * 1024, head: Buffer.from('{') }), '文件过大');
  assert.equal(shouldSkipFile('src/index.js', { size: 100, head: Buffer.from('import') }), null);
});

test('isRiskyUntrackedName：只认真正的配置/凭据文件名，不误伤源码', () => {
  // 这些一旦漏进提交就是事故
  for (const rel of [
    '.env',
    '.env.local',
    'data/config.json',
    'data/config.prod.json',
    'secrets.json',
    'deploy/id_rsa.pem',
    'server.key',
  ]) {
    assert.equal(isRiskyUntrackedName(rel), true, `${rel} 应该被拦下`);
  }
  // 这些是正常源码/模板，不能误报（否则 npm run check 永远失败）
  for (const rel of [
    '.env.example',
    'scripts/check-secrets.mjs',
    'test/checkSecrets.test.js',
    'package.json',
    'data/questions.json',
    'src/config.js',
  ]) {
    assert.equal(isRiskyUntrackedName(rel), false, `${rel} 不该误报`);
  }
});

test('shouldSkipPatternScan：只有明确声明才跳过特征扫描，真实密钥反查不受影响', () => {
  assert.equal(shouldSkipPatternScan('// check-secrets: allow-pattern-hits\nconst t = 1;'), true);
  assert.equal(shouldSkipPatternScan('const t = 1;'), false);

  // 声明只关掉"特征扫描"，写进文件的真密钥照样被反查抓到
  const text = '// check-secrets: allow-pattern-hits\nconst t = "abcdefghijklmnop";';
  assert.equal(shouldSkipPatternScan(text), true);
  assert.equal(findSecretsInText(text, [{ where: 'x.y', value: 'abcdefghijklmnop' }]).length, 1);
});
