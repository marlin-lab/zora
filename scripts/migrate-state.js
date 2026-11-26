/*
 * 一次性迁移：state.json（旧的面板快照）→ data/ 里的 markdown
 * 跑法：node scripts/migrate-state.js
 * 安全：只写 data/records/*.md、data/todos.md、data/metrics.json、data/prefs.json，
 *      不动任何文章；state.json 原样保留作为备份。
 */
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'state.json');

function main() {
  if (!fs.existsSync(SRC)) { console.log('没有 state.json，跳过'); return; }
  const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const s = raw.state || raw;
  const report = [];

  if (Array.isArray(s.records) && s.records.length) {
    const months = store.writeAllRecords(s.records);
    report.push(`records: ${s.records.length} 条 -> ${months.join(', ')}.md`);
  } else {
    report.push('records: 空，跳过');
  }

  if (Array.isArray(s.todos) && s.todos.length) {
    const n = store.writeTodos(s.todos);
    report.push(`todos: ${n} 条 -> data/todos.md`);
  } else {
    report.push('todos: 空，跳过');
  }

  if (Array.isArray(s.metrics) && s.metrics.length) {
    store.writeMetrics(s.metrics);
    report.push(`metrics: ${s.metrics.length} 项 -> data/metrics.json`);
  }

  if (s.prefs && typeof s.prefs === 'object' && Object.keys(s.prefs).length) {
    store.writePrefs(s.prefs);
    report.push('prefs -> data/prefs.json');
  }

  // 回读校验：文件能重新解析成同样的条数
  const back = store.readAllRecords();
  report.push(`校验：回读 ${back.length} 条记录，${store.readTodos().length} 条待办`);

  console.log(report.join('\n'));
}

main();
