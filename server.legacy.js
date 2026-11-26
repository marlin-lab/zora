/*
 * 个人知识库网站 - 本地服务端（零依赖，纯 Node.js）
 * 启动：node server.js  （或双击 start-knowledge-base.bat）
 * 数据全部以 .md 纯文本保存在 data/ 目录，方便以后多端同步（git / 坚果云 / 网盘均可）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEFAULT_PORT = 8686;
const TEXT_EXT = ['.md', '.txt', '.markdown'];

/* ---------------- 工具函数 ---------------- */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// 安全路径：必须位于 data 目录内
function safeDataPath(rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(DATA_DIR, clean);
  if (abs !== path.resolve(DATA_DIR) && !abs.startsWith(path.resolve(DATA_DIR) + path.sep)) return null;
  return abs;
}

// Windows 文件名非法字符
function sanitizeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function isTextFile(name) {
  return TEXT_EXT.includes(path.extname(name).toLowerCase());
}

function readTitle(file) {
  return file.replace(/\.(md|txt|markdown)$/i, '');
}

function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// 递归扫描目录树
function scanDir(absDir, relDir) {
  const out = { name: relDir ? path.basename(relDir) : '我的知识库', path: relDir || '', folders: [], articles: [] };
  let entries = [];
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name.startsWith('_assets')) continue;
    const absChild = path.join(absDir, ent.name);
    const relChild = relDir ? relDir + '/' + ent.name : ent.name;
    if (ent.isDirectory()) {
      out.folders.push(scanDir(absChild, relChild));
    } else if (ent.isFile() && isTextFile(ent.name)) {
      const st = statSafe(absChild);
      let snippet = '';
      try {
        snippet = fs.readFileSync(absChild, 'utf8').replace(/[#>*`\-\[\]!]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
      } catch {}
      out.articles.push({ title: readTitle(ent.name), path: relChild, snippet, mtime: st ? st.mtimeMs : 0 });
    }
  }
  out.folders.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  out.articles.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// 递归列出所有分区（用于下拉框）
function listFolders(absDir, relDir, acc) {
  let entries = [];
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const relChild = relDir ? relDir + '/' + ent.name : ent.name;
    acc.push(relChild);
    listFolders(path.join(absDir, ent.name), relChild, acc);
  }
  return acc;
}

// 关系图谱：全部文章为节点，[[双链]] 为边
function buildGraph() {
  const nodes = [];
  const titleMap = {}; // 标题 -> 节点id
  function collect(absDir, relDir) {
    let entries = [];
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.name.startsWith('_assets')) continue;
      const absChild = path.join(absDir, ent.name);
      const relChild = relDir ? relDir + '/' + ent.name : ent.name;
      if (ent.isDirectory()) collect(absChild, relChild);
      else if (ent.isFile() && isTextFile(ent.name)) {
        const title = readTitle(ent.name);
        titleMap[title] = nodes.length;
        nodes.push({ id: nodes.length, title, path: relChild });
      }
    }
  }
  collect(DATA_DIR, '');
  const edgeSet = new Set();
  const edges = [];
  function linkWalk(absDir, relDir) {
    let entries = [];
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.name.startsWith('_assets')) continue;
      const absChild = path.join(absDir, ent.name);
      const relChild = relDir ? relDir + '/' + ent.name : ent.name;
      if (ent.isDirectory()) { linkWalk(absChild, relChild); continue; }
      if (!ent.isFile() || !isTextFile(ent.name)) continue;
      const from = titleMap[readTitle(ent.name)];
      if (from === undefined) continue;
      let content = '';
      try { content = fs.readFileSync(absChild, 'utf8'); } catch { continue; }
      const re = /\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g;
      let m;
      while ((m = re.exec(content))) {
        const target = m[1].trim().replace(/\.(md|txt|markdown)$/i, '');
        const to = titleMap[target];
        if (to === undefined || to === from) continue;
        const key = Math.min(from, to) + '-' + Math.max(from, to);
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        edges.push({ s: from, t: to });
      }
    }
  }
  linkWalk(DATA_DIR, '');
  return { nodes, edges };
}

// 全文搜索
function searchAll(q) {
  const results = [];
  if (!q) return results;
  const kw = q.toLowerCase();
  function walk(absDir, relDir) {
    let entries = [];
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const absChild = path.join(absDir, ent.name);
      const relChild = relDir ? relDir + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(absChild, relChild);
      else if (ent.isFile() && isTextFile(ent.name)) {
        try {
          const content = fs.readFileSync(absChild, 'utf8');
          const title = readTitle(ent.name);
          if (title.toLowerCase().includes(kw) || content.toLowerCase().includes(kw)) {
            const idx = content.toLowerCase().indexOf(kw);
            results.push({
              title, path: relChild,
              snippet: idx >= 0 ? content.slice(Math.max(0, idx - 30), idx + 70).replace(/\s+/g, ' ') : ''
            });
          }
        } catch {}
      }
    }
  }
  walk(DATA_DIR, '');
  return results.slice(0, 50);
}

// 若目标存在则自动加序号
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

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(res, absFile) {
  const ext = path.extname(absFile).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(absFile).pipe(res);
}

/* ---------------- API 处理 ---------------- */

/* ---------------- API ---------------- */

async function api(req, res, url) {
  const route = url.pathname;

  // 目录树
  if (route === '/api/tree' && req.method === 'GET') {
    return sendJSON(res, 200, scanDir(DATA_DIR, ''));
  }

  // 全文搜索
  if (route === '/api/search' && req.method === 'GET') {
    return sendJSON(res, 200, searchAll(url.searchParams.get('q') || ''));
  }

  // 分区列表（下拉用）
  if (route === '/api/folders' && req.method === 'GET') {
    return sendJSON(res, 200, listFolders(DATA_DIR, '', []));
  }

  // 关系图谱数据
  if (route === '/api/graph' && req.method === 'GET') {
    return sendJSON(res, 200, buildGraph());
  }

  // 面板数据（记录/待办/小记的跨设备同步）
  if (route === '/api/state' && req.method === 'GET') {
    const f = path.join(__dirname, 'state.json');
    try { return sendJSON(res, 200, JSON.parse(fs.readFileSync(f, 'utf8'))); }
    catch { return sendJSON(res, 200, { state: null, at: 0 }); }
  }

  let body = {};
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
    catch { return sendJSON(res, 400, { error: 'bad json' }); }
  }

  // 保存面板数据（写入站点根目录 state.json，供手机/电脑共用）
  if (route === '/api/state' && req.method === 'POST') {
    const f = path.join(__dirname, 'state.json');
    const payload = { state: body.state || {}, at: body.at || Date.now(), savedAt: new Date().toISOString() };
    try {
      fs.writeFileSync(f, JSON.stringify(payload), 'utf8');
      return sendJSON(res, 200, { ok: true, at: payload.at });
    } catch (e) { return sendJSON(res, 500, { error: String(e.message || e) }); }
  }

  // 读文章
  if (route === '/api/article' && req.method === 'GET') {
    const abs = safeDataPath(url.searchParams.get('path'));
    if (!abs || !isTextFile(abs) || !statSafe(abs)?.isFile()) return sendJSON(res, 404, { error: 'not found' });
    const content = fs.readFileSync(abs, 'utf8');
    return sendJSON(res, 200, { title: readTitle(path.basename(abs)), path: url.searchParams.get('path'), content });
  }

  // 新建文章
  if (route === '/api/create' && req.method === 'POST') {
    const folder = sanitizeRel(body.folder);
    const title = sanitizeName(body.title);
    if (!title) return sendJSON(res, 400, { error: '标题不能为空' });
    const dirAbs = safeDataPath(folder || '');
    if (!dirAbs) return sendJSON(res, 400, { error: '分区不存在' });
    ensureDir(dirAbs);
    const abs = uniquePath(path.join(dirAbs, title + '.md'));
    if (!abs) return sendJSON(res, 500, { error: '创建失败' });
    fs.writeFileSync(abs, String(body.content || ''), 'utf8');
    const rel = path.relative(DATA_DIR, abs).replace(/\\/g, '/');
    return sendJSON(res, 200, { ok: true, path: rel });
  }

  // 保存编辑
  if (route === '/api/save' && req.method === 'POST') {
    const abs = safeDataPath(body.path);
    if (!abs || !isTextFile(abs)) return sendJSON(res, 400, { error: 'bad path' });
    fs.writeFileSync(abs, String(body.content ?? ''), 'utf8');
    return sendJSON(res, 200, { ok: true });
  }

  // 重命名/移动（文章或分区）
  if (route === '/api/move' && req.method === 'POST') {
    const fromAbs = safeDataPath(body.from);
    const toFolderAbs = safeDataPath(body.toFolder || '');
    const newName = sanitizeName(body.name || '');
    if (!fromAbs || !toFolderAbs || !statSafe(fromAbs)) return sendJSON(res, 400, { error: 'bad params' });
    if (!newName && !path.basename(fromAbs)) return sendJSON(res, 400, { error: 'bad name' });
    const targetName = newName || path.basename(fromAbs);
    const target = uniquePath(path.join(toFolderAbs, targetName));
    if (!target) return sendJSON(res, 500, { error: '移动失败' });
    ensureDir(toFolderAbs);
    fs.renameSync(fromAbs, target);
    return sendJSON(res, 200, { ok: true, path: path.relative(DATA_DIR, target).replace(/\\/g, '/') });
  }

  // 删除（文章或空分区）
  if (route === '/api/delete' && req.method === 'POST') {
    const abs = safeDataPath(body.path);
    if (!abs || abs === path.resolve(DATA_DIR)) return sendJSON(res, 400, { error: 'bad path' });
    const st = statSafe(abs);
    if (!st) return sendJSON(res, 404, { error: 'not found' });
    if (st.isDirectory()) {
      // 直接递归删除整个分区（含其中所有内容）
      fs.rmSync(abs, { recursive: true, force: true });
    } else {
      fs.unlinkSync(abs);
    }
    return sendJSON(res, 200, { ok: true });
  }

  // 新建分区
  if (route === '/api/folder' && req.method === 'POST') {
    const name = sanitizeName(body.name);
    const parent = sanitizeRel(body.parent || '');
    if (!name) return sendJSON(res, 400, { error: '分区名不能为空' });
    const abs = uniquePath(path.join(safeDataPath(parent) || DATA_DIR, name));
    if (!abs) return sendJSON(res, 500, { error: '创建失败' });
    ensureDir(abs);
    return sendJSON(res, 200, { ok: true, path: path.relative(DATA_DIR, abs).replace(/\\/g, '/') });
  }

  // 拖拽导入 / 上传
  if (route === '/api/upload' && req.method === 'POST') {
    const folder = sanitizeRel(body.folder || '');
    const name = sanitizeName(body.name);
    if (!name) return sendJSON(res, 400, { error: 'bad name' });
    const dirAbs = safeDataPath(folder || '');
    if (!dirAbs) return sendJSON(res, 400, { error: '分区不存在' });
    ensureDir(dirAbs);
    const abs = uniquePath(path.join(dirAbs, name));
    if (!abs) return sendJSON(res, 500, { error: '导入失败' });
    if (body.b64) {
      fs.writeFileSync(abs, Buffer.from(body.b64, 'base64'));
    } else {
      fs.writeFileSync(abs, String(body.content ?? ''), 'utf8');
    }
    return sendJSON(res, 200, { ok: true, path: path.relative(DATA_DIR, abs).replace(/\\/g, '/') });
  }

  return sendJSON(res, 404, { error: 'unknown api' });
}

function sanitizeRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/* ---------------- 服务器 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      return await api(req, res, url);
    }
    // 静态文件
    if (url.pathname === '/' || url.pathname === '/index.html') {
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

// 初始化：确保 data 目录存在；首次运行时创建默认分区
ensureDir(DATA_DIR);
ensureDir(PUBLIC_DIR);
const isEmpty = fs.readdirSync(DATA_DIR).filter(n => !n.startsWith('.')).length === 0;
if (isEmpty) {
  for (const name of ['学习笔记', '技术分享', '生活随笔', '灵感速记']) {
    ensureDir(path.join(DATA_DIR, name));
  }
}

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
    console.log('✅ 知识库已启动: ' + addr);
    console.log('   数据目录: ' + DATA_DIR);
    console.log('   关闭本窗口即可停止服务');
    if (process.platform === 'win32' && process.env.KB_NO_OPEN !== '1') {
      exec(`start "" "${addr}"`);
    }
  });
}

listen(DEFAULT_PORT, 10);
