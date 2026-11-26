/*
 * bridge.js —— 把「状态看板」和「小记」接进 Marlin
 * 数据面板 = /dashboard.html（iframe 覆盖在内容区）
 * 小记     = 追加写入 data/me/小记-YYYY-MM-DD.md，用 ## HH:MM 分段
 */
(function () {
  var d = document;
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var today = function () {
    var n = new Date();
    return n.getFullYear() + '-' + pad(n.getMonth() + 1) + '-' + pad(n.getDate());
  };
  var noteName = function () { return '小记-' + today() + '.md'; };
  var notePath = function () { return 'me/' + noteName(); };

  /* ---------------- 样式 ---------------- */
  var st = d.createElement('style');
  st.textContent = [
    '#kbStageWrap{position:fixed;left:264px;top:0;right:0;bottom:0;z-index:5;background:#fff;display:none}','@media(max-width:900px){#kbStageWrap{left:0;top:0}}',
    '#kbStageWrap{opacity:0;transition:opacity .22s ease,transform .22s cubic-bezier(.2,.8,.2,1);transform:translateY(4px)}','#kbStageWrap.on{display:block}','#kbStageWrap.vis{opacity:1;transform:none}',
    'body.kb-stage-on .topbar{display:none!important}',
    '#kbStageFrame{width:100%;height:100%;border:0;display:block;background:#fff}',
    '#kbNoteMask{position:fixed;inset:0;background:rgba(20,24,40,.42);backdrop-filter:blur(3px);z-index:100;display:none;align-items:center;justify-content:center}',
    '#kbNoteMask.on{display:flex}',
    '.kb-note-dlg{width:min(520px,92vw);background:#fff;border:1px solid var(--border,#e6e8f0);border-radius:16px;box-shadow:0 30px 90px rgba(16,20,40,.26);padding:22px 24px 18px}',
    '.kb-note-hd{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px;font-size:16px;font-weight:700;color:var(--text,#23283b)}',
    '.kb-note-day{font-size:11px;letter-spacing:.14em;font-weight:400;color:var(--text-3,#9aa1b2)}',
    '#kbNoteText{width:100%;min-height:132px;border:1px solid var(--border,#e6e8f0);border-radius:10px;padding:12px 14px;background:#fbfcff;font-family:inherit;font-size:14.5px;line-height:1.78;color:var(--text,#23283b);outline:none;resize:vertical}',
    '#kbNoteText:focus{border-color:var(--accent,#4f6ef7)}',
    '.kb-note-ft{display:flex;gap:10px;align-items:center;margin-top:14px}',
    '.kb-note-hint{flex:1;font-size:11.5px;color:var(--text-3,#9aa1b2)}',
    '.kb-btn-ghost{border:none;background:#f1f3fa;color:var(--text-2,#6b7280);border-radius:9px;padding:9px 16px;font-family:inherit;font-size:14px;cursor:pointer}',
    '.kb-btn-main{border:none;background:var(--accent,#4f6ef7);color:#fff;border-radius:9px;padding:9px 20px;font-family:inherit;font-size:14px;cursor:pointer;transition:background .15s}',
    '.kb-btn-main:hover{background:var(--accent-2,#7c5cf0)}',
    '.kb-toast{position:fixed;left:50%;bottom:34px;transform:translate(-50%,0);background:rgba(20,24,40,.92);color:#fff;font-size:13px;padding:10px 20px;border-radius:100px;z-index:200}',
    '.kb-toast.out{opacity:0;transition:opacity .4s}','#kbStageClose{position:fixed;right:20px;top:16px;z-index:6;width:34px;height:34px;border-radius:50%;border:1px solid #e3e6e1;background:#fff;color:#6b6b66;font-size:19px;line-height:32px;text-align:center;cursor:pointer;display:none;padding:0;box-shadow:0 1px 3px rgba(0,0,0,.05)}','body.kb-stage-on #kbStageClose{display:block}','#kbStageClose:hover{background:#2c2c2c;color:#fff;border-color:#2c2c2c}'
  ].join('\n');
  d.head.appendChild(st);

  /* ---------------- 状态看板容器 ---------------- */
  var wrap = d.createElement('div');
  wrap.id = 'kbStageWrap';
  var fr = d.createElement('iframe');
  fr.id = 'kbStageFrame';
  fr.src = '/dashboard.html?embed=1';
  fr.setAttribute('frameborder', '0');
  wrap.appendChild(fr);
  d.body.appendChild(wrap);

  var closeBtn = d.createElement("button");
  closeBtn.id = "kbStageClose";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "关闭看板");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", function () { closeStage(); });
  d.body.appendChild(closeBtn);



  function openStage() {
    d.body.classList.add('kb-stage-on');
    wrap.classList.add('on');
    requestAnimationFrame(function () { requestAnimationFrame(function () { wrap.classList.add('vis'); }); });
  }
  function closeStage() {
    wrap.classList.remove('vis');
    d.body.classList.remove('kb-stage-on');
    setTimeout(function () {
      if (!wrap.classList.contains('vis')) wrap.classList.remove('on');
    }, 240);
  }

  /* ---------------- 小记弹层 ---------------- */
  var mask = d.createElement('div');
  mask.id = 'kbNoteMask';
  mask.innerHTML =
    '<div class="kb-note-dlg" role="dialog" aria-label="小记">' +
      '<div class="kb-note-hd"><span>小记</span><span class="kb-note-day" id="kbNoteDay"></span></div>' +
      '<textarea id="kbNoteText" placeholder="今天想记一句什么？写完 Ctrl+Enter 直接存"></textarea>' +
      '<div class="kb-note-ft">' +
        '<span class="kb-note-hint">存进 me 分区 · Esc 关闭</span>' +
        '<button class="kb-btn-ghost" id="kbNoteCancel">取消</button>' +
        '<button class="kb-btn-main" id="kbNoteSave">保存</button>' +
      '</div>' +
    '</div>';
  d.body.appendChild(mask);

  function openNote() {
    mask.classList.add('on');
    var day = d.getElementById('kbNoteDay');
    if (day) day.textContent = today().slice(5).replace('-', '.');
    setTimeout(function () {
      var ta = d.getElementById('kbNoteText');
      if (ta) { ta.value = ''; ta.focus(); }
    }, 90);
  }
  function closeNote() { mask.classList.remove('on'); }

  function toast(msg) {
    var t = d.createElement('div');
    t.className = 'kb-toast';
    t.textContent = msg;
    d.body.appendChild(t);
    setTimeout(function () { t.classList.add('out'); }, 1800);
    setTimeout(function () { if (t.parentNode) t.remove(); }, 2400);
  }

  function saveNote() {
    var ta = d.getElementById('kbNoteText');
    var txt = (ta ? ta.value : '').trim();
    if (!txt) { toast('还没写东西'); return; }
    fetch('/api/article?path=' + encodeURIComponent(notePath()))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var cur = (j && j.content) || '';
        var n = new Date();
        var add = '## ' + pad(n.getHours()) + ':' + pad(n.getMinutes()) + '\n' + txt + '\n';
        var nc = cur ? (cur.replace(/\s+$/, '') + '\n\n' + add) : ('# 小记 ' + today() + '\n\n' + add);
        var req = cur
          ? fetch('/api/save', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: notePath(), content: nc })
            })
          : fetch('/api/upload', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ folder: 'me', name: noteName(), content: nc })
            });
        return req.then(function (res) {
          if (!res.ok) throw new Error('save failed');
          closeNote();
          toast('已存进 me/' + noteName());
          try { if (window.loadTree) window.loadTree(); } catch (e) {}
          try {
            if (fr && fr.contentWindow) fr.contentWindow.postMessage({ t: 'kb-note-saved' }, '*');
          } catch (e) {}
        });
      })
      .catch(function () { toast('写不进去，检查服务是否在跑'); });
  }

  /* ---------------- 事件 ---------------- */
  d.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('button,a') : null;
    if (t) {
      if (t.id === 'rbStatus' || t.id === 'btnStatus') {
        if (wrap.classList.contains('vis')) closeStage(); else openStage();
        return;
      }
      if (t.id === 'rbQuick' || t.id === 'btnQuick') { openNote(); return; }
      if (t.id === 'kbNoteSave') { saveNote(); return; }
      if (t.id === 'kbNoteCancel') { closeNote(); return; }
    }
    if (e.target === mask) { closeNote(); return; }
    if (e.target.closest && e.target.closest('#kbNoteMask')) return;
    if (e.target.closest && e.target.closest('#kbStageWrap')) return;
    if (wrap.classList.contains('on')) closeStage();
  });

  d.addEventListener('keydown', function (e) {
    if (mask.classList.contains('on')) {
      if (e.key === 'Escape') closeNote();
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') saveNote();
      return;
    }
    if (e.key === 'Escape' && wrap.classList.contains('on')) closeStage();
  });

  /* dashboard 里的「写一条」按钮发来的消息 */
  window.addEventListener('message', function (e) {
    if (e.data && e.data.t === 'kb-open-note') openNote();
  });
})();