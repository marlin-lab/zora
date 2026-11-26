/*
 * timeline.js —— 时间轴：纵向 24 小时刻度，每 30 分钟一格
 * 参考 Google Calendar 日视图 / vis-timeline / Planly 的时间块做法：
 *   块按真实时间落在轴上，高度=时长，重叠的自动并排；拖动改时间、拉边改时长、
 *   空白格点一下就新建；所有编辑动作收在右键菜单里，界面上不摆按钮。
 * 数据：data/timeline/YYYY-MM-DD.md
 *   行格式：07:00-07:10 喝酸奶 #吃｜备注
 */
(function () {
  var TAGCOL = { '做事': '#41a1cf', '吃': '#e07a5f', '会议': '#8578dd', '课': '#4ea36c', '通勤': '#9aa0a6', '休息': '#c9a227', '生活': '#7cb7d3', '其他': '#b9bcb4' };
  var TINT = { '做事': '#e9f1fa', '吃': '#fbeae4', '会议': '#efecfb', '课': '#eaf3ea', '通勤': '#f1f2f3', '休息': '#fbf4df', '生活': '#e0eff6', '其他': '#f4f4ef' };
  var SLOT = 32;        /* 30 分钟 = 32px */
  var SNAP = 15;        /* 拖动吸附粒度（分钟） */
  var FILE = 'timeline/' + ymd() + '.md';
  var ROWS = [];
  var RAW = null;
  var busy = false;
  var BASE = 6 * 60;    /* 轴的起点（分钟） */

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function norm(t) { var p = String(t).split(':'); return pad(+p[0]) + ':' + (p[1] || '00'); }
  function toMin(t) { var p = String(t).split(':'); return (+p[0]) * 60 + (+p[1]); }
  function toHHMM(m) { m = Math.max(0, Math.min(24 * 60, Math.round(m))); return pad(Math.floor(m / 60) % 24) + ':' + pad(m % 60); }
  function fmtDur(m) { if (!m) return '0 min'; var h = Math.floor(m / 60), r = m % 60; if (!h) return r + ' min'; return h + ' hr' + (r ? ' ' + r + ' min' : ''); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function guess(text) {
    if (/会议|开会|例会|讨论/.test(text)) return '会议';
    if (/通勤|走|地铁|公交|路上|回宿舍/.test(text)) return '通勤';
    if (/上课|课|讲|实验|考试/.test(text)) return '课';
    if (/吃饭|午饭|晚饭|早餐|酸奶|外卖|糖水|药膳|食堂/.test(text)) return '吃';
    if (/发呆|休息|躺|睡|无聊|刷/.test(text)) return '休息';
    if (/超市|买|逛|洗|收拾|生活/.test(text)) return '生活';
    if (/改|写|做|学|系统|代码|看|读|整理/.test(text)) return '做事';
    return '其他';
  }

  function mk(t, end, body) {
    body = String(body || '').trim();
    var note = '';
    var ni = body.search(/[｜|]/);
    if (ni >= 0) { note = body.slice(ni + 1).trim(); body = body.slice(0, ni).trim(); }
    var tg = null, m = body.match(/\s*#([^\s#]+)\s*$/);
    if (m) { tg = m[1]; body = body.replace(/\s*#[^\s#]+\s*$/, ''); }
    body = body.replace(/<[^>]*>/g, '').replace(/\*\*/g, '').replace(/^[-*+]\s*/, '').trim();
    if (!tg && !body) return null;
    return { t: norm(t), end: end ? norm(end) : null, title: body, tag: tg || guess(body), note: note };
  }

  function parse(raw) {
    var out = [], pending = null;
    String(raw || '').split(/\r?\n/).forEach(function (l) {
      var s = l.trim();
      if (!s) return;
      if (s.charAt(0) === '#' && s.charAt(1) !== '#') return;
      var r1 = s.match(/^(\d{1,2}:\d{2})\s*[-–~—]\s*(\d{1,2}:\d{2})\s+(.+)$/);
      if (r1) { var a = mk(r1[1], r1[2], r1[3]); if (a) out.push(a); pending = null; return; }
      var r2 = s.match(/^(\d{1,2}:\d{2})\s+(.+)$/);
      if (r2) { var b = mk(r2[1], null, r2[2]); if (b) out.push(b); pending = null; return; }
      var r3 = s.match(/^##\s*(\d{1,2}):(\d{2})\s*(.*)$/);
      if (r3) { var c = mk(r3[1] + ':' + r3[2], null, r3[3]); if (c) { out.push(c); pending = c; } return; }
      if (/^#\s/.test(s)) return;
      if (pending && !pending.title) { pending.title = s; pending = null; }
    });
    return out;
  }

  function fillEnds(list) {
    var now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
    list.forEach(function (s, i) {
      if (s.end) return;
      var nx = list[i + 1];
      var dur = nx ? (toMin(nx.t) - toMin(s.t)) : (nowMin - toMin(s.t));
      if (dur <= 0 || dur > 480) dur = 30;
      s.end = toHHMM(toMin(s.t) + dur);
    });
    return list;
  }

  function fmtRow(r) {
    return pad(r.t) + '-' + pad(r.end) + ' ' + r.title + ' #' + r.tag + (r.note ? '｜' + String(r.note).replace(/\r?\n/g, ' ') : '');
  }

  /* 重叠分列：连续重叠的簇单独算列数 */
  function layout(segs) {
    var i = 0;
    while (i < segs.length) {
      var j = i, maxEnd = toMin(segs[i].end);
      while (j + 1 < segs.length && toMin(segs[j + 1].t) < maxEnd) {
        j++;
        maxEnd = Math.max(maxEnd, toMin(segs[j].end));
      }
      var cluster = segs.slice(i, j + 1);
      var lanes = [];
      var maxLane = 1;
      cluster.forEach(function (s) {
        var st = toMin(s.t), li = -1;
        for (var k = 0; k < lanes.length; k++) { if (lanes[k] <= st) { li = k; break; } }
        if (li < 0) { lanes.push(0); li = lanes.length - 1; }
        lanes[li] = toMin(s.end);
        s.lane = li;
        maxLane = Math.max(maxLane, lanes.length);
      });
      cluster.forEach(function (s) { s.lanes = maxLane; });
      i = j + 1;
    }
    return segs;
  }

  /* ---------------- 渲染 ---------------- */
  function render(keepScroll) {
    var el = document.getElementById('tlList');
    if (!el) return;
    var dn = document.getElementById('donut'), dt = document.getElementById('dnTotal'), lg = document.getElementById('dnLegend');
    var dayEl = document.getElementById('tlDate'), totEl = document.getElementById('tlTotal');
    var d = new Date();
    if (dayEl) dayEl.textContent = pad(d.getMonth() + 1) + '.' + pad(d.getDate());

    var segs = layout(fillEnds(ROWS.map(function (r) { return { t: r.t, end: r.end, title: r.title, tag: r.tag, note: r.note }; })));
    var total = 0, byTag = {}, order = [];
    segs.forEach(function (s) {
      var dur = toMin(s.end) - toMin(s.t);
      s.dur = dur > 0 ? dur : 0;
      total += s.dur;
      if (!byTag[s.tag]) { byTag[s.tag] = 0; order.push(s.tag); }
      byTag[s.tag] += s.dur;
    });

    /* 轴的范围：最早一段往前推整点，最晚一段往后留半格 */
    var nowMin = d.getHours() * 60 + d.getMinutes();
    var minT = segs.length ? Math.min.apply(null, segs.map(function (s) { return toMin(s.t); })) : 7 * 60;
    var maxE = segs.length ? Math.max.apply(null, segs.map(function (s) { return toMin(s.end); })) : 23 * 60;
    BASE = Math.floor(Math.min(minT, 6 * 60) / 60) * 60;
    if (BASE > minT) BASE = Math.floor(minT / 60) * 60;
    var TOPMIN = Math.ceil(Math.max(maxE + 30, nowMin + 30, 21 * 60) / 60) * 60;
    if (TOPMIN - BASE < 9 * 60) TOPMIN = BASE + 9 * 60;
    var H = (TOPMIN - BASE) / 30 * SLOT;

    var hourMarks = '';
    for (var h = BASE; h <= TOPMIN; h += 60) {
      hourMarks += '<div class="tbHour" style="top:' + ((h - BASE) / 30 * SLOT) + 'px">' + pad(h / 60) + ':00</div>';
    }

    el.innerHTML =
      '<div class="tbWrap" id="tbWrap">' +
        '<div class="tbInner" style="height:' + H + 'px">' +
          '<div class="tbHours">' + hourMarks + '</div>' +
          '<div class="tbBody" id="tbBody"></div>' +
        '</div>' +
      '</div>';

    var body = document.getElementById('tbBody');
    if (body) {
      body.style.height = H + 'px';
      body.innerHTML = segs.map(function (s, i) {
        var top = (toMin(s.t) - BASE) / 30 * SLOT;
        var hgt = s.dur / 30 * SLOT;
        var thin = hgt < 19;
        var step = 100 / (s.lanes || 1);
        var left = (s.lane || 0) * step;
        var showTime = hgt >= 42;
        var tipTxt = s.t + '–' + s.end + '  ' + (s.title || '');
        var bh = thin ? 6 : Math.max(19, hgt - 2);
        var bt = thin ? (top + Math.max(0, (hgt - 6) / 2)) : (top + 1);
        return '<div class="tbBlock' + (thin ? ' thin' : '') + (showTime ? '' : ' sm') + '" data-i="' + i + '"' +
          ' title="' + esc(tipTxt) + '"' +
          ' style="top:' + bt + 'px;height:' + bh + 'px;left:calc(' + left + '% + 3px);width:calc(' + step + '% - 6px);' +
          'background:' + (TINT[s.tag] || '#f4f4ef') + ';border-left:3px solid ' + (TAGCOL[s.tag] || '#b9bcb4') + '">' +
            (!thin ? '<b>' + esc(s.title || '（没写）') + '</b>' : '') +
            (showTime ? '<i>' + s.t + '–' + s.end + (s.dur ? ' · ' + fmtDur(s.dur) : '') + '</i>' : '') +
            (showTime && s.note ? '<em>' + esc(s.note) + '</em>' : '') +
            (thin ? '' : '<div class="tbHandle top"></div><div class="tbHandle bot"></div>') +
          '</div>';
      }).join('');
      /* 现在时刻 */
      var nM = d.getHours() * 60 + d.getMinutes();
      if (nM > BASE && nM < TOPMIN) body.innerHTML += '<div class="tbNow" style="top:' + ((nM - BASE) / 30 * SLOT) + 'px"></div>';
    }

    if (totEl) totEl.textContent = fmtDur(total);
    if (dt) dt.textContent = fmtDur(total);

    if (!total) {
      if (dn) dn.style.background = 'conic-gradient(#e9ebe6 0 100%)';
      if (lg) lg.innerHTML = '<span><i style="background:#e9ebe6"></i>还没有时长</span>';
      return;
    }
    var keys = order.slice().sort(function (a, b) { return byTag[b] - byTag[a]; });
    var acc = 0, stops = [];
    keys.forEach(function (k) {
      var a = acc / total * 100, b = (acc + byTag[k]) / total * 100;
      stops.push((TAGCOL[k] || '#b9bcb4') + ' ' + a.toFixed(2) + '% ' + (Math.max(a, b - 0.7)).toFixed(2) + '%');
      stops.push('#ffffff ' + (Math.max(a, b - 0.7)).toFixed(2) + '% ' + b.toFixed(2) + '%');
      acc += byTag[k];
    });
    if (dn) dn.style.background = 'conic-gradient(' + stops.join(',') + ')';
    if (lg) lg.innerHTML = keys.map(function (k) {
      return '<span><i style="background:' + (TAGCOL[k] || '#b9bcb4') + '"></i>' + esc(k) + '<b>' + fmtDur(byTag[k]) + '</b></span>';
    }).join('');

    ensureTrash();

    /* 默认滚到第一段附近 */
    var wrap = document.getElementById('tbWrap');
    if (wrap && !keepScroll) {
      var first = segs.length ? (toMin(segs[0].t) - BASE) / 30 * SLOT : 0;
      wrap.scrollTop = Math.max(0, first - 34);
    }
  }

  /* ---------------- 读写 ---------------- */
  function readArticle(p) {
    return fetch('/api/article?path=' + encodeURIComponent(p)).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function save(content) {
    return fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: FILE, content: content }) })
      .then(function (r) {
        if (r && r.ok) return r;
        return fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: 'timeline', name: ymd() + '.md', content: content }) });
      });
  }
  function commit(next, silent) {
    fillEnds(next);
    next.sort(function (a, b) { return toMin(a.t) - toMin(b.t); });
    ROWS = next;
    var txt = ROWS.map(fmtRow).join('\n') + '\n';
    return save(txt).then(function (r) {
      RAW = null;
      render(true);
      if (r && !r.ok && !silent) toast('保存失败，检查一下服务');
    }).catch(function () { render(true); toast('保存失败'); });
  }

  function refresh() {
    readArticle('timeline/' + ymd() + '.md').then(function (j) {
      if (j && j.content && j.content.trim()) {
        RAW = null; ROWS = parse(j.content); render(); return;
      }
      return readArticle('me/小记-' + ymd() + '.md').then(function (j2) {
        RAW = (j2 && j2.content) || null;
        ROWS = parse(RAW || '');
        render();
      });
    });
  }

  /* ---------------- 小部件 ---------------- */
  var toastEl = null, toastTimer = null;
  function toast(msg, undoFn) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'tbToast'; document.body.appendChild(toastEl); }
    toastEl.innerHTML = '<span>' + esc(msg) + '</span>' + (undoFn ? '<button type="button">撤销</button>' : '');
    toastEl.classList.add('on');
    var b = toastEl.querySelector('button');
    if (b) b.onclick = function () { toastEl.classList.remove('on'); undoFn(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, undoFn ? 6000 : 2200);
  }

  var menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; document.removeEventListener('pointerdown', menuElse, true); } }
  function menuElse(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }

  function openMenu(i, x, y, isNew) {
    closeMenu();
    var r = ROWS[i] || {};
    var items = [];
    items.push('<button type="button" data-a="rename">改名</button>');
    items.push('<button type="button" data-a="note">' + (r.note ? '改备注' : '加备注') + '</button>');
    var tags = '<div class="tbTagRow">' + Object.keys(TAGCOL).map(function (k) {
      return '<button type="button" data-tag="' + k + '" title="' + k + '"><i style="background:' + TAGCOL[k] + '"></i></button>';
    }).join('') + '</div>';
    items.push('<div class="tbMenuLbl">标签</div>' + tags);
    items.push('<button type="button" data-a="del" class="danger">删除</button>');

    menuEl = document.createElement('div');
    menuEl.className = 'tbMenu';
    menuEl.innerHTML = items.join('');
    menuEl.style.left = Math.min(x, window.innerWidth - 190) + 'px';
    menuEl.style.top = Math.min(y, window.innerHeight - 300) + 'px';
    document.body.appendChild(menuEl);
    document.addEventListener('pointerdown', menuElse, true);

    menuEl.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.getAttribute('data-tag')) { var tg = b.getAttribute('data-tag'); closeMenu(); setTag(i, tg); return; }
      var a = b.getAttribute('data-a');
      if (!a) return;
      closeMenu();
      if (a === 'rename') startRename(i, isNew);
      if (a === 'note') popNote(i, x, y);
      if (a === 'del') del(i);
    });
  }

  var popEl = null;
  function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
  function openPop(x, y, html, init) {
    closePop();
    popEl = document.createElement('div');
    popEl.className = 'tbPop';
    popEl.innerHTML = html;
    popEl.style.left = Math.min(x, window.innerWidth - 236) + 'px';
    popEl.style.top = Math.min(y, window.innerHeight - 180) + 'px';
    document.body.appendChild(popEl);
    if (init) init(popEl);
    setTimeout(function () {
      document.addEventListener('pointerdown', function h(e) {
        if (popEl && !popEl.contains(e.target)) { closePop(); document.removeEventListener('pointerdown', h); }
      });
    }, 0);
  }

  /* ---------------- 编辑动作 ---------------- */
  function startRename(i, isNew) {
    var blk = document.querySelector('.tbBlock[data-i="' + i + '"] b');
    if (!blk) return;
    var inp = document.createElement('input');
    inp.className = 'tbInline';
    inp.value = ROWS[i] ? ROWS[i].title : '';
    blk.replaceWith(inp);
    inp.focus(); inp.select();
    var done = false;
    function ok(save) {
      if (done) return; done = true;
      var v = inp.value.trim();
      if (!save) { render(true); return; }
      if (!v) { render(true); return; }
      var next = ROWS.map(function (r) { return JSON.parse(JSON.stringify(r)); });
      next[i].title = v;
      commit(next);
    }
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); ok(true); }
      if (e.key === 'Escape') ok(false);
    });
    inp.addEventListener('blur', function () { ok(true); });
  }

  function popTime(i, x, y) {
    var r = ROWS[i];
    openPop(x, y, '<div class="tbPopT">改时间</div><div class="tbPopRow"><input id="tbS" value="' + r.t + '" maxlength="5"><span>→</span><input id="tbE" value="' + r.end + '" maxlength="5"></div><div class="tbPopAct"><button type="button" id="tbOk">保存</button></div>', function (p) {
      var s = p.querySelector('#tbS'), en = p.querySelector('#tbE');
      s.focus(); s.select();
      function go() {
        var tv = s.value.trim(), ev = en.value.trim();
        if (!/^\d{1,2}:\d{2}$/.test(tv) || !/^\d{1,2}:\d{2}$/.test(ev)) { toast('写成 07:00 这种格式'); return; }
        if (toMin(ev) <= toMin(tv)) { toast('结束要晚于开始'); return; }
        closePop();
        var next = ROWS.map(function (r) { return JSON.parse(JSON.stringify(r)); });
        next[i].t = norm(tv); next[i].end = norm(ev);
        commit(next);
      }
      p.querySelector('#tbOk').onclick = go;
      [s, en].forEach(function (el) { el.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); }); });
    });
  }

  function popNote(i, x, y) {
    var r = ROWS[i];
    openPop(x, y, '<div class="tbPopT">备注</div><textarea id="tbNote" rows="3" placeholder="这段在做什么 / 为什么">' + esc(r.note || '') + '</textarea><div class="tbPopAct"><button type="button" id="tbNoteOk">保存</button></div>', function (p) {
      var ta = p.querySelector('#tbNote');
      ta.focus();
      function go() {
        closePop();
        var next = ROWS.map(function (r) { return JSON.parse(JSON.stringify(r)); });
        next[i].note = ta.value.trim();
        commit(next);
      }
      p.querySelector('#tbNoteOk').onclick = go;
      ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go(); });
    });
  }

  function setTag(i, tag) {
    if (!TAGCOL[tag]) return;
    var next = ROWS.map(function (r) { return JSON.parse(JSON.stringify(r)); });
    next[i].tag = tag;
    commit(next);
  }

  function del(i) {
    var backup = ROWS.map(function (r) { return JSON.parse(JSON.stringify(r)); });
    var next = ROWS.slice();
    var gone = next.splice(i, 1);
    commit(next);
    toast('删掉了「' + ((gone[0] && gone[0].title) || '') + '」', function () { commit(backup); });
  }

  /* 垃圾桶：拖动时浮出，拖进去就删 */
  function ensureTrash() {
    var col = document.querySelector('.tlCol');
    if (!col || document.getElementById('tbTrash')) return;
    var t = document.createElement('div');
    t.id = 'tbTrash';
    t.className = 'tbTrash';
    t.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/><path d="M10 11.5v5.5M14 11.5v5.5"/></svg>';
    col.appendChild(t);
  }
  function showTrash(on) {
    ensureTrash();
    var t = document.getElementById('tbTrash');
    if (!t) return;
    t.classList.toggle('on', !!on);
    if (!on) t.classList.remove('hot');
  }
  function dropDelete(i) {
    var backup = ROWS.map(function (r) { return JSON.parse(JSON.stringify(r)); });
    var next = ROWS.slice();
    var gone = next.splice(i, 1);
    commit(next);
    toast('拖进垃圾桶删掉了「' + ((gone[0] && gone[0].title) || '') + '」', function () { commit(backup); });
  }

  /* ---------------- 拖动 / 拉伸 / 新建 ---------------- */
  var drag = null;

  function snapMin(m) { return Math.round(m / SNAP) * SNAP; }

  document.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    var blk = e.target.closest && e.target.closest('.tbBlock');
    if (!blk) return;
    var card = blk;
    var rect = card.getBoundingClientRect();
    var i = +card.getAttribute('data-i');
    var h = rect.height;
    var edge = h >= 44 ? 10 : 7;
    var mode = 'move';
    if (h >= 26 && e.clientY - rect.top < edge) mode = 'top';
    else if (h >= 26 && rect.bottom - e.clientY < edge) mode = 'end';
    drag = {
      i: i, mode: mode, y0: e.clientY, el: card, moved: false,
      t0: toMin(ROWS[i].t), e0: toMin(ROWS[i].end),
      baseTop: parseFloat(card.style.top), baseH: parseFloat(card.style.height)
    };
    e.preventDefault();
  });

  window.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var dy = e.clientY - drag.y0;
    if (!drag.moved) {
      if (Math.abs(dy) < 3) return;
      drag.moved = true;
      drag.el.classList.add('dragging');
      document.body.classList.add('tbDragging');
      showTrash(true);
    }
    var dMin = snapMin(dy / SLOT * 30);
    /* 拖到垃圾桶上就标红（只有整块移动才允许删） */
    var tr = document.getElementById('tbTrash');
    if (tr) {
      var rc = tr.getBoundingClientRect();
      var inside = drag.mode === 'move' && e.clientX > rc.left - 6 && e.clientX < rc.right + 6 && e.clientY > rc.top - 6 && e.clientY < rc.bottom + 6;
      tr.classList.toggle('hot', inside);
      drag.trashHit = inside;
    }
    var tip = document.getElementById('tbTip');
    if (drag.trashHit) {
      if (tip) tip.textContent = '松手删除';
      if (tip) { tip.style.left = (e.clientX + 14) + 'px'; tip.style.top = (e.clientY - 26) + 'px'; }
      return;
    }
    var r = ROWS[drag.i];
    var t = drag.t0, en = drag.e0;
    if (drag.mode === 'move') {
      t = Math.max(0, Math.min(24 * 60 - (en - t), drag.t0 + dMin));
      en = t + (drag.e0 - drag.t0);
    } else if (drag.mode === 'end') {
      en = Math.max(t + SNAP, Math.min(24 * 60, drag.e0 + dMin));
    } else {
      t = Math.max(0, Math.min(en - SNAP, drag.t0 + dMin));
    }
    drag.cur = { t: t, end: en };
    var top = (t - BASE) / 30 * SLOT;
    var hgt = (en - t) / 30 * SLOT;
    drag.el.style.top = top + 'px';
    drag.el.style.height = Math.max(18, hgt) + 'px';
    drag.el.classList.toggle('sm', hgt < 36);
    var lab = drag.el.querySelector('i');
    if (lab) lab.textContent = toHHMM(t) + '–' + toHHMM(en);
    var b = drag.el.querySelector('b');
    if (b) b.title = toHHMM(t) + '–' + toHHMM(en);
    /* 悬浮跟随的时间提示 */
    var tip = document.getElementById('tbTip');
    if (!tip) { tip = document.createElement('div'); tip.id = 'tbTip'; tip.className = 'tbTip'; document.body.appendChild(tip); }
    tip.textContent = toHHMM(t) + ' – ' + toHHMM(en);
    tip.style.left = (e.clientX + 14) + 'px';
    tip.style.top = (e.clientY - 26) + 'px';
  });

  window.addEventListener('pointerup', function (e) {
    if (!drag) return;
    var d = drag; drag = null;
    document.body.classList.remove('tbDragging');
    var tip = document.getElementById('tbTip'); if (tip) tip.remove();
    d.el.classList.remove('dragging');
    showTrash(false);
    if (d.moved && d.trashHit && d.mode === 'move') { dropDelete(d.i); return; }
    if (!d.moved || !d.cur) { return; }
    var next = ROWS.map(function (r) { return JSON.parse(JSON.stringify(r)); });
    next[d.i].t = toHHMM(d.cur.t);
    next[d.i].end = toHHMM(d.cur.end);
    commit(next);
  });

  window.addEventListener('contextmenu', function (e) {
    var blk = e.target.closest && e.target.closest('.tbBlock');
    if (!blk) return;
    e.preventDefault();
    openMenu(+blk.getAttribute('data-i'), e.clientX, e.clientY, false);
  });

  window.addEventListener('dblclick', function (e) {
    var blk = e.target.closest && e.target.closest('.tbBlock');
    if (!blk) return;
    e.preventDefault();
    startRename(+blk.getAttribute('data-i'), false);
  });

  /* 点空白格：以该格为开始新建一段 */
  document.addEventListener('click', function (e) {
    var body = e.target.closest && e.target.closest('.tbBody');
    if (!body) return;
    if (e.target.closest('.tbBlock') || e.target.closest('.tbInline')) return;
    var rect = body.getBoundingClientRect();
    var y = e.clientY - rect.top;
    var st = Math.floor((BASE + y / SLOT * 30) / 30) * 30;
    var en = st + 30;
    var next = ROWS.map(function (r) { return JSON.parse(JSON.stringify(r)); });
    next.push({ t: toHHMM(st), end: toHHMM(en), title: '（新的一段）', tag: '其他', note: '' });
    fillEnds(next);
    next.sort(function (a, b) { return toMin(a.t) - toMin(b.t); });
    ROWS = next;
    render(true);
    save(ROWS.map(fmtRow).join('\n') + '\n').then(function () { RAW = null; });
    var idx = ROWS.findIndex ? ROWS.findIndex(function (r) { return r.title === '（新的一段）' && toMin(r.t) === st; }) : -1;
    if (idx >= 0) setTimeout(function () { startRename(idx, true); }, 60);
  });

  /* ---------------- 记一段 ---------------- */
  function mark(txt) {
    var n = new Date(), hh = pad(n.getHours()) + ':' + pad(n.getMinutes());
    txt = String(txt || '').trim();
    if (!txt) return;
    if (RAW !== null && !ROWS.length) {
      var one = [{ t: hh, end: toHHMM(toMin(hh) + 30), title: txt, tag: guess(txt), note: '' }];
      return save(one.map(fmtRow).join('\n') + '\n').then(function () { refresh(); });
    }
    var last = ROWS[ROWS.length - 1];
    var st = last && toMin(last.end) <= toMin(hh) ? last.end : hh;
    var next = ROWS.map(function (r) { return JSON.parse(JSON.stringify(r)); });
    next.push({ t: st, end: toHHMM(toMin(st) + 30), title: txt, tag: guess(txt), note: '' });
    commit(next);
  }

  var btn = document.getElementById('tlAddBtn'), box = document.getElementById('tlAddBox'), inp = document.getElementById('tlInput');
  if (btn && box) {
    btn.addEventListener('click', function () {
      var on = box.style.display !== 'none';
      box.style.display = on ? 'none' : 'block';
      if (!on && inp) { inp.value = ''; inp.focus(); }
    });
  }
  if (inp) {
    inp.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var v = inp.value.trim(); if (!v) return;
      inp.value = ''; if (box) box.style.display = 'none';
      mark(v);
    });
  }

  /* ---------------- 样式 ---------------- */
  var css = '' +
    '.tbWrap{max-height:640px;overflow-y:auto;overflow-x:hidden;padding:0 4px 8px 0;scrollbar-width:thin}' +
    '.tbInner{position:relative;display:flex}' +
    '.tbHours{width:44px;flex:0 0 44px;position:relative;pointer-events:none}' +
    '.tbHour{position:absolute;right:9px;transform:translateY(-50%);font-size:11px;color:#b3b3ad;font-variant-numeric:tabular-nums;letter-spacing:.01em}' +
    '.tbBody{position:relative;flex:1;border-left:1px solid #e7e5df;' +
      'background-image:linear-gradient(to bottom,rgba(0,0,0,.055) 1px,transparent 1px),linear-gradient(to bottom,rgba(0,0,0,.024) 1px,transparent 1px);' +
      'background-size:100% ' + (SLOT * 2) + 'px,100% ' + SLOT + 'px}' +
    '.tbBlock{position:absolute;border-radius:7px;padding:3px 9px;overflow:hidden;cursor:grab;box-sizing:border-box;' +
      'box-shadow:0 1px 2px rgba(0,0,0,.03);transition:box-shadow .16s,filter .16s}' +
    '.tbBlock:hover{box-shadow:0 3px 12px rgba(0,0,0,.09)}' +
    '.tbBlock.dragging{opacity:.86;box-shadow:0 14px 34px rgba(0,0,0,.18);cursor:grabbing;z-index:9}' +
    '.tbBlock b{display:block;font-size:12.5px;font-weight:600;color:#2b2b28;line-height:19px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.tbBlock i{display:block;font-style:normal;font-size:10.5px;color:#8b8b85;font-variant-numeric:tabular-nums;line-height:15px;white-space:nowrap;overflow:hidden}' +
    '.tbBlock em{display:block;font-style:normal;font-size:10.5px;color:#9a9a93;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.tbBlock.sm b{font-size:11.5px;line-height:16px;font-weight:500}' +
    '.tbBlock.thin{padding:0;border-left-width:3px;border-radius:3px;min-height:6px}' +
    '.tbBlock.thin b,.tbBlock.thin i,.tbBlock.thin em{display:none}' +
    '.tbNow{position:absolute;left:0;right:0;height:1px;background:#eba24b;opacity:.8;pointer-events:none;z-index:4}' +
    '.tbNow:before{content:"";position:absolute;left:-1px;top:-3px;width:7px;height:7px;border-radius:50%;background:#eba24b}' +
    '.tbInline{position:absolute;left:6px;right:6px;top:3px;font:inherit;font-size:12.5px;padding:3px 6px;border:1px solid #d6d7cf;border-radius:6px;outline:none;background:#fff;z-index:12}' +
    'body.tbDragging,body.tbDragging *{user-select:none!important;cursor:grabbing!important}' +
    '.tbTip{position:fixed;background:#2b2b28;color:#f5f5f0;font-size:11.5px;padding:3px 8px;border-radius:6px;pointer-events:none;z-index:130;font-variant-numeric:tabular-nums}' +
    '.tbMenu{position:fixed;z-index:120;background:#fff;border:1px solid #e8e8e2;border-radius:11px;box-shadow:0 14px 34px rgba(0,0,0,.12);padding:5px;min-width:150px;font-size:12.5px}' +
    '.tbMenu button{display:block;width:100%;text-align:left;font:inherit;font-size:12.5px;color:#33332f;background:none;border:0;padding:7px 10px;border-radius:7px;cursor:pointer}' +
    '.tbMenu button:hover{background:#f5f5f0}' +
    '.tbMenu button.danger{color:#c0503f}' +
    '.tbMenuLbl{font-size:11px;color:#a9a9a3;padding:7px 10px 3px}' +
    '.tbTagRow{display:flex;gap:5px;padding:2px 10px 6px}' +
    '.tbTagRow button{width:19px;height:19px;padding:0;border-radius:50%;border:1px solid rgba(0,0,0,.08);display:flex;align-items:center;justify-content:center;background:#fff}' +
    '.tbTagRow button:hover{background:#fff;transform:scale(1.08)}' +
    '.tbTagRow i{width:11px;height:11px;border-radius:50%;display:block}' +
    '.tbPop{position:fixed;z-index:125;background:#fff;border:1px solid #e6e6df;border-radius:12px;box-shadow:0 14px 34px rgba(0,0,0,.12);padding:12px;width:212px;font-size:12.5px}' +
    '.tbPopT{font-size:11px;color:#a9a9a3;margin-bottom:8px;letter-spacing:.02em}' +
    '.tbPopRow{display:flex;align-items:center;gap:6px}' +
    '.tbPopRow input{width:56px;font:inherit;font-size:13px;padding:5px 6px;border:1px solid #e2e2db;border-radius:7px;outline:none;text-align:center;font-variant-numeric:tabular-nums}' +
    '.tbPopRow span{color:#a9a9a3}' +
    '.tbPop textarea{width:100%;font:inherit;font-size:12.5px;line-height:1.6;padding:7px 8px;border:1px solid #e2e2db;border-radius:8px;outline:none;resize:vertical;color:#3a3a37;box-sizing:border-box}' +
    '.tbPopAct{margin-top:9px;text-align:right}' +
    '.tbPopAct button{font:inherit;font-size:12px;padding:5px 12px;border-radius:7px;border:1px solid #e2e2db;background:#fff;cursor:pointer}' +
    '.tbPopAct button:hover{background:#f5f5f0}' +
    '.tbToast{position:fixed;left:50%;bottom:30px;transform:translate(-50%,14px);display:flex;align-items:center;gap:14px;background:#2b2b28;color:#f4f4ef;font-size:12.5px;padding:9px 14px;border-radius:100px;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:140}' +
    '.tbToast.on{opacity:1;transform:translate(-50%,0);pointer-events:auto}' +
    '.tbToast button{font:inherit;font-size:12px;background:none;border:0;color:#ffd7a8;cursor:pointer;padding:0}' +
    '.tlCol{position:relative}' +
    '.tbHandle{position:absolute;left:0;right:0;height:9px;cursor:ns-resize;z-index:3}' +
    '.tbHandle.top{top:0;border-radius:7px 7px 0 0}' +
    '.tbHandle.bot{bottom:0;border-radius:0 0 7px 7px}' +
    '.tbBlock:hover .tbHandle{background:rgba(255,255,255,.72)}' +
    '.tbBlock.sm .tbHandle{height:6px}' +
    '.tbTrash{position:absolute;right:4px;bottom:4px;width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#fff;border:1.5px dashed #deded6;color:#b5b5ad;opacity:0;transform:scale(.88);transition:opacity .18s,transform .18s,background .18s,border-color .18s,color .18s;pointer-events:none;z-index:11}' +
    '.tbTrash.on{opacity:.92;transform:scale(1)}' +
    '.tbTrash.hot{background:#fdeeec;border-color:#e09284;color:#c3493a;transform:scale(1.14);opacity:1;border-style:solid}' +
    '.tbTrash svg{width:18px;height:18px;display:block}' +
    '';

  if (!document.getElementById('tbEditCss')) {
    var st = document.createElement('style');
    st.id = 'tbEditCss';
    st.textContent = css;
    document.head.appendChild(st);
  }

  refresh();
})();
