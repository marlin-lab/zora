/*
 * store.js —— 指标与待办的「文件即数据库」层
 *
 * 真相在磁盘上，全部是能手改、能 git diff 的纯文本：
 *
 *   data/records/2026-11.md
 *     # 记录 2026-11
 *     - 11.24 | weight=66 | sleep=69 | hours=5.2 | deep=26 | steps=3841
 *             | arm=24.5 | waist=81 | ... | doing=练字 | meal=午餐:720:两个鸡腿+米饭
 *
 *   data/todos.md
 *     # 待办
 *     - [ ] 两篇论文 | term=short | due=2026-11-30 | note=
 *
 *   data/metrics.json      指标字典（单位/参考区间/看板开关）
 *   data/prefs.json        界面偏好
 *
 * 解析规则：一行一条，字段以 `|` 分隔，字段内 `key=value`。
 * 值里出现 `|` 会被替换成全角；空值跳过，不写垃圾。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const REC_DIR = path.join(DATA_DIR, 'records');
const TODO_FILE = path.join(DATA_DIR, 'todos.md');
const METRIC_FILE = path.join(DATA_DIR, 'metrics.json');
const PREF_FILE = path.join(DATA_DIR, 'prefs.json');

const BODY_KEYS = ['arm', 'waist', 'calf', 'thigh', 'under', 'bust', 'hip'];
const NUM_KEYS = ['weight', 'sleep', 'hours', 'deep', 'steps', 'cal', 'study', 'hobby', 'relax'].concat(BODY_KEYS);
const TEXT_KEYS = ['morning', 'mood', 'doing', 'review'];

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function safeVal(v) {
  return String(v == null ? '' : v).replace(/\|/g, '｜').replace(/\r?\n/g, ' ').trim();
}

function pad2(n) { return String(n).length < 2 ? '0' + n : String(n); }

/* ---------- 日期 ---------- */

// '2026-11-24' -> '11.24'
function shortDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  return m ? `${+m[2]}.${+m[3]}` : '';
}

// '11.24' + 年 -> '2026-11-24'
function fullDate(short, year) {
  const m = /^(\d{1,2})\.(\d{1,2})$/.exec(String(short || '').trim());
  if (!m) return '';
  return `${year}-${pad2(m[1])}-${pad2(m[2])}`;
}

/* ---------- 单条记录 <-> 一行文本 ---------- */

function recordToLine(r) {
  const parts = [shortDate(r.date)];
  for (const k of NUM_KEYS) {
    const v = r[k] != null && r[k] !== '' ? Number(r[k]) : null;
    if (v !== null && !Number.isNaN(v)) parts.push(k + '=' + v);
  }
  // 兼容旧的嵌套结构（sleep.score / body.arm / scores.study）
  if (r.sleep && r.sleep.score != null && r.sleep.score !== '') parts.push('sleep=' + r.sleep.score);
  if (r.sleep && r.sleep.hours != null && r.sleep.hours !== '') parts.push('hours=' + r.sleep.hours);
  if (r.sleep && r.sleep.deep != null && r.sleep.deep !== '') parts.push('deep=' + r.sleep.deep);
  if (r.body) for (const k of BODY_KEYS) if (r.body[k] != null && r.body[k] !== '') parts.push(k + '=' + r.body[k]);
  if (r.scores) for (const k of ['study', 'hobby', 'relax']) if (r.scores[k] != null && r.scores[k] !== '') parts.push(k + '=' + r.scores[k]);
  for (const k of TEXT_KEYS) { const v = safeVal(r[k]); if (v) parts.push(k + '=' + v); }
  (r.meals || []).forEach(m => {
    if (!m) return;
    const name = safeVal(m.name), kcal = m.kcal != null ? m.kcal : '', desc = safeVal(m.desc);
    const sc = (m.score != null && m.score !== '') ? ':' + m.score : '';
    if (name || desc) parts.push('meal=' + name + ':' + kcal + ':' + desc + sc);
  });
  // 同 key 后写覆盖；meal 是多值，保留全部
  const kept = {}, meals = [];
  parts.slice(1).forEach(p => {
    const k = p.split('=')[0];
    if (k === 'meal') { if (!meals.includes(p)) meals.push(p); return; }
    kept[k] = p;
  });
  const tail = Object.keys(kept).map(k => kept[k]).concat(meals);
  return '- ' + parts[0] + ' | ' + tail.join(' | ');
}

function lineToRecord(line, year) {
  const t = String(line || '').replace(/^\s*-\s*/, '').trim();
  if (!t) return null;
  const fields = t.split('|');
  const head = fields.shift().trim();
  const date = fullDate(head, year);
  if (!date) return null;
  const r = {
    date,
    weight: null, steps: null, cal: null,
    sleep: { score: null, hours: null, deep: null },
    body: { arm: null, waist: null, calf: null, thigh: null, under: null, bust: null, hip: null },
    scores: { study: null, hobby: null, relax: null },
    morning: '', mood: '', doing: '', review: '', meals: []
  };
  fields.forEach(f => {
    const i = f.indexOf('=');
    if (i < 0) return;
    const k = f.slice(0, i).trim(), v = f.slice(i + 1).trim();
    if (!k) return;
    if (k === 'meal') {
      const seg = v.split(':');
      const name = (seg[0] || '').trim(), kcal = seg[1];
      let tail = seg.slice(2), score = null;
      if (tail.length >= 2 && /^\d{1,3}$/.test(String(tail[tail.length - 1]).trim())) {
        score = Number(tail[tail.length - 1].trim());
        tail = tail.slice(0, -1);
      }
      const desc = tail.join(':').trim();
      if (name || desc) r.meals.push({ name, kcal: kcal ? Number(kcal) : null, desc, score });
      return;
    }
    if (NUM_KEYS.includes(k)) {
      const n = Number(v);
      if (v !== '' && !Number.isNaN(n)) {
        if (k === 'sleep') r.sleep.score = n;
        else if (k === 'hours') r.sleep.hours = n;
        else if (k === 'deep') r.sleep.deep = n;
        else if (BODY_KEYS.includes(k)) r.body[k] = n;
        else if (['study', 'hobby', 'relax'].includes(k)) r.scores[k] = n;
        else r[k] = n;
      }
      return;
    }
    if (TEXT_KEYS.includes(k)) r[k] = v;
  });
  return r;
}

/* ---------- 记录读写 ---------- */

function listRecordFiles() {
  ensureDir(REC_DIR);
  let names = [];
  try { names = fs.readdirSync(REC_DIR).filter(n => /^\d{4}-\d{2}\.md$/.test(n)); } catch { }
  return names.sort();
}

function readAllRecords() {
  const out = [];
  for (const name of listRecordFiles()) {
    const ym = name.replace('.md', '');
    const year = ym.slice(0, 4);
    let text = '';
    try { text = fs.readFileSync(path.join(REC_DIR, name), 'utf8'); } catch { continue; }
    text.split(/\r?\n/).forEach(line => {
      const r = lineToRecord(line, year);
      if (r) out.push(r);
    });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

// 整包重写：按月份分文件，空月份的文件删掉
function writeAllRecords(records) {
  ensureDir(REC_DIR);
  const byMonth = {};
  (records || []).forEach(r => {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) return;
    const ym = r.date.slice(0, 7);
    (byMonth[ym] = byMonth[ym] || []).push(r);
  });
  const oldFiles = listRecordFiles();
  for (const ym of Object.keys(byMonth)) {
    const rows = byMonth[ym].sort((a, b) => (a.date < b.date ? -1 : 1));
    const body = '# 记录 ' + ym + '\n\n' + rows.map(recordToLine).join('\n') + '\n';
    fs.writeFileSync(path.join(REC_DIR, ym + '.md'), body, 'utf8');
  }
  oldFiles.forEach(name => {
    if (!byMonth[name.replace('.md', '')]) {
      try { fs.unlinkSync(path.join(REC_DIR, name)); } catch { }
    }
  });
  return Object.keys(byMonth);
}

function upsertRecord(record) {
  const all = readAllRecords();
  const i = all.findIndex(r => r.date === record.date);
  if (i >= 0) all[i] = record; else all.push(record);
  writeAllRecords(all);
  return all;
}

function deleteRecord(date) {
  const all = readAllRecords().filter(r => r.date !== date);
  writeAllRecords(all);
  return all;
}

/* ---------- 待办 ---------- */

function readTodos() {
  let text = '';
  try { text = fs.readFileSync(TODO_FILE, 'utf8'); } catch { return []; }
  const out = [];
  text.split(/\r?\n/).forEach(line => {
    const m = /^\s*-\s*\[( |x|X)\]\s*(.*)$/.exec(line);
    if (!m) return;
    const done = m[1].toLowerCase() === 'x';
    const rest = m[2];
    const segs = rest.split('|').map(s => s.trim());
    const text0 = segs.shift() || '';
    const t = { text: text0, term: 'short', due: '', note: '', done };
    segs.forEach(s => {
      const i = s.indexOf('=');
      if (i < 0) return;
      const k = s.slice(0, i).trim(), v = s.slice(i + 1).trim();
      if (k === 'term') t.term = v || 'short';
      else if (k === 'due') t.due = v;
      else if (k === 'note') t.note = v;
    });
    out.push(t);
  });
  return out;
}

function writeTodos(todos) {
  const lines = (todos || []).filter(Boolean).map(t => {
    const segs = [safeVal(t.text)];
    if (t.term) segs.push('term=' + safeVal(t.term));
    if (t.due) segs.push('due=' + safeVal(t.due));
    if (t.note) segs.push('note=' + safeVal(t.note));
    return '- [' + (t.done ? 'x' : ' ') + '] ' + segs.join(' | ');
  });
  const body = '# 待办\n\n' + lines.join('\n') + '\n';
  ensureDir(DATA_DIR);
  fs.writeFileSync(TODO_FILE, body, 'utf8');
  return lines.length;
}

/* ---------- 指标字典 / 偏好 ---------- */

const DEFAULT_METRICS = [
  { key: 'sleep', label: '睡眠评分', unit: '分', group: '睡眠', min: 0, max: 100, show: true },
  { key: 'hours', label: '睡眠时长', unit: 'h', group: '睡眠', min: 0, max: 14, show: true },
  { key: 'deep', label: '深睡占比', unit: '%', group: '睡眠', min: 0, max: 60, show: true },
  { key: 'weight', label: '体重', unit: 'kg', group: '身体', min: 40, max: 90, show: true },
  { key: 'steps', label: '步数', unit: '步', group: '运动', min: 0, max: 30000, show: true },
  { key: 'cal', label: '热量', unit: 'kcal', group: '饮食', min: 0, max: 5000, show: true },
  { key: 'waist', label: '腰围', unit: 'cm', group: '围度', min: 50, max: 120, show: false },
  { key: 'arm', label: '小臂', unit: 'cm', group: '围度', min: 15, max: 40, show: false },
  { key: 'calf', label: '小腿', unit: 'cm', group: '围度', min: 20, max: 50, show: false },
  { key: 'thigh', label: '大腿', unit: 'cm', group: '围度', min: 30, max: 80, show: false },
  { key: 'under', label: '下胸围', unit: 'cm', group: '围度', min: 55, max: 110, show: false },
  { key: 'bust', label: '胸围', unit: 'cm', group: '围度', min: 60, max: 130, show: false },
  { key: 'hip', label: '臀围', unit: 'cm', group: '围度', min: 60, max: 130, show: false },
  { key: 'study', label: '学习深度', unit: '分', group: '状态', min: 0, max: 100, show: true },
  { key: 'hobby', label: '爱好投入', unit: '分', group: '状态', min: 0, max: 100, show: false },
  { key: 'relax', label: '放松度', unit: '分', group: '状态', min: 0, max: 100, show: false }
];

function readMetrics() {
  try {
    const j = JSON.parse(fs.readFileSync(METRIC_FILE, 'utf8'));
    if (Array.isArray(j) && j.length) return j;
  } catch { }
  return DEFAULT_METRICS.slice();
}

function writeMetrics(list) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(METRIC_FILE, JSON.stringify(list || [], null, 2), 'utf8');
  return (list || []).length;
}

function readPrefs() {
  try { return JSON.parse(fs.readFileSync(PREF_FILE, 'utf8')) || {}; } catch { return {}; }
}

function writePrefs(obj) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(PREF_FILE, JSON.stringify(obj || {}, null, 2), 'utf8');
  return true;
}

module.exports = {
  ROOT, DATA_DIR, REC_DIR, TODO_FILE,
  shortDate, fullDate,
  readAllRecords, writeAllRecords, upsertRecord, deleteRecord,
  readTodos, writeTodos,
  readMetrics, writeMetrics, DEFAULT_METRICS,
  readPrefs, writePrefs
};
