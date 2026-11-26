/*
 * indexer.js —— 可重建的索引层（借 Trilium 的思路，但不抄它的 SQLite 笔记本体）
 *
 * 真相仍是 data/ 里的 markdown；这里只维护一份"缓存"：
 *   articles: {path,title,folder,date,mtime,size,head,links[],tags[]}
 * 启动全量扫一次，之后按目录 mtime / 文件数变化懒重建。
 * 缓存文件 .index.json 丢了无所谓，删掉自动重建。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CACHE = path.join(DATA_DIR, '.index.json');
const TEXT_EXT = ['.md', '.txt', '.markdown'];
// 系统文件：不算文章、不进图谱
const SYSTEM_DIRS = ['records'];
const SYSTEM_FILES = ['todos.md', 'metrics.json', 'prefs.json'];

let cache = null;
let lastScan = 0;

function isText(name) { return TEXT_EXT.includes(path.extname(name).toLowerCase()); }

function titleOf(name) { return name.replace(/\.(md|txt|markdown)$/i, ''); }

// 从文件名猜日期：11.24.md / 2026-11-24.md / 10.5-xxx.md
function dateOf(name) {
  const t = titleOf(name);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\.(\d{1,2})(?![0-9])/.exec(t);
  if (m) return `${m[1].length < 2 ? '0' + m[1] : m[1]}-${m[2].length < 2 ? '0' + m[2] : m[2]}`;
  return '';
}

function parseLinks(text, titles) {
  const links = [];
  const re = /\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(text))) {
    const target = m[1].trim().replace(/\.(md|txt|markdown)$/i, '');
    if (target && !links.includes(target)) links.push(target);
  }
  return links;
}

function parseTags(text) {
  const tags = [];
  const re = /#([^\s#,，。；;:：!！?？()（）\[\]{}"'`]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const t = m[1].trim();
    // 排除 markdown 标题（# 后跟空格的情况已被正则排除）、十六进制色值
    if (t && !/^[0-9a-fA-F]{3,8}$/.test(t) && !tags.includes(t)) tags.push(t);
  }
  return tags;
}

function walk(dirAbs, relDir, acc) {
  let entries = [];
  try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name.startsWith('_assets')) continue;
    const relChild = relDir ? relDir + '/' + ent.name : ent.name;
    const absChild = path.join(dirAbs, ent.name);
    if (ent.isDirectory()) {
      if (relDir === '' && SYSTEM_DIRS.includes(ent.name)) continue;
      walk(absChild, relChild, acc);
    } else if (ent.isFile() && isText(ent.name)) {
      if (relDir === '' && SYSTEM_FILES.includes(ent.name)) continue;
      acc.push({ abs: absChild, rel: relChild });
    }
  }
}

function build() {
  const files = [];
  walk(DATA_DIR, '', files);
  const articles = [];
  for (const f of files) {
    let st = null;
    try { st = fs.statSync(f.abs); } catch { continue; }
    let text = '';
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch { }
    const head = text.replace(/^#\s+/gm, '').replace(/[[\]!*`>#-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 110);
    const title = titleOf(path.basename(f.rel));
    articles.push({
      path: f.rel,
      title,
      folder: path.dirname(f.rel) === '.' ? '' : path.dirname(f.rel),
      date: dateOf(path.basename(f.rel)),
      mtime: st.mtimeMs,
      size: st.size,
      chars: text.length,
      head,
      links: parseLinks(text, null),
      tags: parseTags(text)
    });
  }
  const tags = {};
  articles.forEach(a => a.tags.forEach(t => { tags[t] = (tags[t] || 0) + 1; }));
  const idx = { at: Date.now(), count: articles.length, articles, tags };
  cache = idx;
  lastScan = Date.now();
  try { fs.writeFileSync(CACHE, JSON.stringify(idx), 'utf8'); } catch { }
  return idx;
}

function get(force) {
  if (force) return build();
  if (cache && Date.now() - lastScan < 5000) return cache;
  return build();
}

function invalidate() { lastScan = 0; }

function graph() {
  const idx = get();
  const byTitle = {};
  idx.articles.forEach((a, i) => { byTitle[a.title] = i; });
  const nodes = idx.articles.map((a, i) => ({ id: i, title: a.title, path: a.path, folder: a.folder, date: a.date, tags: a.tags }));
  const seen = new Set();
  const edges = [];
  idx.articles.forEach((a, i) => {
    a.links.forEach(t => {
      const j = byTitle[t];
      if (j === undefined || j === i) return;
      const key = Math.min(i, j) + '-' + Math.max(i, j);
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ s: i, t: j });
    });
  });
  return { nodes, edges };
}

function search(q) {
  if (!q) return [];
  const kw = q.toLowerCase();
  const idx = get();
  const out = [];
  for (const a of idx.articles) {
    if (a.title.toLowerCase().includes(kw) || a.head.toLowerCase().includes(kw) || (a.tags || []).some(t => t.toLowerCase().includes(kw))) {
      out.push({ title: a.title, path: a.path, snippet: a.head, date: a.date, tags: a.tags });
      continue;
    }
    // 正文匹配需要读盘，只在标题/标签未命中时做，最多 200 篇
    if (out.length < 200) {
      let text = '';
      try { text = fs.readFileSync(path.join(DATA_DIR, a.path), 'utf8'); } catch { continue; }
      const i = text.toLowerCase().indexOf(kw);
      if (i >= 0) {
        out.push({
          title: a.title, path: a.path, date: a.date, tags: a.tags,
          snippet: text.slice(Math.max(0, i - 30), i + 70).replace(/\s+/g, ' ')
        });
      }
    }
  }
  return out.slice(0, 50);
}

// 标签 → 相关文章 + 相关记录（数据与笔记靠标签打通）
function tagHit(tag) {
  const idx = get();
  const arts = idx.articles.filter(a => (a.tags || []).includes(tag));
  return { tag, articles: arts.map(a => ({ title: a.title, path: a.path, date: a.date })), count: arts.length };
}

module.exports = { get, build, invalidate, graph, search, tagHit, dateOf, titleOf };
