/*
 * 个人系统 · 本地服务端（零依赖，纯 Node.js）
 *
 * 架构（参考 SilverBullet 的「文件即库」+ Trilium 的「可重建索引」）：
 *   data/**.md          ← 唯一真相：文章、小记
 *   data/records/*.md   ← 唯一真相：每天的指标（一行一天，可手改、可 diff）
 *   data/todos.md       ← 唯一真相：待办
 *   data/metrics.json   ← 指标字典（单位 / 参考区间 / 看板开关）
 *   data/.index.json    ← 缓存（删掉自动重建）
 *
 * 写完文件 → 失效索引 → 通过 SSE 广播，前端各视图实时刷新。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const store = require('./lib/store');
const indexer = require('./lib/indexer');

const ROOT = __dirname;
const DATA_DIR = store.DATA_DIR;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEFAULT_PORT = 8686;
const TEXT_EXT = ['.md', '.txt', '.markdown'];

/* ---------------- 基础工具 ---------------- */

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function safeDataPath(rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(DATA_DIR, clean);
  if (abs !== path.resolve(DATA_DIR) && !abs.startsWith(path.resolve(DATA_DIR) + path.sep)) return null;
  return abs;
}

function sanitizeName(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function sanitizeRel(p) { return String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); }

function isTextFile(name) { return TEXT_EXT.includes(path.extname(name).toLowerCase()); }

function readTitle(file) { return file.replace(/\.(md|txt|markdown)$/i, ''); }

function statSafe(p) { try { return fs.statSync(p); } catch { return null; } }

function uniquePath(abs) {
  if (!statSafe(abs)) return abs;
  const ext = path.extname(abs);
  const base = abs.slice(0, abs.length - ext.length);
  for (let i = 2; i < 999; i++) {
    const cand = `${base}(${i})${ext}`;
    if (!statSafe(cand)) return cand;
  }
  return null;
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 50 * 1024 * 1024) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* 按文件名里的日期排（10.4 / 4.9.2 / 小记-2026-11-26），认不出日期的排到最后 */
function nameDateKey(name) {
  const base = name.replace(/\.md$/i, '');
  let m = base.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{1,2}))?/);
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10), m[3] ? parseInt(m[3], 10) : 0];
  m = base.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return [parseInt(m[2], 10), parseInt(m[3], 10), 0];
  return [99, 99, 0];
}
function cmpByDate(a, b) {
  const A = nameDateKey(a.name), B = nameDateKey(b.name);
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] - B[i];
  return String(a.name).localeCompare(String(b.name), 'zh');
}
/* ---------------- 最后修改时间（存在本地的 .editmeta.json） ---------------- */

const EDIT_META = path.join(DATA_DIR, '.editmeta.json');
let _metaCache = null, _metaStamp = -1;
function readEditMeta() {
  const st = statSafe(EDIT_META);
  const stamp = st ? st.mtimeMs : 0;
  if (_metaCache && _metaStamp === stamp) return _metaCache;
  try { _metaCache = JSON.parse(fs.readFileSync(EDIT_META, 'utf8')) || {}; } catch { _metaCache = {}; }
  _metaStamp = stamp;
  return _metaCache;
}
function writeEditMeta(map) {
  _metaCache = map;
  fs.writeFileSync(EDIT_META, JSON.stringify(map), 'utf8');
  const st = statSafe(EDIT_META);
  _metaStamp = st ? st.mtimeMs : 0;
}
function touchEditMeta(rel) {
  const key = String(rel).replace(/\\/g, '/');
  const m = readEditMeta();
  m[key] = Date.now();
  writeEditMeta(m);
}
function dropEditMeta(rel) {
  const key = String(rel).replace(/\\/g, '/');
  const m = readEditMeta();
  if (key in m) { delete m[key]; writeEditMeta(m); }
}
function nameDateMs(name) {
  const k = nameDateKey(name);
  if (k[0] === 99) return 0;
  return Date.UTC(2026, k[0] - 1, k[1], 12, 0, 0) + k[2] * 1000;
}
/* ---------------- 目录树 / 分区 ---------------- */

function scanDir(absDir, relDir) {
  const out = { name: relDir ? path.basename(relDir) : '我的知识库', path: relDir || '', folders: [], articles: [] };
  let entries = [];
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name.startsWith('_assets')) continue;
    if (!relDir && ['records', 'timeline', 'metrics.json', 'prefs.json', 'todos.md'].includes(ent.name)) continue;
    const absChild = path.join(absDir, ent.name);
    const relChild = relDir ? relDir + '/' + ent.name : ent.name;
    if (ent.isDirectory()) {
      out.folders.push(scanDir(absChild, relChild));
    } else if (ent.isFile() && isTextFile(ent.name)) {
      const st = statSafe(absChild);
      const meta = indexerMeta(relChild);
      out.articles.push({
        title: readTitle(ent.name), path: relChild,
        snippet: meta ? meta.head : '',
        date: meta ? meta.date : '',
        tags: meta ? meta.tags : [],
        mtime: st ? st.mtimeMs : 0,
        updated: (function(){
          var _nd = nameDateMs(ent.name);
          var _em = readEditMeta()[relChild.replace(/\\/g, '/')] || 0;
          if (_nd) return _nd;                       /* 文件名带日期：按内容日期排 */
          return 0;                                  /* 没写日期：不参与时间排序，沉底 */
        })()
      });
    }
  }
  out.folders.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  out.articles.sort((a, b) => (b.updated - a.updated) || -cmpByDate({ name: path.basename(a.path) }, { name: path.basename(b.path) }));
  return out;
}

function indexerMeta(rel) {
  try {
    const idx = indexer.get();
    return idx.articles.find(a => a.path === rel) || null;
  } catch { return null; }
}

function listFolders(absDir, relDir, acc) {
  let entries = [];
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name === 'records') continue;
    const relChild = relDir ? relDir + '/' + ent.name : ent.name;
    acc.push(relChild);
    listFolders(path.join(absDir, ent.name), relChild, acc);
  }
  return acc;
}

/* ---------------- SSE ---------------- */

const clients = new Set();

function broadcast(event) {
  const payload = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const c of clients) {
    try { c.write(payload); } catch { clients.delete(c); }
  }
}

function openEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { } }, 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
}

/* ---------------- 自然语言解析（规则版，不编造） ---------------- */

const BODY_ALIAS = {
  '小臂': 'arm', '腰围': 'waist', '小腿': 'calf', '大腿': 'thigh',
  '下胸围': 'under', '胸围': 'bust', '臀围': 'hip'
};

function todayISO() {
  const d = new Date();
  const p = n => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function resolveDate(text, base) {
  const t = String(text || '');
  const now = base ? new Date(base + 'T12:00:00') : new Date();
  if (/前天/.test(t)) { now.setDate(now.getDate() - 2); return iso(now); }
  if (/昨天/.test(t)) { now.setDate(now.getDate() - 1); return iso(now); }
  if (/今天|今早|今晚/.test(t)) return iso(now);
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${p2(m[2])}-${p2(m[3])}`;
  m = /(\d{1,2})[月.](\d{1,2})[日号]?/.exec(t);
  if (m) return now.getFullYear() + '-' + p2(m[1]) + '-' + p2(m[2]);
  return '';
}

function iso(d) {
  const p = n => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function p2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

function parseText(raw, baseDate) {
  const text = String(raw || '');
  const items = [];      // 结构化，可入库
  const pending = [];    // 有数字但没认出指标 -> 待确认
  const feelings = [];   // 主观，只进日志
  const tags = [];

  const date = resolveDate(text, baseDate) || baseDate || todayISO();

  (text.match(/#([^\s#,，。；;:：!！?？()（）]+)/g) || []).forEach(t => {
    const v = t.slice(1);
    if (!tags.includes(v)) tags.push(v);
  });

  const push = (key, value, unit, raw0) => {
    items.push({ key, value, unit, date, raw: raw0 });
  };

  // 睡眠评分
  let m = /睡眠(?:评分)?\s*[:：]?\s*(\d{1,3})\s*(?:分)?/.exec(text);
  if (m) push('sleep', +m[1], '分', m[0]);
  // 睡眠时长：5 小时 20 分 / 5.2h / 320 分钟
  m = /(?:睡(?:了|眠)?|睡眠时长)\s*[:：]?\s*(\d{1,2}(?:\.\d)?)\s*(?:个)?小时(?:\s*(\d{1,2})\s*分)?/.exec(text);
  if (m) {
    const h = +m[1] + (m[2] ? +m[2] / 60 : 0);
    push('hours', Math.round(h * 10) / 10, 'h', m[0]);
  } else {
    m = /睡眠时长\s*[:：]?\s*(\d{1,3})\s*分钟/.exec(text);
    if (m) push('hours', Math.round((+m[1] / 60) * 10) / 10, 'h', m[0]);
  }
  // 深睡
  m = /深睡(?:占比)?\s*[:：]?\s*(\d{1,2})\s*%/.exec(text);
  if (m) push('deep', +m[1], '%', m[0]);
  // 体重
  m = /体重\s*[:：]?\s*(\d{2,3}(?:\.\d)?)\s*(?:kg|公斤|斤)?/.exec(text) || /(\d{2,3}(?:\.\d)?)\s*(?:kg|公斤)/.exec(text);
  if (m) {
    let v = +m[1];
    if (/斤/.test(m[0])) v = Math.round(v / 2 * 10) / 10;
    push('weight', v, 'kg', m[0]);
  }
  // 围度
  for (const [cn, key] of Object.entries(BODY_ALIAS)) {
    const re = new RegExp(cn + '\\s*[:：]?\\s*(\\d{2,3}(?:\\.\\d)?)\\s*(?:cm|厘米)?');
    const mm = re.exec(text);
    if (mm) push(key, +mm[1], 'cm', mm[0]);
  }
  // 步数
  m = /(?:步数|走了|步行)\s*[:：]?\s*(\d{3,6})\s*步/.exec(text) || /(\d{3,6})\s*步/.exec(text);
  if (m) push('steps', +m[1], '步', m[0]);
  // 热量
  m = /(?:热量|摄入|吃了)\s*[:：]?\s*(\d{3,5})\s*(?:kcal|千卡|卡)?/.exec(text);
  if (m) push('cal', +m[1], 'kcal', m[0]);
  // 学习 / 运动时长 -> 只作为日志文本，不入趋势（无固定指标）
  // 心率
  m = /心率\s*(?:最高|峰值)?\s*[:：]?\s*(\d{2,3})/.exec(text);
  if (m) feelings.push('心率 ' + m[1] + '（不入趋势，先记在日志）');

  // 花销
  const spends = [];
  const spendRe = /(?:花了|花|消费|买了?)\s*(\d{1,5}(?:\.\d{1,2})?)\s*(?:块钱|块|元)/g;
  while ((m = spendRe.exec(text))) spends.push({ value: +m[1], unit: '元', raw: m[0], date });
  if (spends.length) spends.forEach(s => items.push({ key: 'spend', value: s.value, unit: '元', date, raw: s.raw }));

  // 主观：情绪 / 身体不适
  const moodWords = ['焦虑', '烦', '累', '困', '开心', '空', '低落', '难过', '生气', '平静', '放松', '兴奋', '内耗'];
  const hurtWords = ['头痛', '头晕', '腰疼', '腿疼', '胃疼', '胃胀', '反胃', '痘痘', '过敏', '心慌', '胸闷', '抽筋', '酸'];
  moodWords.forEach(w => { if (text.includes(w)) feelings.push('情绪：' + w); });
  hurtWords.forEach(w => { if (text.includes(w)) feelings.push('不适：' + w); });

  // 剩下的裸数字 -> 待确认（不猜）
  const usedRaw = items.map(i => i.raw).join(' ') + ' ' + feelings.join(' ');
  const numRe = /(\d{1,5}(?:\.\d)?)\s*([a-zA-Z%]+|公斤|斤|厘米|cm|kg|分|小时|步|元|块)?/g;
  while ((m = numRe.exec(text))) {
    const chunk = m[0];
    if (!chunk.trim()) continue;
    if (usedRaw.includes(chunk)) continue;
    if (chunk.length <= 1) continue;
    if (/^20\d{2}/.test(chunk)) continue;                 // 年份
    if (/^\d{1,2}\.\d{1,2}$/.test(chunk) && /\d{1,2}[月.]\d{1,2}/.test(text)) continue; // 日期
    pending.push({ raw: chunk, hint: '没认出这属于哪个指标' });
  }

  return { date, items, pending: pending.slice(0, 6), feelings, tags, raw: text };
}

/* ---------------- API ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(res, absFile) {
  const ext = path.extname(absFile).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(absFile).pipe(res);
}

async function api(req, res, url) {
  const route = url.pathname;
  const method = req.method;

  /* ---- 读 ---- */

  if (route === '/api/tree' && method === 'GET') {
    return sendJSON(res, 200, scanDir(DATA_DIR, ''));
  }

  if (route === '/api/search' && method === 'GET') {
    return sendJSON(res, 200, indexer.search(url.searchParams.get('q') || ''));
  }

  if (route === '/api/about' && method === 'GET') {
    const fa = path.join(DATA_DIR, 'about.html');
    if (!statSafe(fa)?.isFile()) return sendJSON(res, 200, { html: '' });
    return sendJSON(res, 200, { html: fs.readFileSync(fa, 'utf8') });
  }
  if (route === '/api/tag' && method === 'GET') {
    return sendJSON(res, 200, indexer.tagHit(url.searchParams.get('t') || ''));
  }

  if (route === '/api/folders' && method === 'GET') {
    return sendJSON(res, 200, listFolders(DATA_DIR, '', []));
  }

  if (route === '/api/graph' && method === 'GET') {
    return sendJSON(res, 200, indexer.graph());
  }

  if (route === '/api/index' && method === 'GET') {
    const force = url.searchParams.get('force') === '1';
    const idx = indexer.get(force);
    return sendJSON(res, 200, { at: idx.at, count: idx.count, tags: idx.tags, articles: idx.articles });
  }

  // 统一数据入口：整包读（records + todos + metrics + prefs）
  if ((route === '/api/sync' || route === '/api/state') && method === 'GET') {
    const records = store.readAllRecords();
    const todos = store.readTodos();
    return sendJSON(res, 200, {
      state: {
        records,
        todos,
        metrics: store.readMetrics(),
        prefs: store.readPrefs(),
        seedVersion: 2
      },
      at: Date.now(),
      files: { records: records.length, todos: todos.length }
    });
  }

  if (route === '/api/records' && method === 'GET') {
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';
    let rs = store.readAllRecords();
    if (from) rs = rs.filter(r => r.date >= from);
    if (to) rs = rs.filter(r => r.date <= to);
    return sendJSON(res, 200, { records: rs, count: rs.length });
  }

  if (route === '/api/todos' && method === 'GET') {
    return sendJSON(res, 200, { todos: store.readTodos() });
  }

  if (route === '/api/metrics' && method === 'GET') {
    return sendJSON(res, 200, { metrics: store.readMetrics() });
  }

  if (route === '/api/article' && method === 'GET') {
    const abs = safeDataPath(url.searchParams.get('path'));
    if (!abs || !isTextFile(abs) || !statSafe(abs)?.isFile()) return sendJSON(res, 404, { error: 'not found' });
    const content = fs.readFileSync(abs, 'utf8');
    return sendJSON(res, 200, { title: readTitle(path.basename(abs)), path: url.searchParams.get('path'), content });
  }

  /* ---- 写 ---- */

  let body = {};
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
    catch { return sendJSON(res, 400, { error: 'bad json' }); }
  }

  // 整包写：前端一次提交，服务端拆成 md（文件才是真相）
  if ((route === '/api/sync' || route === '/api/state') && method === 'POST') {
    try {
      const s = body.state || {};
      const files = {};
      if (Array.isArray(s.records)) { files.records = store.writeAllRecords(s.records); }
      if (Array.isArray(s.todos)) { files.todos = store.writeTodos(s.todos); }
      if (Array.isArray(s.metrics)) { files.metrics = store.writeMetrics(s.metrics); }
      if (s.prefs && typeof s.prefs === 'object') { files.prefs = store.writePrefs(s.prefs); }
      indexer.invalidate();
      broadcast({ type: 'sync', at: Date.now(), files });
      // 保留一份 json 快照，方便误操作后翻旧账
      try {
        fs.writeFileSync(path.join(ROOT, 'state.json'), JSON.stringify({ state: s, at: Date.now(), savedAt: new Date().toISOString() }), 'utf8');
      } catch { }
      return sendJSON(res, 200, { ok: true, at: Date.now(), files });
    } catch (e) {
      return sendJSON(res, 500, { error: String(e.message || e) });
    }
  }

  // 单条记录：upsert（同日期覆盖）
  if (route === '/api/records' && method === 'POST') {
    const r = body.record || body;
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) return sendJSON(res, 400, { error: 'date 必须是 YYYY-MM-DD' });
    try {
      const all = store.upsertRecord(r);
      indexer.invalidate();
      broadcast({ type: 'records', at: Date.now(), date: r.date });
      return sendJSON(res, 200, { ok: true, count: all.length });
    } catch (e) { return sendJSON(res, 500, { error: String(e.message || e) }); }
  }

  if (route === '/api/records' && method === 'DELETE') {
    const date = url.searchParams.get('date') || body.date;
    if (!date) return sendJSON(res, 400, { error: 'date required' });
    try {
      const all = store.deleteRecord(date);
      indexer.invalidate();
      broadcast({ type: 'records', at: Date.now(), date, deleted: true });
      return sendJSON(res, 200, { ok: true, count: all.length });
    } catch (e) { return sendJSON(res, 500, { error: String(e.message || e) }); }
  }

  if (route === '/api/todos' && method === 'POST') {
    try {
      if (Array.isArray(body.todos)) {
        store.writeTodos(body.todos);
      } else if (body.todo) {
        const list = store.readTodos();
        list.push(body.todo);
        store.writeTodos(list);
      }
      broadcast({ type: 'todos', at: Date.now() });
      return sendJSON(res, 200, { ok: true, todos: store.readTodos() });
    } catch (e) { return sendJSON(res, 500, { error: String(e.message || e) }); }
  }

  if (route === '/api/metrics' && method === 'POST') {
    try {
      store.writeMetrics(body.metrics || []);
      broadcast({ type: 'metrics', at: Date.now() });
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 500, { error: String(e.message || e) }); }
  }

  // 自然语言解析：只给预览，不入库
  if (route === '/api/parse' && method === 'POST') {
    const text = body.text || '';
    if (!text.trim()) return sendJSON(res, 400, { error: 'text required' });
    return sendJSON(res, 200, parseText(text, body.date || todayISO()));
  }

  // 新建文章
  if (route === '/api/create' && method === 'POST') {
    const folder = sanitizeRel(body.folder);
    const title = sanitizeName(body.title);
    if (!title) return sendJSON(res, 400, { error: '标题不能为空' });
    const dirAbs = safeDataPath(folder || '');
    if (!dirAbs) return sendJSON(res, 400, { error: '分区不存在' });
    ensureDir(dirAbs);
    const abs = uniquePath(path.join(dirAbs, title + '.md'));
    if (!abs) return sendJSON(res, 500, { error: '创建失败' });
    fs.writeFileSync(abs, String(body.content || ''), 'utf8');
    indexer.invalidate();
    const rel = path.relative(DATA_DIR, abs).replace(/\\/g, '/');
    touchEditMeta(rel);
    broadcast({ type: 'articles', at: Date.now(), path: rel });
    return sendJSON(res, 200, { ok: true, path: rel });
  }

  // 保存编辑
  if (route === '/api/save' && method === 'POST') {
    const abs = safeDataPath(body.path);
    if (!abs || !isTextFile(abs)) return sendJSON(res, 400, { error: 'bad path' });
    fs.writeFileSync(abs, String(body.content ?? ''), 'utf8');
    indexer.invalidate();
    touchEditMeta(body.path);
    broadcast({ type: 'articles', at: Date.now(), path: body.path });
    return sendJSON(res, 200, { ok: true });
  }

  // 重命名 / 移动
  if (route === '/api/move' && method === 'POST') {
    const fromAbs = safeDataPath(body.from);
    const toFolderAbs = safeDataPath(body.toFolder || '');
    const newName = sanitizeName(body.name || '');
    if (!fromAbs || !toFolderAbs || !statSafe(fromAbs)) return sendJSON(res, 400, { error: 'bad params' });
    const targetName = newName || path.basename(fromAbs);
    const target = uniquePath(path.join(toFolderAbs, targetName));
    if (!target) return sendJSON(res, 500, { error: '移动失败' });
    ensureDir(toFolderAbs);
    fs.renameSync(fromAbs, target);
    indexer.invalidate();
    {
      const oldRel = String(body.from || '').replace(/\\/g, '/');
      const newRel = path.relative(DATA_DIR, target).replace(/\\/g, '/');
      const m = readEditMeta();
      const t = m[oldRel] || nameDateMs(path.basename(target)) || Date.now();
      delete m[oldRel];
      m[newRel] = t;
      writeEditMeta(m);
    }
    broadcast({ type: 'articles', at: Date.now() });
    return sendJSON(res, 200, { ok: true, path: path.relative(DATA_DIR, target).replace(/\\/g, '/') });
  }

  // 删除（文章 / 分区）
  if (route === '/api/delete' && method === 'POST') {
    const abs = safeDataPath(body.path);
    if (!abs || abs === path.resolve(DATA_DIR)) return sendJSON(res, 400, { error: 'bad path' });
    const st = statSafe(abs);
    if (!st) return sendJSON(res, 404, { error: 'not found' });
    if (st.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
    else fs.unlinkSync(abs);
    {
      const rel = String(body.path || '').replace(/\\/g, '/');
      const m = readEditMeta();
      for (const k of Object.keys(m)) if (k === rel || k.startsWith(rel + '/')) delete m[k];
      writeEditMeta(m);
    }
    indexer.invalidate();
    broadcast({ type: 'articles', at: Date.now() });
    return sendJSON(res, 200, { ok: true });
  }

  // 新建分区
  if (route === '/api/folder' && method === 'POST') {
    const name = sanitizeName(body.name);
    const parent = sanitizeRel(body.parent || '');
    if (!name) return sendJSON(res, 400, { error: '分区名不能为空' });
    const abs = uniquePath(path.join(safeDataPath(parent) || DATA_DIR, name));
    if (!abs) return sendJSON(res, 500, { error: '创建失败' });
    ensureDir(abs);
    indexer.invalidate();
    return sendJSON(res, 200, { ok: true, path: path.relative(DATA_DIR, abs).replace(/\\/g, '/') });
  }

  // 上传 / 导入
  if (route === '/api/upload' && method === 'POST') {
    const folder = sanitizeRel(body.folder || '');
    const name = sanitizeName(body.name);
    if (!name) return sendJSON(res, 400, { error: 'bad name' });
    const dirAbs = safeDataPath(folder || '');
    if (!dirAbs) return sendJSON(res, 400, { error: '分区不存在' });
    ensureDir(dirAbs);
    const abs = uniquePath(path.join(dirAbs, name));
    if (!abs) return sendJSON(res, 500, { error: '导入失败' });
    if (body.b64) fs.writeFileSync(abs, Buffer.from(body.b64, 'base64'));
    else fs.writeFileSync(abs, String(body.content ?? ''), 'utf8');
    const relUp = path.relative(DATA_DIR, abs).replace(/\\/g, '/');
    touchEditMeta(relUp);
    indexer.invalidate();
    broadcast({ type: 'articles', at: Date.now() });
    return sendJSON(res, 200, { ok: true, path: relUp });
  }

  return sendJSON(res, 404, { error: 'unknown api' });
}

/* ---------------- 服务器 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/events' && req.method === 'GET') {
      return openEvents(req, res);
    }
    if (url.pathname.startsWith('/api/')) {
      return await api(req, res, url);
    }
    if (url.pathname === '/') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'classic.html'));
    }
    if (url.pathname === '/index.html') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    const pubAbs = path.resolve(PUBLIC_DIR, '.' + decodeURIComponent(url.pathname));
    if (pubAbs.startsWith(path.resolve(PUBLIC_DIR)) && statSafe(pubAbs)?.isFile()) {
      return serveStatic(res, pubAbs);
    }
    const dataAbs = safeDataPath(decodeURIComponent(url.pathname).replace(/^\/data\/?/, ''));
    if (url.pathname.startsWith('/data/') && dataAbs && statSafe(dataAbs)?.isFile()) {
      return serveStatic(res, dataAbs);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (e) {
    sendJSON(res, 500, { error: String(e.message || e) });
  }
});

ensureDir(DATA_DIR);
ensureDir(PUBLIC_DIR);
ensureDir(path.join(DATA_DIR, 'records'));

function listen(port, tries) {
  server.once('error', err => {
    if (err.code === 'EADDRINUSE' && tries > 0) {
      console.log(`端口 ${port} 被占用，尝试 ${port + 1} ...`);
      listen(port + 1, tries - 1);
    } else {
      console.error('启动失败:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, () => {
    const addr = `http://localhost:${port}`;
    console.log('✅ 个人系统已启动: ' + addr);
    console.log('   数据目录: ' + DATA_DIR);
    console.log('   记录文件: ' + store.REC_DIR);
    console.log('   待办文件: ' + store.TODO_FILE);
    if (process.platform === 'win32' && process.env.KB_NO_OPEN !== '1') {
      exec(`start "" "${addr}"`);
    }
  });
}

listen(DEFAULT_PORT, 10);
