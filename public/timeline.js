/*
 * timeline.js —— 首屏时间轴：左侧竖轴 + 右侧时长环
 * 数据源：data/timeline/YYYY-MM-DD.md（时间段，可编辑）
 *         若没有，退回读 data/me/小记-YYYY-MM-DD.md（只读，首次编辑时自动迁到 timeline）
 * 行格式：07:00-07:10 喝酸奶 #吃｜备注（标签、备注都可以省略）
 *
 * 交互（参考 Planly 的竖轴时长块 + vis-timeline 的拖拽 + 主流编辑器的就地编辑）：
 *   拖卡片  → 和目标时间槽互换位置（时长一起走）
 *   双击标题 → 就地改名
 *   时间    → 弹小面板改起止
 *   标签    → 弹色点选择
 *   删      → 删掉这一段，底部提示可撤销
 *   备注    → 卡片下方写一句话
 */
(function () {
  var TAGCOL = { '做事': '#41a1cf', '吃': '#e07a5f', '会议': '#8578dd', '课': '#4ea36c', '通勤': '#9aa0a6', '休息': '#c9a227', '生活': '#7cb7d3', '其他': '#b9bcb4' };
  var TINT = { '做事': '#e9f1fa', '吃': '#fbeae4', '会议': '#efecfb', '课': '#eaf3ea', '通勤': '#f1f2f3', '休息': '#fbf4df', '生活': '#e0eff6', '其他': '#f4f4ef' };
  var FILE = 'timeline/' + ymd() + '.md';
  var ROWS = [];      /* 当前数据 */
  var RAW = null;     /* 小记模式下的原文（只读） */
  var HIST = [];
  var busy = false;

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function norm(t) { var p = String(t).split(':'); return pad(+p[0]) + ':' + (p[1] || '00'); }
  function toMin(t) { var p = String(t).split(':'); return (+p[0]) * 60 + (+p[1]); }
  function addMin(t, m) { var x = toMin(t) + m; return pad(Math.floor(x / 60) % 24) + ':' + pad(x % 60); }
  function fmtDur(m) { if (!m) return '0 min'; var h = Math.floor(m / 60), r = m % 60; if (!h) return r + ' min'; return h + ' hr' + (r ? ' ' + r + ' min' : ''); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function guess(text) {
    if (/会议|开会|例会|讨论/.test(text)) return '会议';
    if (/通勤|走|地铁|公交|路上|回宿舍|路上/.test(text)) return '通勤';
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

  /* 补齐每段的结束时间（没有明确的，向后推） */
  function fillEnds(list) {
    var now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
    list.forEach(function (s, i) {
      if (s.end) return;
      var nx = list[i + 1];
      var dur = nx ? (toMin(nx.t) - toMin(s.t)) : (nowMin - toMin(s.t));
      if (dur <= 0 || dur > 480) dur = 30;
      s.end = addMin(s.t, dur);
    });
    return list;
  }

  function segsOf(list) {
    return fillEnds(list.map(function (r) { return { t: r.t, end: r.end, title: r.title, tag: r.tag, note: r.note }; })).map(function (s) {
      var dur = toMin(s.end) - toMin(s.t);
      if (dur <= 0) dur = null;
      return { t: s.t, end: s.end, title: s.title || '（没写）', tag: s.tag || '其他', note: s.note || '', dur: dur };
    });
  }

  function fmtRow(r) {
    return pad(r.t) + '-' + pad(r.end) + ' ' + r.title + ' #' + r.tag + (r.note ? '｜' + String(r.note).replace(/\r?\n/g, ' ') : '');
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    var el = document.getElementById('tlList');
    if (!el) return;
    var dn = document.getElementById('donut'), dt = document.getElementById('dnTotal'), lg = document.getElementById('dnLegend');
    var dayEl = document.getElementById('tlDate'), totEl = document.getElementById('tlTotal');
    var d = new Date();
    if (dayEl) dayEl.textContent = pad(d.getMonth() + 1) + '.' + pad(d.getDate());

    if (!ROWS.length) {
      el.innerHTML = '<div class="tlEmpty">今天还没有记录。<br>点右上角「记一段」，或者让我按时间段写进来。</div>';
      if (dn) dn.style.background = '#f3f4f0';
      if (dt) dt.textContent = '0 min';
      if (totEl) totEl.textContent = '0 min';
      if (lg) lg.innerHTML = '';
      return;
    }

    var segs = segsOf(ROWS);
    var total = 0, byTag = {}, order = [];
    segs.forEach(function (s) {
      if (s.dur === null) return;
      total += s.dur;
      if (!byTag[s.tag]) { byTag[s.tag] = 0; order.push(s.tag); }
      byTag[s.tag] += s.dur;
    });

    el.innerHTML = segs.map(function (s, i) {
      var sub = s.t + '   –   ' + s.end + (s.dur ? ('   ·   ' + fmtDur(s.dur)) : '');
      return '<div class="tlRow" data-i="' + i + '">' +
        '<div class="tlTime" title="点一下改时间">' + s.t + '</div>' +
        '<div class="tlRail"><i class="tlDot' + (s.dur ? ' on' : '') + '" style="' + (s.dur ? ('background:' + (TAGCOL[s.tag] || '#2c2c2c')) : '') + '"></i></div>' +
        '<div class="tlCard" style="background:' + (TINT[s.tag] || '#f4f4ef') + '">' +
          '<h4 title="双击改名">' + esc(s.title) + '</h4>' +
          '<p>' + esc(sub) + '</p>' +
          (s.note ? '<div class="tlNote">' + esc(s.note) + '</div>' : '') +
          '<div class="tlOps">' +
            '<button class="tlOp" data-act="note" type="button">备注</button>' +
            '<button class="tlOp" data-act="tag" type="button"><i style="background:' + (TAGCOL[s.tag] || '#b9bcb4') + '"></i>标签</button>' +
            '<button class="tlOp" data-act="del" type="button">删</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');

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
  }

  /* ---------------- 读写 ---------------- */
  function readArticle(p) {
    return fetch('/api/article?path=' + encodeURIComponent(p)).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function save(content) {
    return fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: FILE, content: content }) })
      .then(function (r) {
        if (r && r.ok) return r;
        /* 文件还不存在时换 upload 建一份 */
        return fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: 'timeline', name: ymd() + '.md', content: content }) });
      });
  }
  /* 把 ROWS 写回文件；编辑小记数据时先自动落到 timeline 文件 */
  function commit(next, undoRows) {
    if (busy) return;
    busy = true;
    if (RAW !== null) FILE = 'timeline/' + ymd() + '.md';
    HIST.push(undoRows || ROWS.map(function (r) { return JSON.parse(JSON.stringify(r)); }));
    if (HIST.length > 20) HIST.shift();
    fillEnds(next);
    next.sort(function (a, b) { return toMin(a.t) - toMin(b.t); });   /* 永远按时间从早到晚排 */
    ROWS = next;
    var txt = ROWS.map(fmtRow).join('\n') + '\n';
    save(txt).then(function (r) {
      busy = false; RAW = null;
      if (r && r.ok) render(); else { toast('保存失败，检查一下服务'); }
    }).catch(function () { busy = false; toast('保存失败'); });
  }

  function refresh() {
    readArticle('timeline/' + ymd() + '.md').then(function (j) {
      if (j && j.content && j.content.trim()) {
        RAW = null; FILE = 'timeline/' + ymd() + '.md';
        ROWS = parse(j.content);
        render(); return;
      }
      return readArticle('me/小记-' + ymd() + '.md').then(function (j2) {
        RAW = (j2 && j2.content) || null;
        FILE = 'timeline/' + ymd() + '.md';
        ROWS = parse(RAW || '');
        render();
      });
    });
  }

  /* ---------------- 小部件 ---------------- */
  var toastEl = null;
  function toast(msg, undoFn) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'tlToast';
      document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = '<span>' + esc(msg) + '</span>' + (undoFn ? '<button type="button">撤销</button>' : '');
    toastEl.classList.add('on');
    var b = toastEl.querySelector('button');
    if (b) b.onclick = function () { toastEl.classList.remove('on'); undoFn(); };
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.classList.remove('on'); }, undoFn ? 6000 : 2400);
  }

  var popEl = null;
  function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
  function openPop(anchor, html, onInit) {
    closePop();
    popEl = document.createElement('div');
    popEl.className = 'tlPop';
    popEl.innerHTML = html;
    popEl.style.left = Math.min(anchor.left, window.innerWidth - 230) + 'px';
    popEl.style.top = (anchor.top + anchor.height + 6) + 'px';
    document.body.appendChild(popEl);
    if (onInit) onInit(popEl);
    setTimeout(function () {
      document.addEventListener('pointerdown', function h(e) {
        if (popEl && !popEl.contains(e.target)) { closePop(); document.removeEventListener('pointerdown', h); }
      });
    }, 0);
  }

  function idxOf(node) {
    var row = node.closest ? node.closest('.tlRow') : null;
    return row ? +row.getAttribute('data-i') : -1;
  }

  /* 交换两个时间槽（内容跟着时长一起走） */
  function swapSlot(a, b) {
    var A = ROWS[a], B = ROWS[b];
    var t = A.t, e = A.end;
    A.t = B.t; A.end = B.end;
    B.t = t; B.end = e;
  }

  /* ---------------- 编辑动作 ---------------- */
  function rename(i, val) {
    var v = String(val || '').trim();
    if (!v || v === ROWS[i].title) { render(); return; }
    var next = ROWS.slice();
    next[i] = JSON.parse(JSON.stringify(next[i])); next[i].title = v;
    commit(next);
  }

  function setNote(i, val) {
    var v = String(val || '').trim();
    if (v === (ROWS[i].note || '')) { render(); return; }
    var next = ROWS.slice();
    next[i] = JSON.parse(JSON.stringify(next[i])); next[i].note = v;
    commit(next);
  }

  function setTime(i, t, e) {
    if (!/^\d{1,2}:\d{2}$/.test(t) || !/^\d{1,2}:\d{2}$/.test(e)) { toast('时间格式要写成 07:00'); return; }
    if (toMin(e) <= toMin(t)) { toast('结束要晚于开始'); return; }
    var next = ROWS.slice();
    next[i] = JSON.parse(JSON.stringify(next[i]));
    next[i].t = norm(t); next[i].end = norm(e);
    commit(next);
  }

  function setTag(i, tag) {
    if (!TAGCOL[tag]) return;
    var next = ROWS.slice();
    next[i] = JSON.parse(JSON.stringify(next[i])); next[i].tag = tag;
    commit(next, null);
  }

  function del(i) {
    var backup = ROWS.map(function (r) { return JSON.parse(JSON.stringify(r)); });
    var next = ROWS.slice();
    var removed = next.splice(i, 1);
    commit(next, null);
    toast('删掉了「' + (removed[0] ? removed[0].title : '') + '」', function () { commit(backup, null); });
  }

  /* 事件委托 */
  var listEl = document.getElementById('tlList');
  if (listEl) {
    listEl.addEventListener('dblclick', function (e) {
      var h = e.target.closest && e.target.closest('.tlCard h4');
      if (!h) return;
      var i = idxOf(h);
      var old = ROWS[i] ? ROWS[i].title : '';
      var inp = document.createElement('input');
      inp.className = 'tlInline';
      inp.value = old;
      h.replaceWith(inp);
      inp.focus(); inp.select();
      var done = false;
      function ok(save) { if (done) return; done = true; save ? rename(i, inp.value) : render(); }
      inp.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') ok(true);
        if (ev.key === 'Escape') ok(false);
      });
      inp.addEventListener('blur', function () { ok(true); });
    });

    listEl.addEventListener('click', function (e) {
      var t = e.target;
      /* 点时间：改起止 */
      if (t.classList && t.classList.contains('tlTime')) {
        var i = idxOf(t), r = ROWS[i];
        if (!r) return;
        openPop(t.getBoundingClientRect(), '<div class="tlPopT">改时间</div>' +
          '<div class="tlPopRow"><input id="tpS" value="' + r.t + '" maxlength="5"><span>→</span><input id="tpE" value="' + r.end + '" maxlength="5"></div>' +
          '<div class="tlPopAct"><button type="button" id="tpOk">保存</button></div>',
          function (p) {
            var s = p.querySelector('#tpS'), en = p.querySelector('#tpE');
            s.focus();
            p.querySelector('#tpOk').onclick = function () { closePop(); setTime(i, s.value.trim(), en.value.trim()); };
            [s, en].forEach(function (x) {
              x.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { closePop(); setTime(i, s.value.trim(), en.value.trim()); } });
            });
          });
        return;
      }
      var op = t.closest && t.closest('.tlOp');
      if (!op) return;
      var i = idxOf(op), act = op.getAttribute('data-act');
      if (act === 'del') { del(i); return; }
      if (act === 'tag') {
        openPop(op.getBoundingClientRect(), '<div class="tlPopT">换个标签</div><div class="tlTags">' +
          Object.keys(TAGCOL).map(function (k) {
            return '<button type="button" data-k="' + k + '"><i style="background:' + TAGCOL[k] + '"></i>' + k + '</button>';
          }).join('') + '</div>', function (p) {
            p.querySelectorAll('.tlTags button').forEach(function (b) {
              b.onclick = function () { closePop(); setTag(i, b.getAttribute('data-k')); };
            });
          });
        return;
      }
      if (act === 'note') {
        var r2 = ROWS[i];
        openPop(op.getBoundingClientRect(), '<div class="tlPopT">写一句备注</div>' +
          '<textarea id="tpNote" rows="3" placeholder="比如：为什么吃这么慢 / 这段在做哪一步">' + esc(r2.note || '') + '</textarea>' +
          '<div class="tlPopAct"><button type="button" id="tpNoteOk">保存</button></div>', function (p) {
            var ta = p.querySelector('#tpNote');
            ta.focus();
            p.querySelector('#tpNoteOk').onclick = function () { closePop(); setNote(i, ta.value); };
          });
        return;
      }
    });

    /* 拖动换位 */
    var drag = null;
    listEl.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var card = e.target.closest && e.target.closest('.tlCard');
      if (!card) return;
      if (e.target.closest('.tlOp') || e.target.closest('input') || e.target.closest('textarea')) return;
      var row = card.parentNode, i = +row.getAttribute('data-i');
      drag = { i: i, y0: e.clientY, moved: false, row: row, card: card };
    });
    window.addEventListener('pointermove', function (e) {
      if (!drag) return;
      if (!drag.moved) {
        if (Math.abs(e.clientY - drag.y0) < 6) return;
        drag.moved = true;
        drag.card.classList.add('dragging');
        document.body.classList.add('tlDragging');
      }
      /* 找指针落在哪一行 */
      var rows = listEl.querySelectorAll('.tlRow');
      var hit = null;
      for (var k = 0; k < rows.length; k++) {
        var rc = rows[k].getBoundingClientRect();
        if (e.clientY >= rc.top && e.clientY <= rc.bottom) { hit = k; break; }
      }
      rows.forEach(function (r) { r.classList.remove('dropTarget'); });
      if (hit != null && hit !== drag.i) rows[hit].classList.add('dropTarget');
      drag.hit = hit;
    });
    window.addEventListener('pointerup', function () {
      if (!drag) return;
      var d = drag; drag = null;
      document.body.classList.remove('tlDragging');
      listEl.querySelectorAll('.tlRow').forEach(function (r) { r.classList.remove('dropTarget'); });
      if (d.moved && d.hit != null && d.hit !== d.i) {
        var next = ROWS.map(function (r) { return JSON.parse(JSON.stringify(r)); });
        var step = d.hit > d.i ? 1 : -1;
        var p = d.i;
        while (p !== d.hit) {
          var A = next[p], B = next[p + step];
          var t = A.t, en = A.end;
          A.t = B.t; A.end = B.end; B.t = t; B.end = en;
          p += step;
        }
        commit(next);
        toast('换好了，时长跟着走');
      } else {
        render();
      }
    });
  }

  /* ---------------- 记一段 ---------------- */
  function appendTo(p, line, folder, name) {
    return readArticle(p).then(function (j) {
      var cur = j && j.content;
      if (cur != null && String(cur).trim() !== '') {
        var nc = String(cur).replace(/\s+$/, '') + '\n' + line + '\n';
        return fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p, content: nc }) });
      }
      return fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: folder, name: name, content: line + '\n' }) });
    });
  }

  function mark(txt) {
    var n = new Date(), hh = pad(n.getHours()) + ':' + pad(n.getMinutes());
    txt = String(txt || '').trim();
    if (!txt) return;
    if (RAW !== null || !ROWS.length) {
      /* 走文件追加（timeline 已有内容时） */
      return readArticle(FILE).then(function (j) {
        if (j && j.content != null && j.content.trim() !== '') {
          return appendTo(FILE, hh + ' ' + txt, 'timeline', ymd() + '.md');
        }
        /* 空的：直接用结构化写 */
        var r = [{ t: hh, end: addMin(hh, 30), title: txt, tag: guess(txt), note: '' }];
        return fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: FILE, content: r.map(fmtRow).join('\n') + '\n' }) });
      }).then(refresh).catch(function () { toast('没写进去'); });
    }
    var last = ROWS[ROWS.length - 1];
    var st = last && toMin(last.end) <= toMin(hh) ? last.end : hh;
    var next = ROWS.concat([{ t: st, end: addMin(st, 30), title: txt, tag: guess(txt), note: '' }]);
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
    '.tlCard{position:relative;cursor:grab}' +
    '.tlCard.dragging{opacity:.5;cursor:grabbing;box-shadow:0 10px 26px rgba(0,0,0,.10);transform:scale(.995)}' +
    '.tlRow.dropTarget .tlCard{outline:2px dashed #c4c6bd;outline-offset:-3px}' +
    'body.tlDragging,body.tlDragging *{user-select:none!important;cursor:grabbing!important}' +
    '.tlOps{position:absolute;right:7px;top:7px;display:flex;gap:3px;opacity:0;transition:opacity .14s ease}' +
    '.tlCard:hover .tlOps,.tlCard:focus-within .tlOps{opacity:1}' +
    '.tlOp{border:1px solid rgba(0,0,0,.07);background:rgba(255,255,255,.82);border-radius:7px;font:inherit;font-size:11.5px;color:#5a5a55;padding:3px 7px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;transition:background .14s}' +
    '.tlOp:hover{background:#fff;color:#1f1f1d}' +
    '.tlOp i{width:6px;height:6px;border-radius:50%;display:inline-block}' +
    '.tlNote{margin-top:6px;font-size:12px;line-height:1.65;color:#8b8b84;padding-left:8px;border-left:2px solid rgba(0,0,0,.10)}' +
    '.tlInline{font:inherit;font-size:14.5px;font-weight:600;color:#2c2c2c;background:#fff;border:1px solid #d8d9d2;border-radius:6px;padding:2px 6px;width:60%;outline:none}' +
    '.tlTime{cursor:pointer;border-radius:5px;transition:background .14s}' +
    '.tlTime:hover{background:#f2f2ee;color:#5a5a55}' +
    '.tlPop{position:fixed;z-index:99;background:#fff;border:1px solid #e6e6df;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.10);padding:12px;width:216px;font-size:12.5px}' +
    '.tlPopT{font-size:11.5px;color:#a5a5a0;letter-spacing:.02em;margin-bottom:8px}' +
    '.tlPopRow{display:flex;align-items:center;gap:6px}' +
    '.tlPopRow input{width:58px;font:inherit;font-size:13px;padding:5px 6px;border:1px solid #e2e2db;border-radius:7px;outline:none;text-align:center;font-variant-numeric:tabular-nums}' +
    '.tlPopRow span{color:#a5a5a0}' +
    '.tlPop textarea{width:100%;font:inherit;font-size:12.5px;line-height:1.6;padding:7px 8px;border:1px solid #e2e2db;border-radius:8px;outline:none;resize:vertical;color:#3a3a37}' +
    '.tlPopAct{margin-top:9px;text-align:right}' +
    '.tlPopAct button{font:inherit;font-size:12px;padding:5px 12px;border-radius:7px;border:1px solid #e2e2db;background:#fff;cursor:pointer}' +
    '.tlPopAct button:hover{background:#f4f4ef}' +
    '.tlTags{display:grid;grid-template-columns:1fr 1fr;gap:5px}' +
    '.tlTags button{display:flex;align-items:center;gap:6px;font:inherit;font-size:12px;padding:6px 8px;border:1px solid #ecece5;border-radius:8px;background:#fff;cursor:pointer;color:#3a3a37}' +
    '.tlTags button:hover{background:#f7f7f2}' +
    '.tlTags i{width:8px;height:8px;border-radius:50%}' +
    '.tlToast{position:fixed;left:50%;bottom:30px;transform:translate(-50%,14px);display:flex;align-items:center;gap:14px;background:#2b2b28;color:#f4f4ef;font-size:12.5px;padding:9px 14px;border-radius:100px;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:120}' +
    '.tlToast.on{opacity:1;transform:translate(-50%,0);pointer-events:auto}' +
    '.tlToast button{font:inherit;font-size:12px;background:none;border:0;color:#ffd7a8;cursor:pointer;padding:0}' +
    '';

  function injectCss() {
    if (document.getElementById('tlEditCss')) return;
    var s = document.createElement('style');
    s.id = 'tlEditCss';
    s.textContent = css;
    document.head.appendChild(s);
  }
  injectCss();

  refresh();
})();
