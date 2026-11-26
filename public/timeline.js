/*
 * timeline.js —— 首屏时间轴：左侧竖轴 + 右侧时长环
 * 数据源优先级：data/timeline/YYYY-MM-DD.md（时间段，精确）
 *               其次 data/me/小记-YYYY-MM-DD.md（## HH:MM 打点）
 * 行格式：07:00-07:10 喝酸奶 #吃   （#标签可省，省了按关键词猜）
 */
(function () {
  var TAGCOL = { '做事': '#41a1cf', '吃': '#e07a5f', '会议': '#8578dd', '课': '#4ea36c', '通勤': '#9aa0a6', '休息': '#c9a227', '生活': '#7cb7d3', '其他': '#b9bcb4' };
  var TINT = { '做事': '#e9f1fa', '吃': '#fbeae4', '会议': '#efecfb', '课': '#eaf3ea', '通勤': '#f1f2f3', '休息': '#fbf4df', '生活': '#e0eff6', '其他': '#f4f4ef' };

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
    var tg = null, m = body.match(/\s*#([^\s#]+)\s*$/);
    if (m) { tg = m[1]; body = body.replace(/\s*#[^\s#]+\s*$/, ''); }
    body = body.replace(/<[^>]*>/g, '').replace(/\*\*/g, '').replace(/^[-*+]\s*/, '').trim();
    if (!tg && !body) return null;
    return { t: norm(t), end: end ? norm(end) : null, title: body, tag: tg || guess(body) };
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

  function segsOf(list) {
    var now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
    return list.map(function (s, i) {
      var dur = null;
      if (s.end) { dur = toMin(s.end) - toMin(s.t); }
      else {
        var nx = list[i + 1];
        dur = nx ? (toMin(nx.t) - toMin(s.t)) : (nowMin - toMin(s.t));
      }
      if (dur !== null && dur <= 0) dur = null;
      if (dur !== null && !s.end && dur > 480) dur = null;
      return { t: s.t, end: s.end || (dur ? addMin(s.t, dur) : null), title: s.title || '（没写）', tag: s.tag || '其他', dur: dur };
    });
  }

  function render(list) {
    var el = document.getElementById('tlList');
    if (!el) return;
    var dn = document.getElementById('donut'), dt = document.getElementById('dnTotal'), lg = document.getElementById('dnLegend');
    var dayEl = document.getElementById('tlDate'), totEl = document.getElementById('tlTotal');
    var d = new Date();
    if (dayEl) dayEl.textContent = pad(d.getMonth() + 1) + '.' + pad(d.getDate());

    if (!list.length) {
      el.innerHTML = '<div class="tlEmpty">今天还没有记录。<br>点右上角「记一段」，或者让我按时间段写进来。</div>';
      if (dn) dn.style.background = '#f3f4f0';
      if (dt) dt.textContent = '0 min';
      if (totEl) totEl.textContent = '0 min';
      if (lg) lg.innerHTML = '';
      return;
    }

    var segs = segsOf(list);
    var total = 0, byTag = {}, order = [];
    segs.forEach(function (s) {
      if (s.dur === null) return;
      total += s.dur;
      if (!byTag[s.tag]) { byTag[s.tag] = 0; order.push(s.tag); }
      byTag[s.tag] += s.dur;
    });

    el.innerHTML = segs.map(function (s, i) {
      var sub = s.t + (s.end ? ('   –   ' + s.end) : '') + (s.dur ? ('   ·   ' + fmtDur(s.dur)) : '');
      return '<div class="tlRow">' +
        '<div class="tlTime">' + s.t + '</div>' +
        '<div class="tlRail"><i class="tlDot' + (s.dur ? ' on' : '') + '" style="' + (s.dur ? ('background:' + (TAGCOL[s.tag] || '#2c2c2c')) : '') + '"></i></div>' +
        '<div class="tlCard" style="background:' + (TINT[s.tag] || '#f4f4ef') + '"><h4>' + esc(s.title) + '</h4><p>' + esc(sub) + '</p></div>' +
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

  function readArticle(p) {
    return fetch('/api/article?path=' + encodeURIComponent(p)).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  function refresh() {
    readArticle('timeline/' + ymd() + '.md').then(function (j) {
      if (j && j.content && j.content.trim()) { render(parse(j.content)); return; }
      return readArticle('me/小记-' + ymd() + '.md').then(function (j2) { render(parse((j2 && j2.content) || '')); });
    });
  }

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
    readArticle('timeline/' + ymd() + '.md').then(function (j) {
      if (j && j.content != null) return appendTo('timeline/' + ymd() + '.md', hh + ' ' + txt, 'timeline', ymd() + '.md');
      return readArticle('me/小记-' + ymd() + '.md').then(function (j2) {
        var cur = (j2 && j2.content) || '';
        var nc = cur ? (cur.replace(/\s+$/, '') + '\n\n## ' + hh + '\n' + txt + '\n') : ('# 小记 ' + ymd() + '\n\n## ' + hh + '\n' + txt + '\n');
        return fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'me/小记-' + ymd() + '.md', content: nc }) });
      });
    }).then(function (r) { if (r && !r.ok) throw 0; refresh(); }).catch(function () {
      var i = document.getElementById('tlInput'); if (i) i.value = txt;
    });
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

  refresh();
})();
