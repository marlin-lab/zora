/* ==========================================================
   个人系统 · 总览页逻辑
   ========================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var KEY = 'memd_panel_v2';

  /* ---------- 小工具 ---------- */
  function shortDate(d) {
    if (!d) return '';
    var p = String(d).split('-');
    return p.length === 3 ? (+p[1]) + '.' + (+p[2]) : String(d);
  }
  function todayStr() {
    var t = new Date();
    var m = ('0' + (t.getMonth() + 1)).slice(-2);
    var d = ('0' + t.getDate()).slice(-2);
    return t.getFullYear() + '-' + m + '-' + d;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }
  function dec(s) { try { return decodeURIComponent(String(s || '')); } catch (e) { return String(s || ''); } }
  var tstTimer;
  function toast(msg) {
    var t = $('tst');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(tstTimer);
    tstTimer = setTimeout(function () { t.classList.remove('on'); }, 2200);
  }
  function fmtTime(ms) {
    var d = new Date(ms || 0);
    return d.getMonth() + 1 + '月' + d.getDate() + '日';
  }

  /* ---------- 一、看板 iframe 自适应高度 ---------- */
  var frame = $('dashFrame');
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.t === 'kb-h' && typeof d.h === 'number' && d.h > 260) {
      /* 减去末尾的区块留白，避免嵌入区尾部出现大段空白 */
      frame.style.height = Math.max(620, Math.ceil(d.h) - 64) + 'px';
      /* 看板长高了，如果带着锚点回来的，把目标重新对齐 */
      var hh = (location.hash || '').replace('#', '');
      if (hh) {
        var nn = document.getElementById(hh);
        if (nn) setTimeout(function () { alignTo(nn); }, 120);
      }
    }
    if (d.t === 'kb-open-article' && d.path) {
      location.href = '/classic.html?path=' + encodeURIComponent(d.path);
    }
  });

  /* 手机端：默认摘要卡；点「展开」就地加载完整看板，不跳出这一页 */
  function isNarrow() { return window.innerWidth < 620; }
  function mdOpen() { try { return sessionStorage.getItem('dashExpand') === '1'; } catch (e) { return false; } }
  function setMdOpen(v) { try { sessionStorage.setItem('dashExpand', v ? '1' : '0'); } catch (e) {} }

  function renderMiniDash() {
    var wrap = $('dashMini');
    if (!wrap) return;
    var st = readState();
    var recs = (st.records || []).slice().sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : 1; });
    var last = recs.length ? recs[recs.length - 1] : null;
    var sleep = last && last.sleep ? last.sleep.score : null;
    var score = null;
    if (last && last.scores) {
      var s = last.scores;
      score = Math.round((+s.study || 0) * 0.3 + (+s.hobby || 0) * 0.2 + (+s.relax || 0) * 0.2 + (+sleep || 0) * 0.3);
    }
    var lastNote = null;
    (st.journal || []).forEach(function (j) { if (!lastNote || String(j.date) >= String(lastNote.date)) lastNote = j; });
    function cell(label, val, unit) {
      return '<div><u>' + label + '</u><b>' + (val == null || val === '' ? '—' : val) + '</b><i>' + (unit || '') + '</i></div>';
    }
    wrap.innerHTML =
      '<div class="mdTop"><span>今天</span><b>' + shortDate(todayStr()) + '</b></div>'
      + '<div class="mdGrid">'
      + cell('睡眠评分', sleep, '分')
      + cell('体重', last ? last.weight : null, 'kg')
      + cell('步数', last ? last.steps : null, '步')
      + cell('综合', score, '分')
      + '</div>'
      + (lastNote ? '<p class="mdNote">' + esc(String(lastNote.raw || '').slice(0, 70)) + '</p>' : '')
      + '<button class="mdBtn" id="mdOpen" type="button">展开完整看板 · 趋势 / 围度 / 记录 ↓</button>';
    var b = $('mdOpen');
    if (b) b.addEventListener('click', function () { setMdOpen(true); applyNarrow(); });
  }
  function applyNarrow() {
    var mini = $('dashMini'), f = $('dashFrame'), bar = $('expBar');
    if (!mini || !f) return;
    if (isNarrow()) {
      var open = mdOpen();
      f.style.display = open ? '' : 'none';
      mini.style.display = open ? 'none' : 'block';
      if (bar) bar.style.display = open ? 'flex' : 'none';
      if (!open) renderMiniDash();
    } else {
      f.style.display = ''; mini.style.display = 'none';
      if (bar) bar.style.display = 'none';
    }
  }
  var foldBtn = $('mdFold');
  if (foldBtn) foldBtn.addEventListener('click', function () {
    setMdOpen(false); applyNarrow();
    var d = document.getElementById('dash');
    if (d) d.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  applyNarrow();
  syncFromServer(function () { applyNarrow(); });
  window.addEventListener('resize', function () { applyNarrow(); });

  /* 首页从服务端拉一次数据：服务端 md 是真相源，本机没有记录时才落一份缓存（手机上也能看到） */
  function syncFromServer(done) {
    fetch('/api/sync').then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.state) return;
      var raw = null;
      try { raw = localStorage.getItem(KEY); } catch (e) {}
      var local = null;
      if (raw) { try { local = JSON.parse(raw); } catch (e) {} }
      // 本机记录比服务端多，说明是旧版留下的、还没进文件 —— 推一次上去
      if (local && Array.isArray(local.records) && Array.isArray(d.state.records)
          && local.records.length > d.state.records.length) {
        fetch('/api/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: local })
        }).catch(function () {});
        return;
      }
      d.state._at = d.at || Date.now();
      try { localStorage.setItem(KEY, JSON.stringify(d.state)); } catch (e) {}
    }).catch(function () {}).then(function () { if (done) done(); });
  }

  /* ---------- 二、仓库 ---------- */
  var ALL = [];          // 所有文章 {title,path,snippet,mtime,folder}
  var FOLDERS = [];      // 一级分区名
  var curFolder = '*';
  var shown = 12;
  var tree = null;

  function walkTree(node, topFolder) {
    var f = topFolder;
    if (!f) f = node.name === '我的知识库' ? '' : node.name;
    (node.articles || []).forEach(function (a) {
      ALL.push({ title: a.title, path: a.path, snippet: a.snippet || '', mtime: a.mtime || 0, folder: f || '根目录' });
    });
    (node.folders || []).forEach(function (ch) { walkTree(ch, f); });
  }

  function loadTree() {
    return fetch('/api/tree').then(function (r) { return r.json(); }).then(function (t) {
      tree = t;
      ALL = []; FOLDERS = [];
      walkTree(t, '');
      (t.folders || []).forEach(function (ch) { FOLDERS.push(ch.name); });
      renderTree();
      if ($('repoCount')) $('repoCount').textContent = ALL.length + ' 篇 · ' + FOLDERS.length + ' 个分区';
      renderCards(true);
      return t;
    });
  }
  function chipOrder(t) {
    var order = [];
    (t.articles || []).length && order.push('根目录');
    (t.folders || []).forEach(function (ch) { order.push(ch.name); });
    return order;
  }

  /* 仓库目录：与编辑视图同一套树（清溯 Zora根 → 分区 → 文章） */
  var OPEN = { '': true, me: false };
  function dtRow(name, key, count, open, isRoot, depth) {
    return '<div class="dt-row folder' + (isRoot ? ' kb-root' : '') + (curFolder === key ? ' active' : '')
      + '" data-g="' + esc(key) + '" style="padding-left:' + (8 + depth * 14) + 'px">'
      + '<span class="chev' + (open ? ' open' : '') + '">▸</span>'
      + '<span class="name">' + esc(name) + '</span>'
      + (count ? '<span class="count">' + count + '</span>' : '')
      + '</div>';
  }
  function dtArt(a, depth) {
    return '<a class="dt-row art" href="' + articleURL(a.path) + '" style="padding-left:' + (8 + depth * 14) + 'px">'
      + '<span class="chev hidden">▸</span>'
      + '<span class="name">' + esc(a.title || '未命名') + '</span></a>';
  }
  function renderTree() {
    var t = tree || {};
    var box = $('repoTree');
    if (!box) return;
    var rows = '';
    var rootOpen = !!OPEN[''];
    rows += dtRow('清溯 Zora', '', ALL.length, rootOpen, true, 0);
    if (rootOpen) {
      (t.folders || []).forEach(function (f) {
        var files = ALL.filter(function (a) { return a.folder === f.name; })
          .sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); });
        var on = !!OPEN[f.name];
        rows += dtRow(f.name, f.name, files.length, on, false, 1);
        if (on) rows += files.map(function (a) { return dtArt(a, 2); }).join('');
      });
      ALL.filter(function (a) { return a.folder === '根目录'; })
        .sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); })
        .forEach(function (a) { rows += dtArt(a, 1); });
    }
    box.innerHTML = rows;
  }

  function renderCards(reset) {
    if (reset) shown = 16;
    var list = curFolder === '*' ? ALL.slice() : ALL.filter(function (a) { return a.folder === curFolder; });
    list.sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); });
    var box = $('cards');
    if (!box) return;
    if (!list.length) {
      box.innerHTML = '<div class="ph" style="padding:20px 0">这个分区还是空的。写一篇，或者上传一个文件。</div>';
      if ($('btnMore')) $('btnMore').style.display = 'none';
      return;
    }
    var slice = list.slice(0, shown);
    box.innerHTML = slice.map(function (a) {
      var t = a.title || '未命名';
      return '<a class="rl-item" href="' + articleURL(a.path) + '" data-p="' + esc(a.path) + '">'
        + '<span class="rl-t">' + esc(t) + '</span>'
        + '<span class="rl-m">' + esc(a.folder) + ' · ' + fmtTime(a.mtime) + '</span>'
        + '</a>';
    }).join('');
    if ($('btnMore')) $('btnMore').style.display = list.length > shown ? 'block' : 'none';
    if ($('btnMore')) $('btnMore').textContent = '再看 ' + Math.min(16, list.length - shown) + ' 篇（还有 ' + (list.length - shown) + ' 篇）';
  }

  /* 当前所在分区，用于跳出去以后能回到原位 */
  function curSec() {
    var y = window.scrollY + 180, on = 'dash';
    ['dash', 'repo', 'tags'].forEach(function (id) {
      var n = document.getElementById(id);
      if (n && n.offsetTop <= y) on = id;
    });
    return on;
  }
  function articleURL(path) {
    return '/classic.html?path=' + encodeURIComponent(path) + '&from=' + curSec();
  }

  document.addEventListener('click', function (e) {
    var chip = e.target.closest ? e.target.closest('.chip') : null;
    if (chip) { curFolder = chip.getAttribute('data-f'); loadTree(); return; }
    var tr = e.target.closest ? e.target.closest('.dt-row[data-g]') : null;
    if (tr) {
      e.preventDefault();
      var g = tr.getAttribute('data-g');
      OPEN[g] = !OPEN[g];
      if (g) curFolder = g;
      else curFolder = '*';
      renderTree();
      renderCards(true);
      return;
    }
    var card = e.target.closest ? e.target.closest('.rl-item, .cardA') : null;
    if (card) { location.href = articleURL(card.getAttribute('data-p')); }
  });
  if ($('btnMore')) $('btnMore').addEventListener('click', function () { shown += 16; renderCards(false); });

  /* ---------- 上传文件 ---------- */
  if ($('btnUpload')) $('btnUpload').addEventListener('click', function () { $('upInput').click(); });
  if ($('upInput')) $('upInput').addEventListener('change', function (e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    if (!files.length) return;
    var folder = curFolder === '*' ? 'me' : curFolder;
    var i = 0;
    (function next() {
      if (i >= files.length) { toast('上传完成 · ' + files.length + ' 个文件'); $('upInput').value = ''; loadTree(); return; }
      var f = files[i++];
      var fr = new FileReader();
      var isText = /\.(md|txt|markdown|json|csv)$/i.test(f.name);
      fr.onload = function () {
        var body = { folder: folder, name: f.name };
        if (isText) body.content = String(fr.result || '');
        else body.b64 = String(fr.result || '').split(',')[1] || '';
        fetch('/api/upload', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }).then(next).catch(next);
      };
      if (isText) fr.readAsText(f); else fr.readAsDataURL(f);
    })();
  });

  /* ---------- 写一篇（站内弹层，不再用系统 prompt） ---------- */
  var newMask = $('newmask');
  function openNew() {
    $('newSub').textContent = todayStr();
    $('newTitle').value = shortDate(todayStr());
    var sel = $('newFolder'), want = curFolder === '*' ? (FOLDERS[0] || 'me') : curFolder;
    sel.innerHTML = '';
    (FOLDERS.length ? FOLDERS : ['me']).forEach(function (f) {
      var o = document.createElement('option');
      o.value = f; o.textContent = f + ' 分区';
      sel.appendChild(o);
    });
    sel.value = want;
    newMask.classList.add('on');
    setTimeout(function () { var t = $('newTitle'); t.focus(); t.select(); }, 60);
  }
  function closeNew() { newMask.classList.remove('on'); }
  function submitNew() {
    var title = ($('newTitle').value || '').trim();
    if (!title) { $('newTitle').focus(); return; }
    var folder = ($('newFolder').value || 'me').trim();
    fetch('/api/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: folder, title: title, content: '# ' + title + '\n\n' })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res && res.path) { location.href = '/classic.html?path=' + encodeURIComponent(res.path); }
      else toast('没建成：' + ((res && res.error) || '未知原因'));
    });
  }
  if ($('btnNew')) $('btnNew').addEventListener('click', openNew);
  $('newCancel').addEventListener('click', closeNew);
  $('newSave').addEventListener('click', submitNew);
  newMask.addEventListener('click', function (e) { if (e.target === newMask) closeNew(); });
  $('newTitle').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submitNew(); } });
  document.addEventListener('keydown', function (e) {
    if (!newMask.classList.contains('on')) return;
    if (e.key === 'Escape') closeNew();
  });

  /* ---------- 写小记 ---------- */
  var noteMask = $('notemask');
  function openNote() {
    var d = new Date();
    $('noteSub').textContent = todayStr() + ' · ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    $('noteText').value = '';
    noteMask.classList.add('on');
    setTimeout(function () { $('noteText').focus(); }, 60);
  }
  function closeNote() { noteMask.classList.remove('on'); }
  if ($('btnNote')) $('btnNote').addEventListener('click', openNote);
  $('noteCancel').addEventListener('click', closeNote);
  noteMask.addEventListener('click', function (e) { if (e.target === noteMask) closeNote(); });

  $('noteSave').addEventListener('click', function () {
    var txt = ($('noteText').value || '').trim();
    if (!txt) { closeNote(); return; }
    var d = todayStr();
    var name = '小记-' + d + '.md';
    var hm = ('0' + new Date().getHours()).slice(-2) + ':' + ('0' + new Date().getMinutes()).slice(-2);
    fetch('/api/article?path=' + encodeURIComponent('me/' + name))
      .then(function (r) { return r.ok ? r.json() : { content: '' }; })
      .then(function (a) {
        var base = (a && a.content) ? a.content : ('# 小记 ' + d + '\n');
        var content = base.replace(/\s*$/, '') + '\n\n## ' + hm + '\n' + txt + '\n';
        return fetch('/api/save', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: 'me/' + name, content: content })
        });
      })
      .then(function () {
        closeNote(); toast('小记已存进 me/小记-' + d + '.md'); loadTree(); loadTodayNotes();
      })
      .catch(function () { toast('保存失败，看看服务是不是停了'); });
  });
  document.addEventListener('keydown', function (e) {
    if (!noteMask.classList.contains('on')) return;
    if (e.key === 'Escape') closeNote();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('noteSave').click();
  });

  /* ---------- 今天的小记 ---------- */
  function loadTodayNotes() {
    var box = $('todayNotes');
    var marks = ALL.filter(function (a) { return /^小记-/.test(a.title); })
      .sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); }).slice(0, 4);
    if (!marks.length) {
      box.innerHTML = '<span class="ph">还没有小记。上面「写一条小记」，一句话就够。</span>';
      return;
    }
    var out = [];
    var done = 0;
    marks.forEach(function (m, idx) {
      fetch('/api/article?path=' + encodeURIComponent(m.path)).then(function (r) { return r.json(); })
        .then(function (a) {
          var c = (a && a.content) || '';
          c = c.replace(/^#.*$/gm, '').trim();
          var segs = c.split(/\n(?=##\s)/).map(function (s) {
            var t = s.match(/^##\s*(.*)$/m);
            var body = s.replace(/^##.*$/m, '').trim();
            return { time: t ? t[1].trim() : '', body: body };
          }).filter(function (s) { return s.body; }).slice(-3);
          out[idx] = '<div style="margin-bottom:16px">'
            + '<div style="font-size:12px;letter-spacing:.08em;color:#b4b8b4;margin-bottom:6px">'
            + esc(m.title.replace('小记-', '')) + '</div>'
            + segs.map(function (s) {
              return '<div class="nrow"><div class="nt">' + esc(s.time) + '</div><div class="nx">' + esc(s.body) + '</div></div>';
            }).join('') + '</div>';
        })
        .catch(function () { out[idx] = ''; })
        .then(function () { if (++done === marks.length) box.innerHTML = out.join('') || '<span class="ph">小记为空白。</span>'; });
    });
  }

  /* ---------- 三、标签云 ---------- */
  function readState() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function buildTags() {
    var st = readState();
    var logs = st.journal || [];
    var recs = st.records || [];
    var tally = {};   // word -> {n, dates:Set, kind}
    function addWord(w, date, kind) {
      w = String(w || '').trim();
      if (!w || w.length > 8) return;
      var o = tally[w] || (tally[w] = { n: 0, dates: {}, kind: kind });
      o.n++;
      if (date) o.dates[date] = (o.dates[date] || 0) + 1;
    }
    logs.forEach(function (j) {
      var f = j.feel || {};
      (f.mood || []).forEach(function (w) { addWord(w, j.date, '情绪'); });
      (f.hurt || []).forEach(function (w) { addWord(w, j.date, '身体'); });
    });
    recs.forEach(function (r) {
      if (r.mood) String(r.mood).split(/[\/,、\s]+/).forEach(function (w) { addWord(w, r.date, '情绪'); });
      var h = (r.extra && r.extra.hurt) || [];
      h.forEach(function (w) { addWord(w, r.date, '身体'); });
    });

    var words = Object.keys(tally).sort(function (a, b) { return tally[b].n - tally[a].n; });
    var cloud = $('tagCloud');
    var tagHit = $('tagHit');
    if (!cloud || !tagHit) return;
    tagHit.innerHTML = '';

    if (!words.length) {
      // 没有情绪标签就退回分区标签
      var fcnt = {};
      ALL.forEach(function (a) { fcnt[a.folder] = (fcnt[a.folder] || 0) + 1; });
      var arr = Object.keys(fcnt).sort(function (a, b) { return fcnt[b] - fcnt[a]; });
      cloud.innerHTML = arr.map(function (f, i) {
        return '<button class="tagb ' + (i < 2 ? 'big' : (i < 5 ? 'mid' : '')) + '" data-folder="' + esc(f) + '">'
          + esc(f) + '<u>' + fcnt[f] + '</u></button>';
      }).join('') + '<div class="ph" style="width:100%;margin-top:14px;font-size:13px">'
        + '还没有情绪 / 身体标签。在数据看板的录入框里写「今天有点焦虑 / 手腕疼」，标签就会长在这里。</div>';
      return;
    }
    cloud.innerHTML = words.slice(0, 22).map(function (w, i) {
      return '<button class="tagb ' + (i === 0 ? 'big' : (i < 4 ? 'mid' : '')) + '" data-tag="' + esc(w) + '">'
        + esc(w) + '<u>' + tally[w].n + '</u></button>';
    }).join('');

    (function () { } )();
    cloud.onclick = function (e) {
      var b = e.target.closest && e.target.closest('.tagb');
      if (!b) return;
      var w = b.getAttribute('data-tag');
      var f = b.getAttribute('data-folder');
      if (f) { curFolder = f; loadTree(); document.getElementById('repo').scrollIntoView({ behavior: 'smooth' }); return; }
      var o = tally[w];
      var ds = Object.keys(o.dates).sort().reverse();
      tagHit.innerHTML = '<div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#b4b8b4;margin-bottom:10px">'
        + '「' + esc(w) + '」落在 ' + ds.length + ' 天</div>'
        + '<div class="notes">' + ds.map(function (d) {
          return '<button class="nrow nrow-go" data-d="' + esc(d) + '" style="width:100%;text-align:left;border:0;background:none;padding:0;cursor:pointer">'
            + '<div class="nt">' + esc(shortDate(d)) + '</div>'
            + '<div class="nx">' + esc(o.kind) + ' · ' + o.dates[d] + ' 次 · 看这天 →</div></button>';
        }).join('') + '</div>';
      Array.prototype.forEach.call(tagHit.querySelectorAll('.nrow-go'), function (b) {
        b.addEventListener('click', function () {
          location.href = '/dashboard.html?date=' + b.getAttribute('data-d') + '#records';
        });
      });
    };
  }

  /* ---------- 四、全局搜索 ---------- */
  var mask = $('seamask'), input = $('seaInput'), out = $('seaOut'), deb;
  function openSea() { mask.classList.add('on'); setTimeout(function () { input.focus(); }, 80); }
  function closeSea() { mask.classList.remove('on'); input.value = ''; out.innerHTML = ''; }
  $('searchOpen').addEventListener('click', openSea);
  mask.addEventListener('click', function (e) { if (e.target === mask) closeSea(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeSea();
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openSea(); }
  });

  input.addEventListener('input', function () {
    var q = input.value.trim();
    clearTimeout(deb);
    if (!q) { out.innerHTML = ''; return; }
    deb = setTimeout(function () { runSearch(q); }, 220);
  });
  input.addEventListener('keydown', function (e) {
    var rows = Array.prototype.slice.call(out.querySelectorAll('.srow'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!rows.length) return;
      e.preventDefault();
      var cur = rows.findIndex(function (r) { return r.classList.contains('sel'); });
      var next = e.key === 'ArrowDown' ? (cur + 1) % rows.length : (cur <= 0 ? rows.length - 1 : cur - 1);
      rows.forEach(function (r) { r.classList.remove('sel'); });
      rows[next].classList.add('sel');
      rows[next].scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter') {
      var pick = out.querySelector('.srow.sel') || out.querySelector('.srow');
      if (pick) pick.click();
    }
  });

  function runSearch(q) {
    var st = readState();
    var recs = st.records || [], logs = st.journal || [];
    var kw = q.toLowerCase();
    var dataHits = [], noteHits = [];
    recs.forEach(function (r) {
      var txt = [r.date, r.mood, r.morning, r.doing, r.review, (r.meals || []).map(function (m) { return m.name + ' ' + (m.desc || ''); }).join(' ')]
        .join(' ').toLowerCase();
      if (txt.indexOf(kw) >= 0) {
        dataHits.push({
          t: shortDate(r.date) + ' · 数据',
          s: '睡眠 ' + ((r.sleep && r.sleep.score) || '-') + ' 分 / ' + ((r.sleep && r.sleep.hours) || '-') + ' 小时 · 体重 '
            + (r.weight || '-') + 'kg · 步数 ' + (r.steps || '-'),
          k: '数据',
          date: r.date
        });
      }
    });
    logs.forEach(function (j) {
      var raw = (j.raw || '') + ' ' + ((j.feel && j.feel.mood) || []).join(' ');
      if (raw.toLowerCase().indexOf(kw) >= 0) {
        noteHits.push({
          t: shortDate(j.date) + ' · 小记',
          s: String(j.raw || '').slice(0, 90),
          k: '笔记', path: j.path || ''
        });
      }
    });

    var nodeHits = ALL.filter(function (a) { return (a.title || '').toLowerCase().indexOf(kw) >= 0; })
      .slice(0, 8).map(function (a) { return { t: a.title, s: a.folder, k: '节点', path: a.path }; });

    fetch('/api/search?q=' + encodeURIComponent(q)).then(function (r) { return r.json(); })
      .then(function (res) {
        var docs = (res || []).filter(function (d) {
          return !nodeHits.some(function (n) { return n.path === d.path; });
        }).slice(0, 10);
        var groups = [
          { name: '数据', rows: dataHits.slice(0, 6) },
          { name: '笔记', rows: noteHits.slice(0, 6) },
          { name: '文档', rows: docs.map(function (d) { return { t: d.title, s: d.snippet || '', k: '文档', path: d.path }; }) },
          { name: '图谱节点', rows: nodeHits }
        ];
        out.innerHTML = groups.filter(function (g) { return g.rows.length; }).map(function (g) {
          return '<div class="sgroup"><div class="g">' + g.name + ' · ' + g.rows.length + '</div><div class="sres">'
            + g.rows.map(function (r) {
              return '<div class="srow" data-go="' + esc(r.path ? articleURL(r.path) : (r.date ? '/dashboard.html?date=' + r.date + '#records' : '#tags')) + '">'
                + '<div class="t">' + esc(r.t) + '</div>'
                + (r.s ? '<div class="s">' + esc(r.s) + '</div>' : '')
                + '<div class="k">' + esc(r.k) + '</div></div>';
            }).join('') + '</div></div>';
        }).join('') || '<div class="sgroup"><div class="ph">没有匹配。换个词试试，或者只写两个字。</div></div>';
      })
      .catch(function () { out.innerHTML = '<div class="sgroup"><div class="ph">搜索服务没响应。</div></div>'; });
  }
  out.addEventListener('click', function (e) {
    var row = e.target.closest && e.target.closest('.srow');
    if (!row) return;
    var go = row.getAttribute('data-go');
    if (go.indexOf('#') === 0) { closeSea(); location.hash = go; }
    else location.href = go;
  });

  /* ---------- 左侧导航：滚动高亮 + 抽屉 ---------- */
  var sidenav = $('sidenav'), snMask = $('snMask');
  function drawer(v) {
    if (!sidenav) return;
    sidenav.classList.toggle('open', v);
    if (snMask) snMask.classList.toggle('on', v);
    document.documentElement.classList.toggle('snlock', v);
    var t = $('snToggle');
    if (t) t.textContent = v ? '✕' : '☰';
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sidenav && sidenav.classList.contains('open')) drawer(false);
  });
  function isNarrowNav() { return window.innerWidth < 1000; }
  document.querySelectorAll('.snLinks a[data-sec]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var id = a.getAttribute('data-sec');
      var n = document.getElementById(id);
      if (!n) return;
      e.preventDefault();
      n.scrollIntoView({ behavior: 'smooth', block: 'start' });
      try { history.replaceState(null, '', '#' + id); } catch (err) { }
      document.querySelectorAll('.snLinks a[data-sec]').forEach(function (x) {
        x.classList.toggle('on', x === a);
      });
      if (isNarrowNav()) drawer(false);
    });
  });
  document.querySelectorAll('.snLinks a:not([data-sec])').forEach(function (a) {
    a.addEventListener('click', function () { if (isNarrowNav()) drawer(false); });
  });
  if ($('snToggle')) $('snToggle').addEventListener('click', function () {
    drawer(!sidenav.classList.contains('open'));
  });
  if (snMask) snMask.addEventListener('click', function () { drawer(false); });
  if ($('snSea')) $('snSea').addEventListener('click', function () { openSea(); });
  if ($('toTop')) $('toTop').addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  if ($('btnRand')) $('btnRand').addEventListener('click', function () {
    if (!ALL.length) return;
    var a = ALL[Math.floor(Math.random() * ALL.length)];
    location.href = articleURL(a.path);
  });
  ['btnRand2'].forEach(function (id) {
    if ($(id)) $(id).addEventListener('click', function () {
      if (!ALL.length) return;
      var a = ALL[Math.floor(Math.random() * ALL.length)];
      location.href = articleURL(a.path);
    });
  });
  if ($('btnNote3')) $('btnNote3').addEventListener('click', function () { openNote(); });
  if ($('btnImport2')) $('btnImport2').addEventListener('click', function () { $('upInput').click(); });
  ['btnNew2', 'btnNew3'].forEach(function (id) {
    if ($(id)) $(id).addEventListener('click', function () { openNew(); });
  });
  if (/repo=1/.test(location.search)) {
    document.body.classList.add('repoOn');
    setTimeout(function () { var r = document.getElementById('repo'); if (r) window.scrollTo({ top: r.offsetTop - 10, behavior: 'instant' }); }, 1200);
  }

  var secs = ['dash', 'repo'];
  window.addEventListener('scroll', function () {
    var y = window.scrollY + 140, on = 'dash';
    secs.forEach(function (id) {
      var n = document.getElementById(id);
      if (n && n.offsetTop <= y) on = id;
    });
    document.querySelectorAll('.snLinks a[data-sec]').forEach(function (a) {
      a.classList.toggle('on', a.getAttribute('data-sec') === on);
    });
    document.body.classList.toggle('repoOn', on === 'repo');
    if (/repo=1/.test(location.search)) {
    document.body.classList.add('repoOn');
    setTimeout(function () { var r = document.getElementById('repo'); if (r) window.scrollTo({ top: r.offsetTop - 10, behavior: 'instant' }); }, 1200);
  }
  }, { passive: true });

  /* 从文章/图谱返回时，按 hash 落回原来的区块；
     看板 iframe 变高会把目标往下推，所以持续对齐，用户一动就停 */
  function alignTo(n) {
    var top = n.getBoundingClientRect().top + window.pageYOffset - 20;
    var maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    if (Math.abs(window.pageYOffset - top) > 4) {
      window.scrollTo({ top: Math.max(0, Math.min(top, maxY)), behavior: 'instant' });
    }
    return Math.abs(window.pageYOffset - top);
  }
  function jumpHash() {
    var h = (location.hash || '').replace('#', '');
    if (!h) return;
    var n = document.getElementById(h);
    if (!n) return;
    var tries = 0, stop = false;
    ['wheel', 'touchstart', 'keydown'].forEach(function (ev) {
      window.addEventListener(ev, function () { stop = true; }, { once: true, passive: true });
    });
    (function tick() {
      if (stop) return;
      alignTo(n);
      if (++tries < 24) setTimeout(tick, 220);
    })();
  }
  window.addEventListener('hashchange', jumpHash);

  /* ---------- 倒数日 + 待办（真相在 data/todos.md） ---------- */
  var TODOS = [];

  function todayISO() {
    var d = new Date(), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function daysLeft(due) {
    var a = new Date(due + 'T00:00:00'), b = new Date(todayISO() + 'T00:00:00');
    return Math.round((a - b) / 86400000);
  }
  function mdLabel(due) {
    return due ? due.slice(5).replace('-', '.') : '';
  }

  function loadTodos() {
    return fetch('/api/todos').then(function (r) { return r.json(); }).then(function (d) {
      TODOS = (d && d.todos) || [];
      renderDue();
    }).catch(function () {
      var g = $('dueGrid'); if (g) g.innerHTML = '<span class="ph">待办没读出来，确认服务在跑</span>';
    });
  }

  function saveTodos() {
    return fetch('/api/todos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ todos: TODOS })
    }).then(function () { renderDue(); }).catch(function () { toast('没存上'); });
  }

  function renderDue() {
    var grid = $('dueGrid'), list = $('todoList');
    if (!grid) return;
    var withDue = TODOS.filter(function (t) { return t.due && !t.done; })
      .sort(function (a, b) { return a.due < b.due ? -1 : 1; });
    var noDue = TODOS.filter(function (t) { return !t.due && !t.done; });
    var done = TODOS.filter(function (t) { return t.done; });

    if ($('dueSub')) $('dueSub').textContent = withDue.length ? withDue.length + ' 个截止' : 'DUE';

    if (!withDue.length) {
      grid.innerHTML = '<div class="dueCard"><div class="dcTitle">还没有带日期的待办</div>'
        + '<div class="dcMeta">加一条，填上截止日</div>'
        + '<div class="dcBig"><span class="dcNum">—</span></div>'
        + '<div class="dcFoot"><span>倒数卡会出现在这里</span></div></div>';
    } else {
      grid.innerHTML = withDue.map(function (t, i) {
        var n = daysLeft(t.due);
        var cls = n === 0 ? 'today' : (n < 0 ? 'past' : (i === 0 ? 'near' : ''));
        var num = n === 0 ? '今天' : (n > 0 ? String(n) : '−' + Math.abs(n));
        var unit = n === 0 ? '到期' : (n > 0 ? '天' : '天已过');
        return '<div class="dueCard ' + cls + '" data-id="' + enc(t.text) + '">'
          + '<div class="dcTitle">' + esc(t.text) + '</div>'
          + '<div class="dcMeta">截止 ' + mdLabel(t.due) + '</div>'
          + '<div class="dcBig"><span class="dcNum" style="font-size:' + (n === 0 ? 54 : 74) + 'px">' + num + '</span>'
          + '<span class="dcUnit">' + unit + '</span></div>'
          + '<div class="dcFoot"><span>' + (t.term === 'long' ? '长期' : '短期') + '</span>'
          + '<button type="button" class="dcEdit" data-id="' + enc(t.text) + '">改日期</button></div>'
          + '</div>';
      }).join('');
    }

    var rows = withDue.concat(noDue).concat(done).map(function (t) {
      var n = t.due ? daysLeft(t.due) : null;
      var warn = n !== null && n <= 3;
      return '<div class="todoRow' + (t.done ? ' done' : '') + '" data-id="' + enc(t.text) + '">'
        + '<button type="button" class="tk' + (t.done ? ' on' : '') + '" data-act="toggle">' + (t.done ? '✓' : '') + '</button>'
        + '<span class="tt">' + esc(t.text) + '</span>'
        + '<time class="' + (warn && !t.done ? 'warn' : '') + '">' + (t.due ? mdLabel(t.due) : '未设日期') + '</time>'
        + '<button type="button" class="tr" data-act="del">删</button>'
        + '</div>';
    }).join('');
    list.innerHTML = rows || '<div class="ph" style="padding:16px 4px">没有待办。加一条？</div>';
  }

  function findTodo(id) {
    id = dec(id);
    for (var i = 0; i < TODOS.length; i++) if (TODOS[i].text === id) return i;
    return -1;
  }

  if ($('todoList')) $('todoList').addEventListener('click', function (e) {
    var row = e.target.closest('.todoRow'); if (!row) return;
    var i = findTodo(row.getAttribute('data-id')); if (i < 0) return;
    var act = e.target.getAttribute('data-act');
    if (act === 'toggle') { TODOS[i].done = !TODOS[i].done; saveTodos(); }
    else if (act === 'del') { TODOS.splice(i, 1); saveTodos(); }
  });

  if ($('dueGrid')) $('dueGrid').addEventListener('click', function (e) {
    var b = e.target.closest('.dcEdit'); if (!b) return;
    var i = findTodo(b.getAttribute('data-id')); if (i < 0) return;
    openTodo(TODOS[i]);
  });

  var todoMask = $('todomask'), todoEditing = -1;
  function openTodo(t) {
    todoEditing = t ? findTodo(t.text) : -1;
    $('todoText').value = t ? t.text : '';
    $('todoDue').value = t && t.due ? t.due : '';
    todoMask.classList.add('on');
    setTimeout(function () { $('todoText').focus(); }, 60);
  }
  function closeTodo() { todoMask.classList.remove('on'); }
  if ($('btnAddTodo')) $('btnAddTodo').addEventListener('click', function () { openTodo(null); });
  if ($('todoCancel')) $('todoCancel').addEventListener('click', closeTodo);
  if (todoMask) todoMask.addEventListener('click', function (e) { if (e.target === todoMask) closeTodo(); });
  function submitTodo() {
    var txt = ($('todoText').value || '').trim();
    if (!txt) { $('todoText').focus(); return; }
    var due = $('todoDue').value || '';
    if (todoEditing >= 0) {
      TODOS[todoEditing].text = txt;
      TODOS[todoEditing].due = due;
    } else {
      TODOS.push({ text: txt, term: 'short', due: due, note: '', done: false });
    }
    closeTodo();
    saveTodos();
  }
  if ($('todoSave')) $('todoSave').addEventListener('click', submitTodo);
  if ($('todoText')) $('todoText').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submitTodo(); } });
  document.addEventListener('keydown', function (e) {
    if (todoMask && todoMask.classList.contains('on') && e.key === 'Escape') closeTodo();
  });

  loadTodos();

  /* 服务端有变化：刷新倒数/待办，并通知嵌在里面的看板自己重取 */
  (function watchServer() {
    if (!window.EventSource) return;
    if (/[?&]nosse=1/.test(location.search)) return;   // 截图/离线调试用
    try {
      var es = new EventSource('/api/events');
      es.onmessage = function (e) {
        var m; try { m = JSON.parse(e.data); } catch (x) { return; }
        if (m.type === 'todos' || m.type === 'records' || m.type === 'sync') {
          loadTodos();
          try {
            var f = $('dashFrame');
            if (f && f.contentWindow) f.contentWindow.postMessage({ kb: 'refresh' }, '*');
          } catch (x) { }
        }
      };
    } catch (x) { }
  })();

  /* ---------- 启动 ---------- */
  loadTree().then(function () { loadTodayNotes(); buildTags(); jumpHash(); })
    .catch(function () { $('cards').innerHTML = '<div class="ph" style="padding:20px 0">仓库服务没连上，确认 node server.js 在跑。</div>'; });
})();