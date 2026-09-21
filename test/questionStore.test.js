// 题目库单元测试（不联网、不碰真实 data/questions.json）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuestionStore } from '../src/game/QuestionStore.js';

async function tempStore(content) {
  const dir = await mkdtemp(join(tmpdir(), 'turtle-soup-'));
  const file = join(dir, 'questions.json');
  if (content !== undefined) await writeFile(file, content, 'utf8');
  return { dir, file, store: new QuestionStore({ file }) };
}

const SAMPLE = JSON.stringify([
  { id: 1, title: '一', puzzle: '汤面1', answer: '汤底1' },
  { id: 2, title: '二', puzzle: '汤面2', answer: '汤底2' },
  { id: 3, title: '三', puzzle: '汤面3', answer: '汤底3' },
]);

test('首次 next() 返回第 1 题，不会跳过（回归 off-by-one）', async () => {
  const { store } = await tempStore(SAMPLE);
  await store.load();
  assert.equal(store.count, 3);
  assert.equal(store.next().id, 1);
  assert.equal(store.next().id, 2);
  assert.equal(store.next().id, 3);
  // 循环回绕
  assert.equal(store.next().id, 1);
});

test('current() 在未选题时为 null', async () => {
  const { store } = await tempStore(SAMPLE);
  await store.load();
  assert.equal(store.current(), null);
});

test('goto() 按 id 定位，未知 id 返回 null', async () => {
  const { store } = await tempStore(SAMPLE);
  await store.load();
  assert.equal(store.goto(2).id, 2);
  assert.equal(store.current().id, 2);
  assert.equal(store.goto(99), null);
});

test('文件不存在时是空库，next() 返回 null', async () => {
  const { store } = await tempStore(undefined);
  await store.load();
  assert.equal(store.count, 0);
  assert.equal(store.next(), null);
});

test('import() 落盘且 id 递增，重新加载可读回', async () => {
  const { file, store } = await tempStore('[]');
  await store.load();
  const added = await store.import([{ title: '新题', puzzle: ' 汤面 ', answer: ' 汤底 ' }]);
  assert.equal(added, 1);
  assert.equal(store.next().title, '新题');

  const reloaded = new QuestionStore({ file });
  await reloaded.load();
  assert.equal(reloaded.count, 1);
  assert.equal(reloaded.goto(1).puzzle, '汤面'); // 已 trim
});

test('import() 跳过缺字段的条目', async () => {
  const { store } = await tempStore('[]');
  await store.load();
  const added = await store.import([
    { puzzle: '有汤面无汤底' },
    { puzzle: '完整', answer: '完整' },
  ]);
  assert.equal(added, 1);
  // 被跳过的条目不占用 id，默认标题用的是分配到的 id
  assert.equal(store.next().id, 1);
  assert.equal(store.next().title, '题目 #1');
});

test('save() 不残留临时文件，可覆盖写入', async () => {
  const { dir, store } = await tempStore('[]');
  await store.load();
  await store.import([{ puzzle: 'a', answer: 'a' }]);
  await store.import([{ puzzle: 'b', answer: 'b' }]);
  const names = await readdir(dir);
  assert.deepEqual(names, ['questions.json']);
  const parsed = JSON.parse(await readFile(join(dir, 'questions.json'), 'utf8'));
  assert.equal(parsed.length, 2);
});

test('题目库损坏时：备份原文件、空库启动、后续导入不丢备份', async () => {
  const { dir, file, store } = await tempStore('{ 这不是合法 JSON');
  await store.load();

  assert.equal(store.count, 0);
  assert.ok(store.loadError, '应记录 loadError');

  const backups = (await readdir(dir)).filter((n) => n.includes('.corrupt-') && n.endsWith('.bak'));
  assert.equal(backups.length, 1, '应生成一份备份');
  assert.equal(await readFile(join(dir, backups[0]), 'utf8'), '{ 这不是合法 JSON');

  // 后续导入会重写 questions.json，但备份内容必须原样保留
  await store.import([{ puzzle: '新汤面', answer: '新汤底' }]);
  assert.equal(await readFile(join(file), 'utf8').then((s) => JSON.parse(s).length), 1);
  assert.equal(await readFile(join(dir, backups[0]), 'utf8'), '{ 这不是合法 JSON');
});

test('顶层不是数组时同样按损坏处理', async () => {
  const { dir, store } = await tempStore('{"foo": 1}');
  await store.load();
  assert.equal(store.count, 0);
  assert.ok(store.loadError);
  assert.ok((await readdir(dir)).some((n) => n.includes('.corrupt-')));
});

test('加载时会跳过不合法条目并重新编号缺失 id', async () => {
  const { store } = await tempStore(
    JSON.stringify([{ puzzle: 'x', answer: 'y' }, { title: '缺汤底' }, { puzzle: 'p', answer: 'a' }]),
  );
  await store.load();
  assert.equal(store.count, 2);
  assert.deepEqual(
    store.list().map((q) => q.id),
    [1, 2],
  );
});

test('update() 修改单题并落盘，空汤底会被拒绝', async () => {
  const { file, store } = await tempStore(SAMPLE);
  await store.load();

  const updated = await store.update(2, { title: '二（改）', puzzle: '新汤面' });
  assert.equal(updated.title, '二（改）');
  assert.equal(updated.puzzle, '新汤面');
  assert.equal(updated.answer, '汤底2', '未提供的字段应保持原值');

  await assert.rejects(() => store.update(2, { answer: '   ' }), /不能为空/);
  assert.equal(await store.update(999, {}), null);

  const reloaded = new QuestionStore({ file });
  await reloaded.load();
  assert.equal(reloaded.get(2).puzzle, '新汤面');
});

test('remove() 删除单题并修正指针', async () => {
  const { store } = await tempStore(SAMPLE);
  await store.load();

  store.goto(3);
  assert.equal(await store.remove(3), true);
  assert.equal(store.count, 2);
  assert.equal(store.current().id, 2, '指针应回退到剩下的最后一题');
  assert.equal(await store.remove(999), false);
});

test('listAll() 返回完整题目副本', async () => {
  const { store } = await tempStore(SAMPLE);
  await store.load();
  const all = store.listAll();
  assert.equal(all[0].answer, '汤底1');
  all[0].answer = '被改坏了';
  assert.equal(store.questions[0].answer, '汤底1', '不应影响内部数据');
});
