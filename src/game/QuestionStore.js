// 题目库：加载、按顺序出题、运行时导入
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, warn, error } from '../utils/logger.js';
import { stripBom } from '../utils/strings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_FILE = join(__dirname, '..', '..', 'data', 'questions.json');

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// 校验并规整单条题目，返回 null 表示该条不合法
function normalizeQuestion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const puzzle = typeof raw.puzzle === 'string' ? raw.puzzle.trim() : '';
  const answer = typeof raw.answer === 'string' ? raw.answer.trim() : '';
  if (!puzzle || !answer) return null;
  const id = Number(raw.id);
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  return {
    id: Number.isInteger(id) && id > 0 ? id : null,
    title,
    puzzle,
    answer,
  };
}

export class QuestionStore {
  #saveChain = Promise.resolve();
  #tmpSeq = 0;

  // file 可注入，便于测试时用临时文件，避免动到真实题库
  constructor({ file = DEFAULT_DATA_FILE } = {}) {
    this.file = file;
    this.questions = [];
    this.pointer = -1; // -1 表示还没选过题；next() 从第 0 题开始
    this.nextId = 1;
    this.loadError = null;
  }

  async load() {
    if (!existsSync(this.file)) {
      warn('题目库文件不存在，将创建空库：', this.file);
      this.questions = [];
      this.pointer = -1;
      this.nextId = 1;
      return;
    }

    let raw;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (e) {
      throw new Error(`题目库读取失败：${this.file}（${e.message}）`);
    }

    try {
      // 去掉记事本可能写入的 BOM，空文件按空库处理
      const text = stripBom(raw);
      const data = text.trim() === '' ? [] : JSON.parse(text);
      const list = Array.isArray(data) ? data : data?.questions;
      if (!Array.isArray(list)) {
        throw new Error('顶层结构必须是题目数组，或 { "questions": [...] }');
      }
      this.#adopt(list);
      return;
    } catch (e) {
      // 解析失败绝不静默：先把原文件备份下来，再以空库启动。
      // 否则后续任何一次 import() 的 save() 都会把坏文件覆盖掉，题目全部丢失。
      const backup = `${this.file}.corrupt-${timestamp()}.bak`;
      try {
        await copyFile(this.file, backup);
      } catch (copyErr) {
        error('备份损坏的题目库失败：', copyErr.message);
      }
      error(`题目库解析失败：${e.message}`);
      error(`原文件已备份到：${backup}`);
      error('当前以空库启动。请修复该文件后重启，或通过后台 API 重新导入题目。');
      this.questions = [];
      this.pointer = -1;
      this.nextId = 1;
      this.loadError = e.message;
    }
  }

  #adopt(list) {
    const valid = [];
    let skipped = 0;
    for (const item of list) {
      const q = normalizeQuestion(item);
      if (q) valid.push(q);
      else skipped++;
    }
    let nextId = 1;
    for (const q of valid) {
      if (q.id === null) q.id = nextId++;
      else nextId = Math.max(nextId, q.id + 1);
    }
    this.questions = valid;
    this.pointer = -1;
    this.nextId = nextId;
    log(`题目库加载完成：共 ${this.questions.length} 题${skipped ? `（跳过 ${skipped} 条不合法数据）` : ''}`);
  }

  // 原子写入：先写临时文件再 rename 替换，避免写到一半崩溃把题库写坏
  //
  // 并发兜底：写入串行化 + 临时文件名唯一。
  // 后台界面两个标签页同时改题、或导入与删除撞在一起时，固定临时文件名会互相顶掉，
  // 后一个 rename 直接 ENOENT 报错（甚至写坏文件），所以这里排队写、每次换名字。
  save() {
    const run = this.#saveChain.then(
      () => this.#writeNow(),
      () => this.#writeNow(),
    );
    // 保存失败不能毒化后续的保存
    this.#saveChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async #writeNow() {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${++this.#tmpSeq}`;
    try {
      await writeFile(tmp, `${JSON.stringify(this.questions, null, 2)}\n`, 'utf8');
      await rename(tmp, this.file);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }

  // 批量导入题目（每道需含 puzzle 和 answer，title 可选）
  async import(items) {
    if (!Array.isArray(items)) throw new Error('导入数据必须是数组');
    let added = 0;
    for (const item of items) {
      const puzzle = typeof item?.puzzle === 'string' ? item.puzzle.trim() : '';
      const answer = typeof item?.answer === 'string' ? item.answer.trim() : '';
      if (!puzzle || !answer) continue;
      const title =
        typeof item.title === 'string' && item.title.trim() ? item.title.trim() : `题目 #${this.nextId}`;
      this.questions.push({ id: this.nextId++, title, puzzle, answer });
      added++;
    }
    await this.save();
    log(`导入题目：新增 ${added} 题，当前共 ${this.questions.length} 题`);
    return added;
  }

  // 当前已选中的题目；还没选过则为 null
  current() {
    if (this.pointer < 0 || this.pointer >= this.questions.length) return null;
    return this.questions[this.pointer];
  }

  // 下一题（按顺序循环）。首次调用返回第 1 题，不会跳过。
  next() {
    if (this.questions.length === 0) return null;
    this.pointer = this.pointer < 0 ? 0 : (this.pointer + 1) % this.questions.length;
    return this.current();
  }

  // 跳到指定 id
  goto(id) {
    const idx = this.questions.findIndex((q) => q.id === Number(id));
    if (idx < 0) return null;
    this.pointer = idx;
    return this.current();
  }

  list() {
    return this.questions.map((q) => ({ id: q.id, title: q.title }));
  }

  get count() {
    return this.questions.length;
  }

  // 按 id 取单题
  get(id) {
    return this.questions.find((q) => q.id === Number(id)) ?? null;
  }

  // 完整题目列表（含汤面/汤底，后台界面与导出用）
  listAll() {
    return this.questions.map((q) => ({ ...q }));
  }

  // 修改单题（后台界面用）
  async update(id, patch = {}) {
    const q = this.get(id);
    if (!q) return null;

    const puzzle = patch.puzzle === undefined ? q.puzzle : String(patch.puzzle ?? '').trim();
    const answer = patch.answer === undefined ? q.answer : String(patch.answer ?? '').trim();
    const title = patch.title === undefined ? q.title : String(patch.title ?? '').trim();
    if (!puzzle || !answer) throw new Error('汤面与汤底都不能为空');

    q.puzzle = puzzle;
    q.answer = answer;
    q.title = title || q.title;
    await this.save();
    return q;
  }

  // 删除单题
  async remove(id) {
    const idx = this.questions.findIndex((q) => q.id === Number(id));
    if (idx < 0) return false;
    this.questions.splice(idx, 1);
    if (this.pointer >= this.questions.length) this.pointer = this.questions.length - 1;
    await this.save();
    return true;
  }
}
