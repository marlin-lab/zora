/* 个人知识库 - 前端逻辑 */
'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  tree: null,
  folder: '',          // 当前分区路径（'' 为首页）
  view: 'home',        // home | folder | article | search
  articlePath: null,
  articleContent: '',
  editing: false,
  searchResults: null,
  clipboard: null,     // 剪切板 { type: 'article'|'folder', path, name }
  expanded: {},        // 目录树折叠状态 { path: bool }，默认展开
};

/* ---------------- 右键菜单 ---------------- */
function hideMenu() { document.querySelectorAll('.ctx-menu').forEach(m => m.remove()); }

function showMenu(x, y, items) {
  hideMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.innerHTML = items.map((it, i) => it === '-' ? '<div class="sep"></div>'
    : `<div class="mi ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}" data-i="${i}">${it.icon || ''} ${esc(it.label)}</div>`
  ).join('');
  document.body.appendChild(menu);
  // 防止溢出屏幕
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  menu.querySelectorAll('.mi').forEach(el => {
    el.addEventListener('click', () => { hideMenu(); items[+el.dataset.i].action && items[+el.dataset.i].action(); });
  });
}
document.addEventListener('click', hideMenu);
document.addEventListener('contextmenu', e => { if (!e.target.closest('.card, .folder-item, #content')) hideMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideMenu(); });
window.addEventListener('scroll', hideMenu, true);

/* ---------------- 剪切 / 粘贴 / 删除 ---------------- */
function cutItem(type, path, name) {
  state.clipboard = { type, path, name };
  toast(`已剪切「${name}」，到目标分区空白处点击粘贴`);
  renderCurrent();
  renderSidebar();
}

function basename(p) { return p.split('/').pop(); }

async function pasteItem() {
  const c = state.clipboard;
  if (!c) return;
  const target = state.folder || '';
  if (c.type === 'folder') {
    if (target === c.path || target.startsWith(c.path + '/')) {
      toast('不能把分区粘贴到它自己内部', 'err'); return;
    }
  }
  try {
    await POST('/api/move', { from: c.path, toFolder: target, name: c.name });
    state.clipboard = null;
    toast('已粘贴', 'ok');
    await loadTree();
    renderCurrent();
    // 正在看的文章被移走了 → 回首页
    if (state.articlePath && (state.articlePath === c.path || state.articlePath.startsWith(c.path + '/'))) openHome();
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteItem(type, path, name) {
  const tip = type === 'folder'
    ? `确定删除「${name}」吗？\n其中的文章和子分区会被一并删除，此操作不可恢复！`
    : `确定删除「${name}」吗？此操作不可恢复。`;
  if (!confirm(tip)) return;
  try {
    await POST('/api/delete', { path });
    if (state.clipboard && state.clipboard.path === path) state.clipboard = null;
    toast('已删除', 'ok');
    await loadTree();
    renderCurrent();
    // 正在看的文章被删了 → 回首页
    if (state.articlePath && (state.articlePath === path || state.articlePath.startsWith(path + '/'))) {
      state.articlePath = null; state.view = 'home'; state.editing = false;
      openHome();
    }
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------------- 工具 ---------------- */
// 记录正文内最后的光标选区（点工具栏时恢复，保证选中文字不丢）
let savedRange = null;
document.addEventListener('selectionchange', () => {
  const el = document.getElementById('docBody');
  const sel = window.getSelection();
  if (el && sel.rangeCount && el.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
});
function restoreSel() {
  if (!savedRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(savedRange);
}

// 主区域只展示文章详情；树结构变化时只刷新侧栏
function renderCurrent() {
  renderSidebar();
}

// 文章卡片右键菜单
function articleMenu(path, title, x, y) {
  showMenu(x, y, [
    { label: '打开', icon: '📄', action: () => openArticle(path) },
    { label: '编辑', icon: '✏️', action: async () => {
        if (state.articlePath !== path) await openArticle(path);
        const el = $('#docBody');
        if (el) { el.focus(); }
        else { toast('已在文章中，点击文字即可编辑'); }
      } },
    '-',
    { label: '剪切', icon: '✂️', action: () => cutItem('article', path, title + '.md') },
    { label: '移动 / 重命名', icon: '📂', action: () => moveDialog(path, title, true) },
    '-',
    { label: '删除', icon: '🗑️', danger: true, action: () => deleteItem('article', path, title) },
  ]);
}

// 分区右键菜单
function folderMenu(path, name, x, y) {
  if (!path) {
    // 知识库根节点：只允许新建，不允许改删
    showMenu(x, y, [
      { label: '新建文章', icon: '📄', action: () => newArticleDialog('') },
      { label: '新建分区', icon: '📁', action: () => newFolderDialog('') },
    ]);
    return;
  }
  showMenu(x, y, [
    { label: '打开', icon: '📁', action: () => openFolder(path) },
    '-',
    { label: '新建文章', icon: '📄', action: () => newArticleDialog(path) },
    { label: '新建子分区', icon: '📁＋', action: () => newFolderDialog(path) },
    '-',
    { label: '重命名', icon: '✏️', action: () => renameFolderDialog(path, name) },
    { label: '剪切', icon: '✂️', action: () => cutItem('folder', path, name) },
    '-',
    { label: '删除（含全部内容）', icon: '🗑️', danger: true, action: () => deleteItem('folder', path, name) },
  ]);
}

// 空白处左键菜单（粘贴 / 新建）
function blankMenu(x, y) {
  const items = [
    { label: state.clipboard ? `粘贴「${basename(state.clipboard.path)}」` : '粘贴', icon: '📋',
      disabled: !state.clipboard, action: pasteItem },
    '-',
    { label: '新建文章', icon: '✍️', action: () => newArticleDialog() },
    { label: '新建分区', icon: '📁', action: () => newFolderDialog() },
  ];
  showMenu(x, y, items);
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}
const GET = (u) => api(u);
const POST = (u, body) => api(u, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/* ---------------- 工具 ---------------- */
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toastWrap').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2400);
  setTimeout(() => el.remove(), 2800);
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 统计分区下文章总数（递归）
function countArticles(node) {
  return node.articles.length + node.folders.reduce((s, f) => s + countArticles(f), 0);
}

// 收集所有文章（扁平）
function flattenArticles(node, acc = []) {
  for (const a of node.articles) acc.push(a);
  for (const f of node.folders) flattenArticles(f, acc);
  return acc;
}

/* ---------------- 侧边栏 ---------------- */
async function loadTree() {
  state.tree = await GET('/api/tree');
  renderSidebar();
}

function folderIcon(depth) { return depth === 0 ? '📁' : '└'; }

function renderTreeNode(node, depth) {
  const html = [];
  const total = countArticles(node);
  const active = state.view !== 'article' && state.folder === node.path;
  const cut = state.clipboard && state.clipboard.type === 'folder' && state.clipboard.path === node.path ? ' cut' : '';
  const hasKids = node.folders.length || node.articles.length;
  // 默认全部收起，仅根节点展开（显示顶层分区）；点过的分区记住状态
  const expanded = node.path === '' ? state.expanded[''] !== false : state.expanded[node.path] === true;
  const pad = 8 + depth * 14;
  html.push(`
    <div class="tree-row folder-item${node.kbRoot ? ' kb-root' : ''}${active ? ' active' : ''}${cut}" data-path="${esc(node.path)}" style="padding-left:${pad}px">
      <span class="chev${hasKids ? (expanded ? ' open' : '') : ' hidden'}">▸</span>
      <span class="name">${esc(node.name)}</span>
      ${total ? `<span class="count">${total}</span>` : ''}
      <span class="tree-acts">
        <button data-act="add" title="在此分区新建文章">＋</button>
        ${node.path ? '<button data-act="more" title="更多">⋯</button>' : ''}
      </span>
    </div>`);
  if (expanded) {
    for (const f of node.folders) html.push(...renderTreeNode(f, depth + 1));
    for (const a of node.articles) {
      const aActive = state.view === 'article' && state.articlePath === a.path;
      const aCut = state.clipboard && state.clipboard.type === 'article' && state.clipboard.path === a.path ? ' cut' : '';
      html.push(`
        <div class="tree-row article-item folder-item${aActive ? ' active' : ''}${aCut}" data-article="${esc(a.path)}" style="padding-left:${pad + 14}px">
          <span class="chev hidden">▸</span>
          <span class="name">${esc(a.title)}</span><span class="ago">${fmtEdited(a.updated, true)}</span>
          <span class="tree-acts"><button data-act="more" title="更多">⋯</button></span>
        </div>`);
    }
  }
  return html;
}

function renderSidebar() {
  const tree = state.tree;
  if (!tree) return;
  // 顶级 = 知识库本身（飞书式），其下才是分区
  const html = renderTreeNode({ name: '清溯 Zora', path: '', folders: tree.folders, articles: [], kbRoot: true }, 0);
  $('#folderTree').innerHTML = html.join('');
  bindTreeDrag();

  // 点击行：文章 → 打开；分区 → 进入
  $('#folderTree').querySelectorAll('.tree-row').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.tree-acts') || e.target.closest('.chev')) return;
      if (el.dataset.article) openArticle(el.dataset.article);
      else openFolder(el.dataset.path);
    });
    el.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation();
      if (el.dataset.article) {
        articleMenu(el.dataset.article, basename(el.dataset.article), e.clientX, e.clientY);
      } else {
        folderMenu(el.dataset.path, basename(el.dataset.path) || '全部文章', e.clientX, e.clientY);
      }
    });
  });

  // 折叠 / 展开
  $('#folderTree').querySelectorAll('.chev:not(.hidden)').forEach(c => {
    c.addEventListener('click', e => {
      e.stopPropagation();
      const path = c.closest('.tree-row').dataset.path;
      const now = state.expanded[path] !== false;
      state.expanded[path] = !now;
      renderSidebar();
    });
  });

  // 悬停快捷操作
  $('#folderTree').querySelectorAll('.tree-acts button').forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation();
      const row = b.closest('.tree-row');
      const r = b.getBoundingClientRect();
      if (b.dataset.act === 'add') {
        newArticleDialog(row.dataset.path);
      } else if (row.dataset.article) {
        articleMenu(row.dataset.article, basename(row.dataset.article), r.left, r.bottom + 4);
      } else if (row.dataset.path) {
        folderMenu(row.dataset.path, basename(row.dataset.path), r.left, r.bottom + 4);
      }
    });
  });
}

/* ---------------- 目录拖拽（拖动移动 / 拖进垃圾桶删除） ---------------- */
function clearDropHints(){
  document.querySelectorAll('#folderTree .drop-on').forEach(el => el.classList.remove('drop-on'));
  const tz = document.getElementById('trashZone');
  if (tz) tz.classList.remove('hot');
}
function folderTargetOf(row){
  if (row.dataset.article) return parentOf(row.dataset.article);
  return row.dataset.path || '';
}
function bindTreeDrag(){
  const tree = document.getElementById('folderTree');
  if (!tree) return;

  tree.querySelectorAll('.tree-row').forEach(row => {
    const isArt = !!row.dataset.article;
    const path = isArt ? row.dataset.article : row.dataset.path;
    if (!isArt && !path) return; // 知识库根不拖

    row.setAttribute('draggable', 'true');
    row.addEventListener('dragstart', e => {
      state.dragItem = { type: isArt ? 'article' : 'folder', path };
      try { e.dataTransfer.setData('text/plain', path); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging'); clearDropHints(); state.dragItem = null;
    });

    row.addEventListener('dragover', e => {
      const item = state.dragItem; if (!item) return;
      const target = folderTargetOf(row);
      if (item.type === 'folder' && (target === item.path || target.startsWith(item.path + '/'))) return;
      if (target === parentOf(item.path)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drop-on');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-on'));
    row.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation();
      row.classList.remove('drop-on');
      const item = state.dragItem; if (!item) return;
      const target = folderTargetOf(row);
      if (item.type === 'folder' && (target === item.path || target.startsWith(item.path + '/'))) {
        toast('不能把分区放进它自己里面', 'err'); return;
      }
      await doMoveDrag(item, target);
    });
  });

  const tz = document.getElementById('trashZone');
  if (tz) {
    tz.ondragover = e => {
      const item = state.dragItem; if (!item) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      tz.classList.add('hot');
    };
    tz.ondragleave = () => tz.classList.remove('hot');
    tz.ondrop = async e => {
      e.preventDefault(); tz.classList.remove('hot');
      const item = state.dragItem; if (!item) return;
      state.dragItem = null;
      await deleteItem(item.type, item.path, basename(item.path));
    };
  }
}

async function doMoveDrag(item, toFolder) {
  const name = basename(item.path);
  if (parentOf(item.path) === toFolder) { toast('本来就在这个分区里'); return; }
  try {
    const r = await POST('/api/move', { from: item.path, toFolder, name });
    state.dragItem = null;
    toast('已移到「' + (toFolder ? basename(toFolder) : '清溯 Zora') + '」', 'ok');
    const wasOpen = state.articlePath === item.path;
    if (wasOpen && r && r.path) state.articlePath = r.path;
    await loadTree();
    if (wasOpen && r && r.path) document.getElementById('crumb').innerHTML = crumbHTML(parentOf(r.path), state.articleTitle);
  } catch (e) { toast(e.message, 'err'); }
}
/* ---------------- 内容区 ---------------- */
function cardHTML(a) {
  const cut = state.clipboard && state.clipboard.type === 'article' && state.clipboard.path === a.path ? ' cut' : '';
  return `
    <div class="card${cut}" data-path="${esc(a.path)}">
      <div class="t">${esc(a.title)}</div>
      <div class="s">${esc(a.snippet || '（暂无内容）')}</div>
      <div class="d">${fmtDate(a.mtime)}</div>
    </div>`;
}

function bindCards() {
  $('#content').querySelectorAll('.card').forEach(el => {
    el.addEventListener('click', () => openArticle(el.dataset.path));
    el.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation();
      const a = flattenArticles(state.tree).find(x => x.path === el.dataset.path);
      articleMenu(el.dataset.path, a ? a.title : basename(el.dataset.path), e.clientX, e.clientY);
    });
  });
}

/* ---------------- 首页：最近文章 ---------------- */
function dayBucket(ts) {
  if (!ts) return 3;
  const now = new Date();
  const s0 = t => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const d = Math.round((s0(now) - s0(new Date(ts))) / 86400000);
  if (d <= 0) return 0;
  if (d === 1) return 1;
  if (d < 7) return 2;
  return 3;
}
const BUCKET_NAME = ['今天', '昨天', '本周', '更早'];

function renderHome() {
  const all = flattenArticles(state.tree || { folders: [], articles: [] });
  const list = all.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const now = new Date();
  const buckets = [[], [], [], []];
  list.forEach(a => buckets[dayBucket(a.updated)].push(a));
  const hitem = a => `
    <div class="hitem" data-path="${esc(a.path)}">
      <span class="ht">${esc(a.title)}</span>
      <span class="hs">${esc((a.snippet || '').replace(/\s+/g, ' ').slice(0, 120))}</span>
      <span class="hm">${fmtEdited(a.updated, true)}</span>
    </div>`;
  const body = buckets.map((g, i) => {
    if (!g.length) return '';
    const capped = i === 3 && !state.homeMore;
    const shown = capped ? g.slice(0, 12) : g;
    const more = g.length - shown.length;
    return `<section class="hgroup">
      <h2>${BUCKET_NAME[i]}<span>${g.length}</span></h2>
      <div class="hlist">${shown.map(hitem).join('')}</div>
      ${more > 0 ? `<div class="hmore">还有 ${more} 篇</div>` : ''}
    </section>`;
  }).join('');
  $('#content').innerHTML = `
    <div class="home">
      <div class="homeHead">
        <div class="hh1">清溯 Zora</div>
        <div class="hh2">${now.getMonth() + 1} 月 ${now.getDate()} 日 · 共 ${list.length} 篇</div>
        <div class="hh3">按 <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>K</kbd> 直接找文章</div>
      </div>
      ${body || '<p class="hh0">还没有文章。点左上角的 ＋ 新建一篇。</p>'}
    </div>`;
  bindHome();
}

function bindHome() {
  $('#content').querySelectorAll('.hitem').forEach(el => {
    el.addEventListener('click', () => openArticle(el.dataset.path));
    el.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation();
      const a = flattenArticles(state.tree).find(x => x.path === el.dataset.path);
      articleMenu(el.dataset.path, a ? a.title : basename(el.dataset.path), e.clientX, e.clientY);
    });
  });
  const more = $('#content').querySelector('.hmore');
  if (more) more.addEventListener('click', () => { state.homeMore = true; renderHome(); });
}

/* ---------------- 命令面板：Ctrl+K 找文章（Obsidian Quick Switcher） ---------------- */
let qsSel = 0, qsItems = [];

function ensureQS() {
  let m = document.getElementById('qsMask');
  if (m) return m;
  m = document.createElement('div');
  m.id = 'qsMask';
  m.className = 'qs-mask';
  m.innerHTML = `<div class="qs-box">
    <input id="qsInput" placeholder="搜索标题或路径…" autocomplete="off" spellcheck="false">
    <div class="qs-list" id="qsList"></div>
    <div class="qs-foot">
      <span><kbd>↑</kbd><kbd>↓</kbd> 选</span>
      <span><kbd>Enter</kbd> 打开</span>
      <span><kbd>Esc</kbd> 关</span>
      <span class="qs-tip">搜不到就回车新建</span>
    </div>
  </div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown', e => { if (e.target === m) closeQS(); });
  const input = m.querySelector('#qsInput');
  input.addEventListener('input', () => qsRender(input.value));
  input.addEventListener('keydown', qsKey);
  return m;
}

function openQS() {
  const m = ensureQS();
  m.classList.add('on');
  const input = m.querySelector('#qsInput');
  input.value = '';
  qsRender('');
  setTimeout(() => input.focus(), 20);
}

function closeQS() {
  const m = document.getElementById('qsMask');
  if (m) m.classList.remove('on');
}

function qsScore(q, a) {
  const t = a.title.toLowerCase(), p = a.path.toLowerCase();
  if (t.startsWith(q)) return 4;
  if (t.includes(q)) return 3;
  if (p.includes(q)) return 2;
  let i = 0;
  for (const ch of t) { if (ch === q[i]) i++; if (i >= q.length) return 1; }
  return 0;
}

function qsRender(q) {
  const all = flattenArticles(state.tree || { folders: [], articles: [] });
  const qq = (q || '').trim().toLowerCase();
  let items;
  if (!qq) {
    items = all.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 10);
  } else {
    items = all.filter(a => qsScore(qq, a) > 0)
      .sort((a, b) => (qsScore(qq, b) - qsScore(qq, a)) || (b.updated || 0) - (a.updated || 0))
      .slice(0, 12);
  }
  qsItems = items;
  qsSel = 0;
  const el = document.getElementById('qsList');
  if (!el) return;
  if (!items.length) {
    el.innerHTML = `<div class="qs-empty">没有匹配的。<b>回车</b>新建「${esc((q || '').trim())}」</div>`;
    return;
  }
  el.innerHTML = items.map((a, i) => `<div class="qs-item${i === 0 ? ' sel' : ''}" data-i="${i}">
    <span class="qt">${esc(a.title)}</span>
    <span class="qp">${esc(a.path)}</span>
    <span class="qm">${fmtEdited(a.updated, true)}</span>
  </div>`).join('');
  el.querySelectorAll('.qs-item').forEach(node => {
    node.addEventListener('mouseenter', () => qsSet(+node.dataset.i));
    node.addEventListener('click', () => qsOpen(+node.dataset.i));
  });
}

function qsSet(i) {
  qsSel = i;
  document.querySelectorAll('#qsList .qs-item').forEach((n, k) => n.classList.toggle('sel', k === i));
  const n = document.querySelector('#qsList .qs-item.sel');
  if (n) n.scrollIntoView({ block: 'nearest' });
}

function qsOpen(i) {
  const a = qsItems[i];
  if (!a) return;
  closeQS();
  openArticle(a.path);
}

function qsKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); qsSet(Math.min(qsItems.length - 1, qsSel + 1)); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); qsSet(Math.max(0, qsSel - 1)); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const q = e.target.value.trim();
    if (qsItems.length && !e.shiftKey) { qsOpen(qsSel); return; }
    if (q) { closeQS(); newArticleDialog('', q); }
  } else if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation(); closeQS();
  }
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && /^[kKoO]$/.test(e.key)) {
    const t = e.target || {};
    if (/INPUT|TEXTAREA|SELECT/i.test(t.tagName || '') || t.isContentEditable) return;
    e.preventDefault();
    openQS();
  }
});

/* Esc：关掉面板 / 从文章回到首页 */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const mask = document.getElementById('qsMask');
  if (mask && mask.classList.contains('on')) return;
  const t = e.target || {};
  if (/INPUT|TEXTAREA|SELECT/i.test(t.tagName || '') || t.isContentEditable) return;
  if (state.view === 'article' || state.view === 'graph') openHome();
});
function findFolder(node, path) {
  if (node.path === path) return node;
  for (const f of node.folders) {
    const hit = findFolder(f, path);
    if (hit) return hit;
  }
  return null;
}

/* ---------------- 文章渲染 ---------------- */
// 预处理：[[双链]] -> 内链；相对图片路径 -> /data/ 绝对路径
function preprocessMd(md, articlePath) {
  const dir = articlePath ? articlePath.replace(/\/[^/]*$/, '') : '';
  // ![[xxx.png]] 与 [[xxx.png]] 图片嵌入
  md = md.replace(/!?\[\[([^\]|]+?\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg)(?:\|[^\]]*)?\]\]/gi,
    (m, img) => `![img](/data/${dir ? dir + '/' : ''}${encodeURIComponent(img.trim())})`);
  // 普通图片相对路径
  md = md.replace(/!\[([^\]]*)\]\((?!https?:|\/|data:)([^)]+)\)/g,
    (m, alt, img) => `![${alt}](/data/${dir ? dir + '/' : ''}${img.trim().split(' ').map(encodeURIComponent).join(' ')})`);
  // 高亮 ==文字==
  md = md.replace(/==([^=\n]+)==/g, '<mark class="hl">$1</mark>');
  // wiki 链接 [[名字]] 或 [[名字|别名]]
  md = md.replace(/!?\[\[([^\]]+)\]\]/g, (m, inner) => {
    const [target, alias] = inner.split('|').map(s => s.trim());
    return `<a class="wl" data-wiki="${esc(target)}">${esc(alias || target)}</a>`;
  });
  return md;
}

function renderArticle() {
  const title = state.articleTitle;
  const body = marked.parse(preprocessMd(state.articleContent, state.articlePath), { breaks: true });
  $('#content').innerHTML = `
    <div class="article-wrap">
      <div class="article-head">
        <span class="back-link" id="backBtn">← 返回</span>
        <h1>${esc(title)}</h1>
        <div class="meta">
          <span>📄 ${esc(state.articlePath)}</span>
          <span id="saveState">点击文字即可直接编辑</span>
        </div>
        <div class="article-actions">
          <button class="btn btn-ghost btn-sm" id="btnMove">📂 移动 / 重命名</button>
          <button class="btn btn-danger btn-sm" id="btnDelete">删除</button>
        </div>
      </div>

      <div class="editor-toolbar" id="editorToolbar">
        <select id="tbHeading" title="字体大小（标题级别）">
          <option value="">正文</option>
          <option value="h1">标题 H1</option>
          <option value="h2">标题 H2</option>
          <option value="h3">标题 H3</option>
          <option value="h4">标题 H4</option>
        </select>
        <select id="tbSize" title="字号">
          <option value="">字号</option>
          <option value="15px">特小 15px</option>
          <option value="17px">小 17px</option>
          <option value="19.5px">标准 19.5px（=正文）</option>
          <option value="24px">大 24px</option>
          <option value="32px">特大 32px</option>
          <option value="40px">超大 40px</option>
        </select>
        <span class="tb-sep"></span>
        <button data-tb="bold" title="加粗（Ctrl+B）"><b>B</b></button>
        <button data-tb="italic" title="斜体"><i>I</i></button>
        <button data-tb="underline" title="下划线"><u>U</u></button>
        <button data-tb="highlight" title="高亮">H</button>
        <span class="tb-color-wrap">
          <button id="tbColorBtn" title="文字颜色">颜色 ▾</button>
          <div class="color-pop" id="colorPop">
            ${['#23283b', '#e5484d', '#e78a2e', '#e0b400', '#1d9a6c', '#0d9488', '#4f6ef7', '#8e4fd0', '#d6409f', '#9aa1b2']
              .map(c => `<span class="swatch" data-color="${c}" style="background:${c}" title="${c}"></span>`).join('')}
          </div>
        </span>
        <span class="tb-sep"></span>
        <button id="tbImage" title="插入图片">🖼 图</button>
        <button id="tbCode" title="插入代码块">&lt;/&gt;</button>
        <button data-tb="quote" title="引用">❝</button>
        <button data-tb="list" title="无序列表">•≡</button>
        <input type="file" id="tbImgInput" accept="image/*" hidden>
      </div>

      <div class="markdown wysiwyg" id="docBody" contenteditable="true" spellcheck="false">${body}</div>
    </div>`;

  $('#backBtn').addEventListener('click', () => openHome());
  $('#btnMove').addEventListener('click', () => moveDialog(state.articlePath, title, true));
  $('#btnDelete').addEventListener('click', async () => {
    if (!confirm(`确定删除「${title}」吗？此操作不可恢复。`)) return;
    await POST('/api/delete', { path: state.articlePath });
    toast('已删除', 'ok');
    await loadTree();
    state.articlePath = null; state.view = 'home';
    openHome();
  });

  const doc = $('#docBody');

  /* ---- 自动保存（实时） ---- */
  let saveTimer = null;
  async function doSave() {
    const el = $('#docBody');
    if (!el) return;
    const md = htmlToMd(el);
    if (md === state.articleContent) { state.dirty = false; return; }
    state.articleContent = md;
    try {
      await POST('/api/save', { path: state.articlePath, content: md });
      state.dirty = false;
      $('#saveState').textContent = '✓ 已自动保存';
      var _eaS=document.getElementById('editedAt'); if(_eaS) _eaS.textContent='已保存 '+new Date().toTimeString().slice(0,5);
    } catch { $('#saveState').textContent = '⚠ 保存失败'; }
  }
  function scheduleSave() {
    $('#saveState').textContent = '编辑中…';
    state.dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 800);
  }
  state.flushDoc = doSave;

  doc.addEventListener('input', scheduleSave);
  doc.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); scheduleSave(); doSave(); }
  });
  // 粘贴一律按纯文本插入，保持格式干净
  doc.addEventListener('paste', e => {
    e.preventDefault();
    const t = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, t);
  });

  /* ---- 工具栏 ---- */
  const cmd = (c, v) => { restoreSel(); document.execCommand(c, false, v); scheduleSave(); };
  $('#editorToolbar').querySelectorAll('button[data-tb]').forEach(b => {
    b.addEventListener('mousedown', e => e.preventDefault()); // 防止选区丢失
    b.addEventListener('click', () => {
      const k = b.dataset.tb;
      if (k === 'bold') cmd('bold');
      else if (k === 'italic') cmd('italic');
      else if (k === 'underline') cmd('underline');
      else if (k === 'highlight') { restoreSel(); surroundSelection(doc, 'mark'); scheduleSave(); }
      else if (k === 'quote') cmd('formatBlock', '<blockquote>');
      else if (k === 'list') cmd('insertUnorderedList');
    });
  });
  // 下拉框（正文/标题、字号、颜色）：不阻止 mousedown，否则浏览器下拉弹不开
  $('#tbHeading').addEventListener('change', e => {
    if (e.target.value) cmd('formatBlock', '<' + e.target.value + '>');
    e.target.value = '';
  });
  $('#tbSize').addEventListener('change', e => {
    if (e.target.value) { restoreSel(); surroundSelection(doc, 'span', 'font-size:' + e.target.value); scheduleSave(); }
    e.target.value = '';
  });
  // 颜色：色块面板（点击色块直接给选中文字上色）
  const colorBtn = $('#tbColorBtn');
  const colorPop = $('#colorPop');
  colorBtn.addEventListener('mousedown', e => e.preventDefault()); // 保住选区
  colorBtn.addEventListener('click', e => {
    e.stopPropagation();
    colorPop.classList.toggle('show');
  });
  colorPop.querySelectorAll('.swatch').forEach(sw => {
    sw.addEventListener('mousedown', e => e.preventDefault());
    sw.addEventListener('click', e => {
      e.stopPropagation();
      restoreSel();
      surroundSelection(doc, 'span', 'color:' + sw.dataset.color);
      colorPop.classList.remove('show');
      scheduleSave();
    });
  });
  document.addEventListener('click', () => colorPop.classList.remove('show'));
  $('#tbCode').addEventListener('mousedown', e => e.preventDefault());
  $('#tbCode').addEventListener('click', () => {
    doc.focus();
    document.execCommand('insertHTML', false, '<pre><code>// 在这里输入代码</code></pre><p><br></p>');
    scheduleSave();
  });
  $('#tbImage').addEventListener('click', () => $('#tbImgInput').click());
  $('#tbImgInput').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(',')[1]);
        r.onerror = rej;
        r.readAsDataURL(f);
      });
      const stamp = Date.now();
      const safe = f.name.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_');
      const r = await POST('/api/upload', { folder: '_assets', name: stamp + '-' + safe, b64 });
      doc.focus();
      document.execCommand('insertHTML', false, `<img src="/data/${r.path}" alt="图片">`);
      scheduleSave();
      toast('图片已插入', 'ok');
    } catch (err) { toast('图片上传失败：' + err.message, 'err'); }
  });

  /* ---- 双链：Ctrl+点击 跳转 ---- */
  doc.querySelectorAll('.wl').forEach(el => {
    el.title = 'Ctrl+点击 打开「' + el.textContent + '」';
    el.addEventListener('click', e => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault(); e.stopPropagation();
        openWikiLink(el.dataset.wiki);
      }
    });
  });
}

async function openWikiLink(target) {
  const results = await GET('/api/search?q=' + encodeURIComponent(target));
  const exact = results.find(r => r.title === target) || results[0];
  if (exact) openArticle(exact.path);
  else if (confirm(`没有找到「${target}」，要新建这篇文章吗？`)) newArticleDialog('', target);
}

/* 选区包裹（高亮 / 变色） */
function surroundSelection(doc, tag, style) {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) { toast('先选中一段文字'); return; }
  const range = sel.getRangeAt(0);
  const frag = range.extractContents();
  const el = document.createElement(tag);
  if (style) el.setAttribute('style', style);
  el.appendChild(frag);
  range.insertNode(el);
  sel.removeAllRanges();
  const r2 = document.createRange();
  r2.selectNodeContents(el);
  sel.addRange(r2);
}

/* ---- WYSIWYG HTML → Markdown 序列化 ---- */
function htmlToMd(root) {
  function inlineSeq(node) {
    let out = '';
    node.childNodes.forEach(ch => { out += serAny(ch); });
    return out;
  }
  function serAny(node) {
    if (node.nodeType === 3) return node.nodeValue.replace(/\u00a0/g, ' ');
    if (node.nodeType !== 1) return '';
    const tag = node.tagName;
    switch (tag) {
      case 'BR': return '\n';
      case 'IMG': return `![${node.getAttribute('alt') || 'img'}](${node.getAttribute('src') || ''})`;
      case 'STRONG': case 'B': { const t = inlineSeq(node).trim(); return t ? `**${t}**` : ''; }
      case 'EM': case 'I': { const t = inlineSeq(node).trim(); return t ? `*${t}*` : ''; }
      case 'U': return `<u>${inlineSeq(node)}</u>`;
      case 'MARK': return `==${inlineSeq(node)}==`;
      case 'CODE': return '`' + node.textContent + '`';
      case 'DEL': case 'S': return `~~${inlineSeq(node)}~~`;
      case 'SPAN': {
        const st = node.getAttribute('style') || '';
        const c = st.match(/color:\s*([^;]+)/);
        const fs = st.match(/font-size:\s*([^;]+)/);
        const style = [c ? `color:${c[1].trim()}` : '', fs ? `font-size:${fs[1].trim()}` : ''].filter(Boolean).join(';');
        return style ? `<span style="${style}">${inlineSeq(node)}</span>` : inlineSeq(node);
      }
      case 'FONT': {
        const c = node.getAttribute('color');
        const sz = ({ 1: '12px', 2: '13px', 3: '16px', 4: '18px', 5: '24px', 6: '32px', 7: '48px' })[node.getAttribute('size')];
        const style = [c ? `color:${c}` : '', sz ? `font-size:${sz}` : ''].filter(Boolean).join(';');
        return style ? `<span style="${style}">${inlineSeq(node)}</span>` : inlineSeq(node);
      }
      case 'A': {
        const t = node.textContent;
        if (node.classList.contains('wl') || (node.getAttribute('href') || '').startsWith('#')) return `[[${t}]]`;
        return `[${t}](${node.getAttribute('href') || ''})`;
      }
      default: return inlineSeq(node);
    }
  }
  function isBlockEl(el) { return el && el.nodeType === 1 && /^(P|DIV|UL|OL|BLOCKQUOTE|PRE|H[1-6]|TABLE|HR)$/.test(el.tagName); }
  function blockSeq(node, indent) {
    let out = '';
    node.childNodes.forEach(ch => {
      if (ch.nodeType === 1 || ch.nodeType === 3) {
        const b = block(ch, indent);
        if (b !== null) out += b;
      }
    });
    return out;
  }
  function block(node, indent) {
    const pad = '  '.repeat(indent);
    if (node.nodeType === 3) {
      const t = node.nodeValue.replace(/\u00a0/g, ' ').trim();
      return t ? pad + t + '\n\n' : '';
    }
    if (node.nodeType !== 1) return '';
    switch (node.tagName) {
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
        return pad + '#'.repeat(+node.tagName[1]) + ' ' + inlineSeq(node).replace(/\n/g, ' ').trim() + '\n\n';
      case 'P': case 'DIV': {
        const hasBlock = [...node.children].some(isBlockEl);
        if (hasBlock) return blockSeq(node, indent);
        const t = inlineSeq(node).replace(/\n/g, ' ').trim();
        return t ? pad + t + '\n\n' : '';
      }
      case 'BLOCKQUOTE': {
        const inner = blockSeq(node, 0).trimEnd();
        if (!inner) return '';
        return inner.split('\n').map(l => pad + '> ' + l).join('\n') + '\n\n';
      }
      case 'UL': case 'OL': {
        let i = 1, out = '';
        node.childNodes.forEach(li => {
          if (li.nodeType !== 1 || li.tagName !== 'LI') return;
          const marker = node.tagName === 'UL' ? '-' : (i++) + '.';
          const blockChildren = [...li.children].filter(isBlockEl);
          if (blockChildren.length) {
            let first = '';
            li.childNodes.forEach(c => { if (!isBlockEl(c)) first += serAny(c); });
            out += pad + marker + ' ' + first.replace(/\n/g, ' ').trim() + '\n';
            blockChildren.forEach(c => { out += block(c, indent + 1); });
          } else {
            out += pad + marker + ' ' + inlineSeq(li).replace(/\n/g, ' ').trim() + '\n';
          }
        });
        return out + '\n';
      }
      case 'PRE':
        return pad + '```\n' + node.textContent.replace(/\n+$/, '') + '\n' + pad + '```\n\n';
      case 'HR':
        return pad + '---\n\n';
      case 'TABLE': {
        const rows = [...node.querySelectorAll('tr')];
        if (!rows.length) return '';
        const lines = rows.map((tr, idx) => {
          const cells = [...tr.children].map(td => inlineSeq(td).replace(/\n/g, ' ').trim());
          let line = '| ' + cells.join(' | ') + ' |';
          if (idx === 0) line += '\n|' + cells.map(() => ' --- ').join('|') + '|';
          return line;
        });
        return lines.join('\n') + '\n\n';
      }
      case 'IMG':
        return pad + `![${node.getAttribute('alt') || 'img'}](${node.getAttribute('src') || ''})` + '\n\n';
      default: {
        const t = inlineSeq(node).replace(/\n/g, ' ').trim();
        return t ? pad + t + '\n\n' : '';
      }
    }
  }
  return blockSeq(root, 0).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function parentOf(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }

/* ---------------- 视图切换 ---------------- */
// 面包屑：知识库 / 分区 / 子分区 / 当前位置（可点击：点根回首页，点分区定位到该级）
/* 最后修改时间：目录用短格式，顶部用完整格式 */
function fmtEdited(ts, short) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  const s0 = t => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((s0(now) - s0(d)) / 86400000);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (days <= 0) return short ? hm : '今天 ' + hm;
  if (days === 1) return short ? '昨天' : '昨天 ' + hm;
  if (days < 7) return short ? days + ' 天' : days + ' 天前';
  const md = (d.getMonth() + 1) + '.' + d.getDate();
  return d.getFullYear() === now.getFullYear() ? md : String(d.getFullYear()).slice(2) + '.' + md;
}

function findArticle(path) {
  let hit = null;
  (function walk(n) {
    if (!n || hit) return;
    for (const a of n.articles || []) if (a.path === path) { hit = a; return; }
    for (const f of n.folders || []) walk(f);
  })(state.tree);
  return hit;
}
function crumbHTML(folderPath, currentLabel) {
  const parts = ['清溯 Zora', ...folderPath.split('/').filter(Boolean)];
  let acc = '';
  let html = parts.map((p, i) => {
    acc = i === 0 ? '' : (acc ? acc + '/' + p : p);
    return `<span class="lnk" data-goto="${esc(acc)}" title="点击跳转">${esc(p)}</span>`;
  }).join(' <span class="sep">/</span> ');
  if (currentLabel) html += ` <span class="sep">/</span> <b class="cur">${esc(currentLabel)}</b>`;
  return html;
}

// 面包屑点击 → 定位（根 = 首页，其余 = 树中展开并高亮该分区）
function gotoFolder(path) {
  if (!path) { openHome(); return; }
  state.folder = path;
  state.expanded[path] = true;
  let anc = parentOf(path);
  while (anc) { state.expanded[anc] = true; anc = parentOf(anc); }
  renderSidebar();
  toast('已定位到「' + basename(path) + '」');
}

/* ---------------- 浏览历史：浏览器后退可用 ---------------- */
var _bootAt = Date.now() + 1200;
var _noPush = false;
function navTo(qs) {
  if (_noPush || Date.now() < _bootAt) return;
  try {
    if (location.search.replace(/^\?/, "") === String(qs || "").replace(/^\?/, "")) return;
    history.pushState(null, "", qs || location.pathname);
  } catch (e) {}
}
window.addEventListener("popstate", function () {
  _noPush = true;
  var p = new URLSearchParams(location.search).get("path");
  var v = new URLSearchParams(location.search).get("view");
  var run = p ? openArticle(p) : (v === "graph" ? openGraph() : Promise.resolve(openHome()));
  Promise.resolve(run).then(function () { setTimeout(function () { _noPush = false; }, 0); }, function () { _noPush = false; });
});
function openHome() {
  state.view = 'home'; state.folder = ''; state.editing = false; state.searchResults = null;
  navTo("");
  setRibbon('rbFiles');
  $('#crumb').innerHTML = `清溯 Zora <small>${countArticles(state.tree)} 篇文章</small>`;
  var _ez0 = document.getElementById('editedAt'); if (_ez0) _ez0.textContent = '';
  renderHome();
}

function openFolder(path) {
  // 点击文件夹：仅在目录树中展开/收起，不渲染文章列表（飞书/语雀逻辑）
  const wasOpen = state.expanded[path] === true;
  state.expanded[path] = !wasOpen;
  state.folder = path;
  renderSidebar();
}

async function openArticle(path) {
  if (state.flushDoc && state.dirty) await state.flushDoc(); // 离开前把正在编辑的内容存掉
  const data = await GET('/api/article?path=' + encodeURIComponent(path));
  state.view = 'article'; state.articlePath = path;
  navTo("?path=" + encodeURIComponent(path));
  state.articleContent = data.content; state.articleTitle = data.title;
  state.editing = false;
  setRibbon('rbFiles');
  // 展开文章所在的各级父分区，保证树中能看到高亮
  let anc = parentOf(path);
  while (anc) { state.expanded[anc] = true; anc = parentOf(anc); }
  var _cr = document.getElementById('crumb'); _cr.innerHTML = crumbHTML(parentOf(path), data.title);
  var _ea = document.getElementById('editedAt'), _art = findArticle(path);
  if (_ea) _ea.textContent = (_art && _art.updated) ? ('最后修改 ' + fmtEdited(_art.updated)) : '';
  renderArticle();
  renderSidebar(); // 侧栏高亮当前文章
}

/* ---------------- 关系图谱（Obsidian 同款力导向图） ---------------- */
async function openGraph() {
  if (state.flushDoc && state.dirty) await state.flushDoc();
  state.view = 'graph';
  navTo("?view=graph");
  setRibbon('rbGraph');
  $('#crumb').innerHTML = `清溯 Zora <span class="sep">/</span> 关系图谱 <small>拖拽 · 缩放 · 点击节点打开文章</small>`;
  var _ez0 = document.getElementById('editedAt'); if (_ez0) _ez0.textContent = '';
  $('#content').innerHTML = `
    <div class="graph-wrap" id="graphWrap">
      <canvas id="graphCanvas"></canvas>
      <div class="graph-hud"><i style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#f97316;margin-right:7px;vertical-align:middle;box-shadow:0 0 0 2px rgba(249,115,22,.16)"></i>颜色越鲜=越近写的 · 滚轮缩放 · 拖背景平移 · 单击打开</div>
    </div>`;
  let g;
  try { g = await GET('/api/graph'); }
  catch (e) { $('#content').innerHTML = '<div class="empty"><h3>图谱数据加载失败</h3></div>'; return; }
  if (state.view !== 'graph') return; // 已切换走

  /* 每个节点的"新鲜度"：越近的颜色越鲜，越久的越灰 */
  const updMap = {};
  try {
    const tr = await GET('/api/tree');
    (function walkNode(nd){ (nd.articles||[]).forEach(function(a){ updMap[a.path]=a.updated||0; }); (nd.folders||[]).forEach(walkNode); })(tr);
  } catch (e) {}
  function ageW(ts){
    if (!ts) return 0;
    const days = (Date.now() - ts) / 86400000;
    const w = Math.max(0, Math.min(1, 1 - days / 120));
    return Math.pow(w, 0.65);
  }
  function ageCol(ts){
    const w = ageW(ts);                       /* 1 = 最近，0 = 很远 */
    if (w >= 0.62) {                            /* 橙：最近写的 */
      const k = (w - 0.62) / 0.38;
      return 'hsl(24,' + Math.round(42 + 50 * k) + '%,' + Math.round(68 - 20 * k) + '%)';
    }
    if (w >= 0.26) {                            /* 蓝：中等新旧 */
      const k = (w - 0.26) / 0.36;
      return 'hsl(197,' + Math.round(8 + 46 * k) + '%,' + Math.round(74 - 21 * k) + '%)';
    }
    return 'hsl(30,3%,' + Math.round(74 + 4 * (w / 0.26)) + '%)';   /* 灰：很久之前 / 没写日期 */
  }

  const canvas = $('#graphCanvas');
  const wrap = $('#graphWrap');
  const ctx = canvas.getContext('2d');

  function updOf(nd){
    if (updMap[nd.path] != null) return updMap[nd.path];
    var pre = nd.path ? nd.path + '/' : '';
    if (!pre) return 0;
    var mx = 0;
    for (var k in updMap) { if (k.indexOf(pre) === 0 && updMap[k] > mx) mx = updMap[k]; }
    return mx;
  }

  /* ---- 数据准备 ---- */
  const nodes = g.nodes.map((n, i) => {
    const ang = (i / Math.max(1, g.nodes.length)) * Math.PI * 2;
    const r = 160 + (i % 7) * 42;
    return {
      ...n, deg: 0, w: ageW(updOf(n)), col: ageCol(updOf(n)),
      x: Math.cos(ang) * r, y: Math.sin(ang) * r,
      vx: 0, vy: 0,
    };
  });
  const byId = nodes;
  const edges = g.edges.map(e => {
    byId[e.s].deg++; byId[e.t].deg++;
    return e;
  });

  /* ---- 视图变换（平移 / 缩放） ---- */
  const view = { x: 0, y: 0, k: 1 };
  function applySize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = wrap.clientWidth * dpr;
    canvas.height = wrap.clientHeight * dpr;
    canvas.style.width = wrap.clientWidth + 'px';
    canvas.style.height = wrap.clientHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  applySize();
  // 初始把世界原点放到画布正中央（打开即满屏居中）
  view.x = wrap.clientWidth / 2;
  view.y = wrap.clientHeight / 2;
  const toWorld = (sx, sy) => ({ x: (sx - view.x) / view.k, y: (sy - view.y) / view.k });

  /* ---- 力学模拟 ---- */
  let alpha = 1;
  let hoverId = null;
  let dragId = null;
  let panning = false;
  let mouseSX = 0, mouseSY = 0, moved = 0;

  function tick() {
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const cx = 0, cy = 0;
    // 斥力（节点间）
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { d2 = 1; dx = Math.random(); dy = Math.random(); }
        const d = Math.sqrt(d2);
        const f = (2600 * alpha) / d2;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
      // 向心力
      a.vx += (cx - a.x) * 0.0035 * alpha;
      a.vy += (cy - a.y) * 0.0035 * alpha;
    }
    // 连线弹簧
    for (const e of edges) {
      const a = byId[e.s], b = byId[e.t];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = 110;
      const f = (d - target) * 0.012 * alpha;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    // 积分 + 阻尼
    for (const n of nodes) {
      if (n.id === dragId) { n.vx = n.vy = 0; continue; }
      n.vx *= 0.86; n.vy *= 0.86;
      // 轻微布朗漂浮（Obsidian 的活体感）
      n.vx += (Math.random() - 0.5) * 0.06;
      n.vy += (Math.random() - 0.5) * 0.06;
      n.x += Math.max(-14, Math.min(14, n.vx));
      n.y += Math.max(-14, Math.min(14, n.vy));
    }
    alpha = Math.max(0.35, alpha * 0.995); // 收敛到持续微动
  }

  function nodeR(n) { return 4.5 + Math.min(7, n.deg * 1.4) + (n.w || 0) * 1.8; }

  function draw() {
    const W = wrap.clientWidth, H = wrap.clientHeight;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);
    // 连线
    for (const e of edges) {
      const a = byId[e.s], b = byId[e.t];
      const hot = hoverId !== null && (e.s === hoverId || e.t === hoverId);
      ctx.strokeStyle = hot ? 'rgba(234,88,12,.9)' : 'rgba(125,131,155,.26)';
      ctx.lineWidth = hot ? 1.6 / view.k : 1 / view.k;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    // 节点 + 标签
    for (const n of nodes) {
      const hot = hoverId === n.id;
      const near = hoverId !== null && edges.some(e => (e.s === hoverId && e.t === n.id) || (e.t === hoverId && e.s === n.id));
      ctx.beginPath();
      ctx.arc(n.x, n.y, nodeR(n) + (hot ? 2.5 : 0), 0, Math.PI * 2);
      ctx.fillStyle = hot ? '#9a3412' : near ? '#fdba74' : n.col;
      ctx.globalAlpha = hoverId === null || hot || near ? 1 : 0.35;
      ctx.fill();
      ctx.globalAlpha = hoverId === null || hot || near ? 1 : 0.4;
      ctx.font = '12px Georgia, "Noto Serif SC", serif';
      ctx.fillStyle = hot ? '#4f6ef7' : '#5a6076';
      ctx.textAlign = 'center';
      ctx.fillText(n.title, n.x, n.y + nodeR(n) + 14);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  let rafId = null;
  function loop() {
    if (state.view !== 'graph' || !document.getElementById('graphCanvas')) { return; } // 离开视图自动停
    tick();
    draw();
    rafId = requestAnimationFrame(loop);
  }
  state.graphRaf = rafId;
  loop();

  /* ---- 交互 ---- */
  function hitNode(sx, sy) {
    const p = toWorld(sx, sy);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = p.x - n.x, dy = p.y - n.y;
      if (dx * dx + dy * dy < Math.pow(nodeR(n) + 5, 2)) return n;
    }
    return null;
  }
  canvas.addEventListener('mousedown', e => {
    const r = canvas.getBoundingClientRect();
    mouseSX = e.clientX - r.left; mouseSY = e.clientY - r.top;
    moved = 0;
    const n = hitNode(mouseSX, mouseSY);
    if (n) { dragId = n.id; }
    else { panning = true; wrap.classList.add('grabbing'); }
  });
  window.addEventListener('mousemove', e => {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (dragId !== null) {
      const p = toWorld(sx, sy);
      const n = byId[dragId];
      moved += Math.abs(sx - mouseSX) + Math.abs(sy - mouseSY);
      n.x = p.x; n.y = p.y;
    } else if (panning) {
      view.x += sx - mouseSX; view.y += sy - mouseSY;
      moved += Math.abs(sx - mouseSX) + Math.abs(sy - mouseSY);
      mouseSX = sx; mouseSY = sy;
    } else if (state.view === 'graph') {
      const n = hitNode(sx, sy);
      if ((n ? n.id : null) !== hoverId) { hoverId = n ? n.id : null; canvas.style.cursor = n ? 'pointer' : ''; }
    }
  });
  window.addEventListener('mouseup', e => {
    if (dragId !== null && moved < 5) openArticle(byId[dragId].path); // 单击节点 → 打开文章
    dragId = null; panning = false;
    wrap.classList.remove('grabbing');
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const before = toWorld(sx, sy);
    view.k = Math.min(3, Math.max(0.25, view.k * (e.deltaY < 0 ? 1.12 : 0.89)));
    const after = toWorld(sx, sy);
    view.x += (after.x - before.x) * view.k;
    view.y += (after.y - before.y) * view.k;
  }, { passive: false });
  window.addEventListener('resize', () => { if (state.view === 'graph') applySize(); });
}

/* ---------------- 弹窗 ---------------- */
function modal(html) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal">${html}</div>`;
  mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
  document.body.appendChild(mask);
  return mask;
}

async function folderOptions(selected) {
  const folders = await GET('/api/folders');
  const opts = [`<option value="">（根目录）</option>`]
    .concat(folders.map(f => `<option value="${esc(f)}" ${f === selected ? 'selected' : ''}>${esc(f)}</option>`));
  return opts.join('');
}

async function newArticleDialog(presetFolder = '', prefillTitle = '') {
  const folders = await folderOptions(presetFolder || (state.folder || ''));
  const m = modal(`
    <h3>✍️ 新建文章</h3>
    <div class="field"><label>标题</label>
      <input type="text" id="naTitle" placeholder="给这篇文章起个名字" value="${esc(prefillTitle || '')}"></div>
    <div class="field"><label>保存到分区</label><select id="naFolder">${folders}</select></div>
    <div class="field"><label>内容（支持 Markdown）</label>
      <textarea id="naContent" placeholder="# 标题&#10;正文…&#10;&#10;支持 Markdown 语法和 [[双链]]"></textarea></div>
    <div class="foot">
      <button class="btn btn-ghost" id="naCancel">取消</button>
      <button class="btn btn-primary" id="naOk">创建</button>
    </div>`);
  m.querySelector('#naCancel').addEventListener('click', () => m.remove());
  m.querySelector('#naTitle').focus();
  const submit = async () => {
    const title = m.querySelector('#naTitle').value.trim();
    if (!title) { toast('请填写标题', 'err'); return; }
    const folder = m.querySelector('#naFolder').value;
    const r = await POST('/api/create', { title, folder, content: m.querySelector('#naContent').value });
    m.remove();
    toast('文章已创建', 'ok');
    await loadTree();
    await openArticle(r.path);
  };
  m.querySelector('#naOk').addEventListener('click', submit);
  m.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); });
}

async function newFolderDialog(presetParent = '') {
  const folders = await folderOptions(presetParent);
  const m = modal(`
    <h3>📁 新建分区</h3>
    <div class="field"><label>分区名称</label>
      <input type="text" id="nfName" placeholder="例如：读书笔记"></div>
    <div class="field"><label>上级分区（可选，可建子分区）</label><select id="nfParent">${folders}</select></div>
    <div class="foot">
      <button class="btn btn-ghost" id="nfCancel">取消</button>
      <button class="btn btn-primary" id="nfOk">创建</button>
    </div>`);
  m.querySelector('#nfCancel').addEventListener('click', () => m.remove());
  m.querySelector('#nfName').focus();
  m.querySelector('#nfOk').addEventListener('click', async () => {
    const name = m.querySelector('#nfName').value.trim();
    if (!name) { toast('请填写分区名', 'err'); return; }
    await POST('/api/folder', { name, parent: m.querySelector('#nfParent').value });
    m.remove();
    toast('分区已创建', 'ok');
    await loadTree();
    renderSidebar();
  });
}

async function renameFolderDialog(path, name) {
  const m = modal(`
    <h3>✏️ 重命名分区</h3>
    <div class="field"><label>新名称</label>
      <input type="text" id="rnName" value="${esc(name)}"></div>
    <div class="foot">
      <button class="btn btn-ghost" id="rnCancel">取消</button>
      <button class="btn btn-primary" id="rnOk">确定</button>
    </div>`);
  m.querySelector('#rnCancel').addEventListener('click', () => m.remove());
  m.querySelector('#rnName').focus();
  m.querySelector('#rnOk').addEventListener('click', async () => {
    const newName = m.querySelector('#rnName').value.trim();
    if (!newName || newName === name) { m.remove(); return; }
    try {
      await POST('/api/move', { from: path, toFolder: parentOf(path), name: newName });
      m.remove();
      toast('已重命名', 'ok');
      await loadTree();
      if (state.folder === path || state.folder.startsWith(path + '/')) {
        const parent = parentOf(path);
        openFolder(parent ? parent + '/' + newName : newName);
      } else renderCurrent();
    } catch (e) { toast(e.message, 'err'); }
  });
}

async function moveDialog(path, title, isArticle) {
  const folders = await folderOptions(parentOf(path));
  const m = modal(`
    <h3>📂 ${isArticle ? '移动 / 重命名文章' : '重命名分区'}</h3>
    <div class="field"><label>名称</label>
      <input type="text" id="mvName" value="${esc(title)}"></div>
    ${isArticle ? `<div class="field"><label>移动到分区</label><select id="mvFolder">${folders}</select></div>` : ''}
    <div class="foot">
      <button class="btn btn-ghost" id="mvCancel">取消</button>
      <button class="btn btn-primary" id="mvOk">确定</button>
    </div>`);
  m.querySelector('#mvCancel').addEventListener('click', () => m.remove());
  m.querySelector('#mvOk').addEventListener('click', async () => {
    const name = m.querySelector('#mvName').value.trim();
    if (!name) { toast('名称不能为空', 'err'); return; }
    const r = await POST('/api/move', {
      from: path,
      toFolder: isArticle ? m.querySelector('#mvFolder').value : parentOf(path),
      name: name + (isArticle ? '.md' : ''),
    });
    m.remove();
    toast('已完成', 'ok');
    await loadTree();
    openArticle(r.path);
  });
}

/* ---------------- 拖拽导入（支持整个文件夹） ---------------- */
let dragDepth = 0;

const TEXT_RE = /\.(md|txt|markdown)$/i;
const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

// 递归遍历拖入的目录，收集 {rel, file}（rel 为不含顶层文件夹名的相对路径）
function walkEntry(entry, prefix, out) {
  return new Promise(resolve => {
    if (entry.isFile) {
      entry.file(f => { out.push({ rel: prefix + f.name, file: f }); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => {
        reader.readEntries(async entries => {
          if (!entries.length) return resolve();
          for (const e of entries) await walkEntry(e, prefix, out);
          readBatch(); // readEntries 每次最多返回 100 条，需循环读完
        }, () => resolve());
      };
      readBatch();
    } else resolve();
  });
}

// 导入一组文件（rel 为相对路径，自动按子目录建分区）
async function importFiles(list, targetFolder) {
  const valid = list.filter(({ rel }) =>
    !rel.split('/').some(seg => seg.startsWith('.')) && (TEXT_RE.test(rel) || IMG_RE.test(rel)));
  if (!valid.length) { toast('没有可导入的文件（仅支持 md / txt / 图片）', 'err'); return; }

  const prog = document.createElement('div');
  prog.className = 'toast';
  prog.textContent = '准备导入…';
  $('#toastWrap').appendChild(prog);

  let ok = 0, fail = 0;
  for (let i = 0; i < valid.length; i++) {
    const { rel, file } = valid[i];
    const slash = rel.lastIndexOf('/');
    const dir = slash >= 0 ? rel.slice(0, slash) : '';
    const folder = [targetFolder, dir].filter(Boolean).join('/');
    prog.textContent = `导入中 ${i + 1}/${valid.length}：${file.name}`;
    try {
      if (TEXT_RE.test(rel)) {
        await POST('/api/upload', { folder, name: file.name, content: await file.text() });
      } else {
        const b64 = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result.split(',')[1]);
          r.onerror = rej;
          r.readAsDataURL(file);
        });
        await POST('/api/upload', { folder, name: file.name, b64 });
      }
      ok++;
    } catch { fail++; }
  }
  prog.remove();
  toast(`✅ 导入完成：成功 ${ok} 篇${fail ? `，失败 ${fail}` : ''}${targetFolder ? ` → ${targetFolder}` : ' → 根目录'}`, 'ok');
  await loadTree();
  renderCurrent();
}

window.addEventListener('dragenter', e => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  $('#dropTargetName').textContent = state.folder
    ? state.folder.split('/').pop() : '根目录';
  $('#dropOverlay').classList.add('show');
});
window.addEventListener('dragleave', e => {
  if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').classList.remove('show'); }
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', async e => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').classList.remove('show');
  const items = [...e.dataTransfer.items];
  if (!items.length) return;
  const target = state.folder || '';

  // 优先用 webkitGetAsEntry 递归读取（支持文件夹）
  const entries = items.map(it => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
  const list = [];
  if (entries.length) {
    for (const ent of entries) {
      if (ent.isFile) {
        await walkEntry(ent, '', list);
      } else if (ent.isDirectory) {
        // 拖入的文件夹本身映射为当前分区，其子项相对路径从内部算起
        const reader = ent.createReader();
        await new Promise(resolve => {
          const readBatch = () => reader.readEntries(async es => {
            if (!es.length) return resolve();
            for (const c of es) await walkEntry(c, '', list);
            readBatch();
          }, () => resolve());
          readBatch();
        });
      }
    }
  } else {
    // 兼容不支持 entry API 的浏览器
    for (const f of [...e.dataTransfer.files]) list.push({ rel: f.name, file: f });
  }
  if (list.length) await importFiles(list, target);
});

/* 导入文件夹按钮（选择目录，webkitdirectory） */
$('#btnImport').addEventListener('click', () => $('#importInput').click());
$('#importInput').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  // webkitRelativePath 形如 "所选文件夹/子目录/文件.md"，去掉第一层（所选文件夹本身）
  const list = files.map(f => {
    const rel = (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name;
    return { rel, file: f };
  });
  const target = state.folder || '';
  await importFiles(list, target);
});

/* ---------------- 初始化 ---------------- */
$('#btnNewArticle').addEventListener('click', () => newArticleDialog());
$('#btnNewFolder').addEventListener('click', () => newFolderDialog());

/* 活动栏（Obsidian 式 Ribbon） */
function setRibbon(which) {
  ['rbFiles', 'rbGraph'].forEach(id => { var b=document.getElementById(id); if(b) b.classList.toggle('active', id === which); });
}
$('#rbFiles').addEventListener('click', () => {
  setRibbon('rbFiles');
  $('#panelFiles').hidden = false;
  var _psb=document.getElementById('panelSearch'); if(_psb) _psb.hidden = true;
});
$('#rbGraph').addEventListener('click', () => { setRibbon('rbGraph'); openGraph(); });
$('#rbRandom').addEventListener('click', () => {
  const all = flattenArticles(state.tree);
  if (!all.length) { toast('还没有文章可以漫游', 'err'); return; }
  openArticle(all[Math.floor(Math.random() * all.length)].path);
  toast('🎲 随机漫游', 'ok');
});

// 面包屑点击导航
$('#crumb').addEventListener('click', e => {
  const lnk = e.target.closest('.lnk');
  if (!lnk) return;
  gotoFolder(lnk.dataset.goto);
});


// 空白处（左键单击 或 右键）→ 粘贴 / 新建文章 / 新建分区 菜单
function blankHit(e) {
  // 排除正文、卡片、按钮等交互元素；其余空白区域都算命中
  if (e.target.closest('.markdown') || e.target.closest('.card') || e.target.closest('.search-item')
    || e.target.closest('a') || e.target.closest('button') || e.target.closest('textarea')
    || e.target.closest('select') || e.target.closest('input') || e.target.closest('.editor-toolbar')
    || e.target.closest('.ctx-menu') || e.target.closest('.modal-mask')) return false;
  return true;
}
$('#content').addEventListener('click', e => {
  if (!blankHit(e)) return;
  blankMenu(e.clientX, e.clientY);
});
$('#content').addEventListener('contextmenu', e => {
  if (!blankHit(e)) return;
  e.preventDefault();
  blankMenu(e.clientX, e.clientY);
});
// 侧栏空白处右键 → 同样菜单
$('#folderTree').addEventListener('contextmenu', e => {
  if (e.target.closest('.tree-row')) return;
  e.preventDefault();
  blankMenu(e.clientX, e.clientY);
});

(async function init() {
  await loadTree();
  var qp = new URLSearchParams(location.search).get("path");
  var qv = new URLSearchParams(location.search).get("view");
  if (qp) { await openArticle(qp); return; }
  if (qv === "graph") { await openGraph(); return; }
  /* 什么都不带打开时：直接进最新一篇，而不是首页列表 */
  var all = flattenArticles(state.tree);
  var latest = all.slice().sort(function (a, b) {
    return (b.updated || b.mtime || 0) - (a.updated || a.mtime || 0);
  })[0];
  if (latest && latest.path) {
    try { await openArticle(latest.path); return; } catch (e) {}
  }
  openHome();
})();