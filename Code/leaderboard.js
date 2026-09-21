/* =============================================================================
   BAPPA'S HALL OF FAME  (leaderboard.js)
   New file. Adds a leaderboard around the existing game without editing it.

   How it connects (all from the outside):
   - Wraps NiatFlow.stage3Won   -> records the finished run on this device.
   - Wraps NiatFlow.showFinal   -> adds a "VIEW LEADERBOARD" button to the final screen.
   - Wraps NiatFlow.hideAll     -> closes the leaderboard if the game resets.
   - Reads NiatFlow.api.campuses / .run / .formatTime  (existing data, nothing duplicated).
   - Reads NiatFlow.api.supabase (the SAME config the game uses to save results).

   Data source:
   - GLOBAL: when the game's Supabase config (anonKey + table) is set, rankings are
     read from that same table. The game already inserts one row per completed run.
   - LOCAL:  otherwise rankings come from this browser's localStorage. That board is
     NOT shared between devices and is NOT tamper-proof. The UI says so.

   Official ranking (never changed by search or filters):
     1. higher score   2. lower total time   3. earlier completion time
   ============================================================================= */
(function () {
  'use strict';

  var NF = window.NiatFlow;
  if (!NF || !NF.api) { console.warn('[Leaderboard] NiatFlow not found. Leaderboard disabled.'); return; }

  var SCRIPT_URL = document.currentScript && document.currentScript.src;
  var CSS_URL = SCRIPT_URL ? new URL('leaderboard.css', SCRIPT_URL).href : 'leaderboard.css';

  var CFG = {
    storageKey: 'niat_leaderboard_local_v1',
    localCap: 500,          // max entries kept on this device
    fetchLimit: 1000,       // max rows requested per scope from Supabase
    pageSize: 50,           // rows rendered per "Show more"
    fetchTimeoutMs: 8000,
    waitForSaveMs: 6000     // wait for the game's own Supabase insert before reading
  };

  var $ = function (id) { return document.getElementById(id); };
  var reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  var fmtTime = function (s) { return NF.api.formatTime(s); };          // existing game formatter
  var campusLabel = function (c) { return c.city ? c.name + ' — ' + c.city : c.name; };   // same format the game stores

  /* ---------------------------------------------------------------------------
     VALIDATION: nothing malformed reaches the UI
     --------------------------------------------------------------------------- */
  function num(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return NaN;
    return Number(v);
  }
  function validateEntry(o) {
    if (!o || typeof o !== 'object') return null;
    var name = typeof o.name === 'string' ? o.name.replace(/\s+/g, ' ').trim() : '';
    if (!name || name.length > 40) return null;
    var campus = typeof o.campus === 'string' ? o.campus.replace(/\s+/g, ' ').trim() : '';
    if (!campus || campus.length > 160) return null;
    var score = num(o.score);
    if (!isFinite(score) || score < 0 || score > 1e6) return null;
    var time = num(o.time);
    if (!isFinite(time) || time < 0 || time > 86400) return null;
    var status = (o.status === undefined || o.status === null) ? 'completed' : o.status;
    if (status !== 'completed') return null;
    var t = typeof o.completedAt === 'number' ? o.completedAt : Date.parse(o.completedAt);
    return {
      id: typeof o.id === 'string' ? o.id : null,
      name: name, campus: campus,
      score: Math.round(score), time: Math.round(time),
      completedAt: isFinite(t) ? t : 0,
      status: 'completed'
    };
  }

  /* Official ranking rules. Array.sort is stable, so equal entries keep insertion order. */
  function sortEntries(list) {
    return list.slice().sort(function (a, b) {
      return (b.score - a.score) || (a.time - b.time) || (a.completedAt - b.completedAt);
    });
  }

  /* ---------------------------------------------------------------------------
     LOCAL STORE (this device only, not tamper-proof)
     --------------------------------------------------------------------------- */
  function readLocal() {
    try {
      var raw = localStorage.getItem(CFG.storageKey);
      if (!raw) return [];
      var j = JSON.parse(raw);
      if (!j || !Array.isArray(j.entries)) return [];
      return j.entries.map(validateEntry).filter(Boolean);
    } catch (e) { return []; }
  }
  function writeLocal(list) {
    try {
      var trimmed = sortEntries(list).slice(0, CFG.localCap).map(function (e) {
        return { id: e.id, name: e.name, campus: e.campus, score: e.score, time: e.time, status: 'completed', completedAt: new Date(e.completedAt).toISOString() };
      });
      localStorage.setItem(CFG.storageKey, JSON.stringify({ v: 1, entries: trimmed }));
    } catch (e) { /* storage full or blocked: the game keeps working */ }
  }

  /* ---------------------------------------------------------------------------
     REMOTE (Supabase REST, same config the game uses to save)
     --------------------------------------------------------------------------- */
  function remoteCfg() {
    var s = NF.api.supabase;
    return (s && s.url && s.anonKey && s.table) ? s : null;
  }
  function authHeaders(c) {
    var h = { apikey: c.anonKey };
    if (String(c.anonKey).indexOf('eyJ') === 0) h.Authorization = 'Bearer ' + c.anonKey;   // legacy JWT anon keys only
    return h;
  }
  function withTimeout(fn) {
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, CFG.fetchTimeoutMs);
    return fn(ctrl.signal).then(function (v) { clearTimeout(to); return v; }, function (e) { clearTimeout(to); throw e; });
  }
  function fetchRemote(scopeCampus) {
    var c = remoteCfg();
    var qs = 'select=player_name,campus,total_score,total_time,created_at'
           + '&total_score=not.is.null&total_time=not.is.null'
           + '&order=total_score.desc,total_time.asc,created_at.asc'
           + '&limit=' + CFG.fetchLimit;
    if (scopeCampus) qs += '&campus=eq.' + encodeURIComponent(scopeCampus);
    return withTimeout(function (signal) {
      return fetch(c.url + '/rest/v1/' + encodeURIComponent(c.table) + '?' + qs, { headers: authHeaders(c), signal: signal })
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(function (rows) {
          if (!Array.isArray(rows)) throw new Error('Unexpected response');
          var raw = rows.length;
          var list = rows.map(function (r) {
            return validateEntry({ name: r.player_name, campus: r.campus, score: r.total_score, time: r.total_time, completedAt: r.created_at });
          }).filter(Boolean);
          return { list: sortEntries(list), truncated: raw >= CFG.fetchLimit, dropped: raw - list.length };
        });
    });
  }
  /* Players ranked above `me`, used only when `me` is outside the fetched rows. */
  function fetchBetterCount(me, scopeCampus) {
    var c = remoteCfg();
    var qs = 'select=total_score&or=(total_score.gt.' + me.score + ',and(total_score.eq.' + me.score + ',total_time.lt.' + me.time + '))&limit=1';
    if (scopeCampus) qs += '&campus=eq.' + encodeURIComponent(scopeCampus);
    var h = authHeaders(c); h.Prefer = 'count=exact';
    return withTimeout(function (signal) {
      return fetch(c.url + '/rest/v1/' + encodeURIComponent(c.table) + '?' + qs, { headers: h, signal: signal }).then(function (res) {
        var m = /\/(\d+)$/.exec(res.headers.get('content-range') || '');
        return m ? parseInt(m[1], 10) : null;
      });
    });
  }

  /* ---------------------------------------------------------------------------
     SESSION: the player who just finished (from the game's own data)
     --------------------------------------------------------------------------- */
  var me = null;          // { id, name, campus, score, time, completedAt, runRef }
  var lastRun = null;

  function onRunCompleted() {
    var run = NF.api.run;
    if (!run || run === lastRun) return;
    var s = run.stages || {};
    var score = 0, time = 0;
    for (var n = 1; n <= 3; n++) {
      if (!s[n]) return;                                   // incomplete run: nothing to record
      score += s[n].score || 0;                            // existing per-stage values, summed like the final screen
      time += s[n].timeTaken || 0;
    }
    var entry = validateEntry({
      id: 'lb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name: run.player && run.player.name, campus: run.player && run.player.campus,
      score: score, time: time, completedAt: Date.now(), status: 'completed'
    });
    if (!entry) return;
    lastRun = run;
    entry.runRef = run;
    me = entry;
    var list = readLocal(); list.push(entry); writeLocal(list);
  }

  /* ---------------------------------------------------------------------------
     CSS + DOM (built lazily on first use)
     --------------------------------------------------------------------------- */
  var cssPromise = null;
  function ensureCss() {
    if (cssPromise) return cssPromise;
    cssPromise = new Promise(function (resolve) {
      var l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = CSS_URL;
      l.onload = l.onerror = function () { resolve(); };
      document.head.appendChild(l);
      setTimeout(resolve, 2500);
    });
    return cssPromise;
  }

  var built = false;
  function build() {
    if (built) return;
    built = true;
    var groups = '<option value="all">🌎 All Campuses</option>';
    NF.api.campuses.forEach(function (g) {
      groups += '<optgroup label="' + esc(g.state.toUpperCase()) + '">';
      g.campuses.forEach(function (c) { var l = campusLabel(c); groups += '<option value="' + esc(l) + '">' + esc(l) + '</option>'; });
      groups += '</optgroup>';
    });
    var el = document.createElement('div');
    el.className = 'overlay hidden';
    el.id = 'lb-overlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'lb-title');
    el.innerHTML =
      '<div class="lb-panel" id="lb-panel">' +
        '<button type="button" class="lb-close" id="lb-close" aria-label="Close leaderboard">×</button>' +
        '<header class="lb-head">' +
          '<p class="lb-kicker">GANPATI\'S JOURNEY</p>' +
          '<h2 class="lb-title" id="lb-title">🏆 Bappa\'s Hall of Fame</h2>' +
          '<p class="lb-sub">The journey doesn\'t end at the finish line.</p>' +
          '<div class="lb-mode" id="lb-mode"></div>' +
        '</header>' +
        '<div class="lb-controls">' +
          '<label class="lb-field lb-select"><span class="lb-sr">Filter by campus</span><select id="lb-campus">' + groups + '</select></label>' +
          '<label class="lb-field lb-search"><span class="lb-sr">Search player or campus</span><span class="lb-ico" aria-hidden="true">🔍</span>' +
            '<input id="lb-search" type="search" placeholder="Search player or campus..." autocomplete="off" spellcheck="false" maxlength="40"></label>' +
          '<button type="button" class="lb-refresh" id="lb-refresh" aria-label="Refresh leaderboard">↻</button>' +
        '</div>' +
        '<div class="lb-me" id="lb-me" hidden></div>' +
        '<div class="lb-scroll" id="lb-scroll" tabindex="-1">' +
          '<div class="lb-podium" id="lb-podium"></div>' +
          '<div class="lb-list" id="lb-list" role="table" aria-label="Leaderboard"></div>' +
          '<button type="button" class="lb-more" id="lb-more" hidden>SHOW MORE</button>' +
          '<div class="lb-state" id="lb-state" role="status" aria-live="polite"></div>' +
        '</div>' +
        '<footer class="lb-foot" id="lb-foot">' +
          '<p class="lb-note" id="lb-note"></p>' +
          '<div class="lb-actions">' +
            '<button type="button" class="niat-btn ghost lb-btn" id="lb-back">BACK TO RESULTS</button>' +
            '<button type="button" class="niat-btn primary lb-btn" id="lb-again">🎮 PLAY AGAIN</button>' +
          '</div>' +
        '</footer>' +
      '</div>';
    ($('app-container') || document.body).appendChild(el);

    $('lb-close').addEventListener('click', function () { closeLB(true); });
    $('lb-back').addEventListener('click', function () { closeLB(true); });
    $('lb-again').addEventListener('click', function () {
      closeLB(false);
      var again = $('btn-final-again');       // reuse the game's own PLAY AGAIN behaviour
      if (again) again.click();
    });
    $('lb-refresh').addEventListener('click', function () { load(true); });
    $('lb-campus').addEventListener('change', function () { state.scope = this.value; state.shown = CFG.pageSize; state.enter = true; load(false); });
    $('lb-search').addEventListener('input', function () { state.query = this.value; state.shown = CFG.pageSize; renderList(); renderMe(); });
    $('lb-search').addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); if (this.value) { this.value = ''; state.query = ''; state.shown = CFG.pageSize; renderList(); } else closeLB(true); } });
    $('lb-more').addEventListener('click', function () { state.shown += CFG.pageSize; renderList(); if ($('lb-more').hidden) $('lb-scroll').focus({ preventScroll: true }); });
    $('lb-me').addEventListener('click', function (e) { if (e.target.closest('#lb-findme')) findMe(); });
  }

  /* Escape / Tab handled at document level while open, so they work even if focus was lost. */
  function onDocKey(e) {
    if (!state.open) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLB(true); }
    else if (e.key === 'Tab') {
      if (!$('lb-panel').contains(document.activeElement)) { e.preventDefault(); $('lb-close').focus({ preventScroll: true }); }
      else trapFocus(e);
    }
  }

  function trapFocus(e) {
    var f = Array.prototype.filter.call($('lb-panel').querySelectorAll('button, select, input, [tabindex]:not([tabindex="-1"])'), function (n) { return !n.disabled && n.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ---------------------------------------------------------------------------
     STATE + LOADING
     --------------------------------------------------------------------------- */
  var state = { open: false, scope: 'all', query: '', shown: CFG.pageSize, rows: [], mode: 'local', remoteFailed: false,
                truncated: false, status: 'idle', meIdx: -1, meBeyond: null, mePending: false, token: 0, enter: true, fromFinal: true };

  function waitForOwnSave() {
    var run = me && me.runRef;
    if (!run || !remoteCfg()) return Promise.resolve();
    var t0 = Date.now();
    return new Promise(function (resolve) {
      (function poll() {
        if (run.saveState !== 'saving') return resolve();
        if (Date.now() - t0 > CFG.waitForSaveMs) return resolve();
        setTimeout(poll, 200);
      })();
    });
  }

  function findMine(rows) {
    if (!me) return -1;
    var best = -1, bd = Infinity;
    rows.forEach(function (e, i) {
      if (e.id && e.id === me.id) { best = i; bd = -1; }
      else if (bd >= 0 && e.name === me.name && e.campus === me.campus && e.score === me.score && e.time === me.time) {
        var d = Math.abs(e.completedAt - me.completedAt);
        if (d < bd) { bd = d; best = i; }
      }
    });
    return best;
  }

  function load(force) {
    var token = ++state.token;
    var firstLoad = state.enter;                       // entrance animation + auto-scroll only on the first load of a scope
    state.status = 'loading';
    render();
    var scopeCampus = state.scope === 'all' ? null : state.scope;
    var run = function () {
      if (remoteCfg()) {
        return waitForOwnSave().then(function () { return fetchRemote(scopeCampus); }).then(
          function (r) { state.mode = 'remote'; state.remoteFailed = false; return r; },
          function (err) { console.warn('[Leaderboard] Global board unreachable:', err); state.mode = 'local'; state.remoteFailed = true; return localScope(scopeCampus); });
      }
      state.mode = 'local'; state.remoteFailed = false;
      return Promise.resolve(localScope(scopeCampus));
    };
    run().then(function (r) {
      if (token !== state.token) return;
      var rows = r.list;
      state.truncated = !!r.truncated;
      state.mePending = false; state.meBeyond = null;
      var inScope = me && (!scopeCampus || scopeCampus === me.campus);
      var idx = inScope ? findMine(rows) : -1;
      if (inScope && idx < 0) {
        if (state.mode === 'remote' && state.truncated) {
          // Not in the rows we fetched: ask the server how many players are ahead of us.
          state.rows = rows; state.status = 'ready'; render();
          fetchBetterCount(me, scopeCampus).then(function (n) { if (token === state.token && n !== null) { state.meBeyond = n + 1; renderMe(); } }, function () {});
          return;
        }
        var mine = { id: me.id, name: me.name, campus: me.campus, score: me.score, time: me.time, completedAt: me.completedAt, status: 'completed', pending: true };
        rows = sortEntries(rows.concat([mine]));
        idx = rows.indexOf(mine);
        state.mePending = state.mode === 'remote';
      }
      state.rows = rows; state.meIdx = idx; state.status = 'ready';
      render();
      if (firstLoad && state.fromFinal && idx > 2 && !state.query) setTimeout(findMine_scrollOnly, reduceMotion ? 0 : 800);
    }).catch(function (e) { if (token !== state.token) return; console.warn('[Leaderboard]', e); state.status = 'error'; render(); });
  }
  function localScope(scopeCampus) {
    var list = sortEntries(readLocal());
    if (scopeCampus) list = list.filter(function (e) { return e.campus === scopeCampus; });
    return { list: list, truncated: false, dropped: 0 };
  }

  /* ---------------------------------------------------------------------------
     RENDER
     --------------------------------------------------------------------------- */
  function fmtDate(ms) {
    if (!ms) return '';
    try { return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function tokens() { return state.query.toLowerCase().split(/\s+/).filter(Boolean); }
  function matches(e, tk) { var h = (e.name + ' ' + e.campus).toLowerCase(); return tk.every(function (t) { return h.indexOf(t) !== -1; }); }
  var MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };

  function render() {
    renderMode();
    var loading = state.status === 'loading';
    $('lb-refresh').classList.toggle('spin', loading);
    if (loading) { renderSkeleton(); renderMe(); return; }
    if (state.status === 'error') { $('lb-podium').innerHTML = ''; $('lb-list').innerHTML = ''; $('lb-more').hidden = true;
      $('lb-state').innerHTML = '<p><b>Could not load the leaderboard.</b></p><button type="button" class="niat-btn ghost lb-btn" id="lb-retry">TRY AGAIN</button>';
      $('lb-retry').addEventListener('click', function () { load(true); }); renderMe(); return; }
    renderPodium();
    renderList();
    renderMe();
  }

  function renderMode() {
    var m = $('lb-mode'), n = $('lb-note');
    if (state.mode === 'remote') {
      m.className = 'lb-mode global';
      m.textContent = '🌐 Global leaderboard' + (state.status === 'ready' ? ' · ' + state.rows.length + (state.truncated ? '+' : '') + ' players' : '');
      n.textContent = '';
    } else if (state.remoteFailed) {
      m.className = 'lb-mode warn';
      m.textContent = '⚠ Global board unreachable. Showing this device only.';
      n.textContent = 'Results on this device are stored in this browser only and are not tamper-proof.';
    } else {
      m.className = 'lb-mode local';
      m.textContent = '📍 Local leaderboard · this device only' + (state.status === 'ready' ? ' · ' + state.rows.length + ' player' + (state.rows.length === 1 ? '' : 's') : '');
      n.textContent = 'Stored in this browser only. Not shared between devices and not tamper-proof.';
    }
  }

  function renderSkeleton() {
    $('lb-podium').innerHTML = '';
    $('lb-more').hidden = true;
    var s = '';
    for (var i = 0; i < 6; i++) s += '<div class="lb-skel"></div>';
    $('lb-list').innerHTML = s;
    $('lb-state').textContent = '';
  }

  function podiumCard(e, rank) {
    var cls = 'lb-pod p' + rank + (e && e === state.rows[state.meIdx] ? ' me' : '');
    if (!e) return '<article class="lb-pod p' + rank + ' empty"><div class="lb-medal">' + MEDAL[rank] + '</div><div class="lb-rank">#' + rank + '</div><div class="lb-pname">Open spot</div><div class="lb-pcampus">Be the next to finish</div></article>';
    return '<article class="' + cls + '"><div class="lb-medal" aria-hidden="true">' + MEDAL[rank] + '</div><div class="lb-rank">#' + rank + '</div>' +
      '<div class="lb-pname">' + esc(e.name) + (cls.indexOf(' me') > -1 ? ' <span class="lb-you">YOU</span>' : '') + '</div>' +
      '<div class="lb-pcampus">' + esc(e.campus) + '</div>' +
      '<div class="lb-pstats"><span class="lb-pscore" data-n="' + e.score + '">' + e.score + '</span><span class="lb-ptime">⏱ ' + fmtTime(e.time) + '</span></div></article>';
  }

  function renderPodium() {
    var p = $('lb-podium');
    if (!state.rows.length) { p.innerHTML = ''; p.hidden = true; return; }
    p.hidden = !!tokens().length;
    var html = '';
    for (var r = 1; r <= 3; r++) html += podiumCard(state.rows[r - 1], r);
    p.innerHTML = html;
    if (state.enter) p.classList.add('enter');
    if (!reduceMotion) Array.prototype.forEach.call(p.querySelectorAll('.lb-pscore'), function (el) { countUp(el, +el.dataset.n); });
  }

  function renderList() {
    var tk = tokens(), rows = state.rows;
    $('lb-podium').hidden = !rows.length || !!tk.length;
    var items = tk.length
      ? rows.map(function (e, i) { return { e: e, rank: i + 1 }; }).filter(function (x) { return matches(x.e, tk); })
      : rows.slice(3).map(function (e, i) { return { e: e, rank: i + 4 }; });     // official rank is never renumbered by search
    var list = $('lb-list'), st = $('lb-state');
    if (!rows.length) {
      list.innerHTML = ''; $('lb-more').hidden = true;
      st.innerHTML = '<p><b>No players on the board yet.</b></p><p>Finish the journey to claim the first spot.</p>';
      return;
    }
    if (!items.length) {
      list.innerHTML = ''; $('lb-more').hidden = true;
      st.innerHTML = tk.length ? '<p><b>No players found.</b></p><p>Try another name or campus.</p>' : '';
      return;
    }
    st.textContent = '';
    var shown = items.slice(0, state.shown);
    var html = '<div class="lb-row lb-headrow" role="row"><span>RANK</span><span>PLAYER</span><span>CAMPUS</span><span>SCORE</span><span>TIME</span><span>FINISHED</span></div>';
    var meRow = state.rows[state.meIdx];
    shown.forEach(function (x, i) {
      var e = x.e, mine = e === meRow;
      html += '<div class="lb-row' + (mine ? ' me' : '') + (x.rank <= 3 ? ' medal' : '') + '" role="row" style="--i:' + Math.min(i, 12) + '"' + (mine ? ' id="lb-me-row"' : '') + '>' +
        '<span class="lb-rk">' + (MEDAL[x.rank] || x.rank) + '</span>' +
        '<span class="lb-nm">' + esc(e.name) + (mine ? ' <span class="lb-you">YOU</span>' : '') + '</span>' +
        '<span class="lb-cp">' + esc(e.campus) + '</span>' +
        '<span class="lb-sc">' + e.score + '</span>' +
        '<span class="lb-tm">' + fmtTime(e.time) + '</span>' +
        '<span class="lb-dt">' + esc(fmtDate(e.completedAt)) + '</span></div>';
    });
    list.classList.toggle('enter', state.enter);
    list.classList.remove('fade');
    if (!state.enter) { void list.offsetWidth; list.classList.add('fade'); }     // quick fade on search / filter changes
    list.innerHTML = html;
    var more = $('lb-more');
    more.hidden = items.length <= state.shown;
    more.textContent = 'SHOW MORE (' + (items.length - state.shown) + ')';
    state.enter = false;
  }

  function renderMe() {
    var el = $('lb-me');
    var scopeCampus = state.scope === 'all' ? null : state.scope;
    var inScope = me && (!scopeCampus || scopeCampus === me.campus);
    var rank = state.meIdx >= 0 ? state.meIdx + 1 : state.meBeyond;
    if (!inScope || !rank || state.status !== 'ready') { el.hidden = true; return; }
    var sub = scopeCampus ? 'at ' + esc(scopeCampus) : 'overall';
    if (!scopeCampus && !state.truncated) {
      var cr = 0, seen = false;
      state.rows.forEach(function (e) { if (e.campus === me.campus && !seen) { cr++; if (state.rows[state.meIdx] === e) seen = true; } });
      if (seen) sub += ' · #' + cr + ' at ' + esc(me.campus);
    }
    var podium = rank <= 3 ? ' You are on the podium.' : '';
    var note = state.mePending ? '<small class="lb-warn">Your result is not on the global board yet (it may still be saving).</small>' : '';
    el.innerHTML = '<span class="lb-me-ico" aria-hidden="true">🎉</span><div class="lb-me-txt"><b>You finished at #' + rank + '</b>' +
      '<small>' + sub + (state.rows.length ? ' · of ' + state.rows.length + (state.truncated ? '+' : '') + ' players' : '') + '.' + podium + '</small>' + note + '</div>' +
      (state.meIdx >= 0 && rank > 3 ? '<button type="button" id="lb-findme" class="lb-find">FIND ME</button>' : '');
    el.hidden = false;
  }

  /* Scrolls only the leaderboard's own scroller (desktop: list area, phones: whole panel), never the game underneath. */
  function findMine_scrollOnly() {
    var row = $('lb-me-row');
    if (!row) return;
    var sc = getComputedStyle($('lb-scroll')).overflowY === 'auto' ? $('lb-scroll') : $('lb-panel');
    var rr = row.getBoundingClientRect(), sr = sc.getBoundingClientRect();
    var footer = sc === $('lb-panel') ? $('lb-foot').offsetHeight : 0;     // sticky footer covers the bottom on phones
    var top = sc.scrollTop + (rr.top - sr.top) - (sc.clientHeight - footer - rr.height) / 2;
    sc.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? 'auto' : 'smooth' });
  }
  function findMe() {
    if (state.query) { state.query = ''; $('lb-search').value = ''; }
    state.shown = Math.max(state.shown, state.meIdx + 1);
    renderList();
    findMine_scrollOnly();
  }

  function countUp(el, to) {
    if (to <= 0) return;
    el.textContent = '0';
    var d = 600, t0 = performance.now();
    (function step(t) {
      var p = Math.min(1, (t - t0) / d);
      el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }

  /* ---------------------------------------------------------------------------
     OPEN / CLOSE
     --------------------------------------------------------------------------- */
  function openLB() {
    if (state.open || state.opening) return;
    state.opening = true;
    ensureCss().then(function () {
      state.opening = false;
      build();
      state.open = true;
      state.scope = 'all'; state.query = ''; state.shown = CFG.pageSize; state.enter = true; state.meIdx = -1; state.meBeyond = null;
      $('lb-campus').value = 'all'; $('lb-search').value = '';
      var app = $('app-container'); if (app) { app.scrollLeft = 0; app.scrollTop = 0; }   // undo any stray programmatic scroll so the overlay is aligned
      document.addEventListener('keydown', onDocKey, true);
      var fin = $('final-overlay'); if (fin) fin.setAttribute('inert', '');
      $('lb-overlay').classList.remove('hidden');
      $('lb-close').focus({ preventScroll: true });
      load(false);
    });
  }
  function closeLB(refocus) {
    if (!built || !state.open) return;
    state.open = false;
    state.token++;                                     // cancel in-flight loads
    $('lb-overlay').classList.add('hidden');
    document.removeEventListener('keydown', onDocKey, true);
    var fin = $('final-overlay'); if (fin) fin.removeAttribute('inert');
    if (refocus) { var b = $('btn-final-leaderboard'); if (b) b.focus({ preventScroll: true }); }
  }

  /* ---------------------------------------------------------------------------
     HOOKS (wrap the game's own hooks from outside; originals always run first)
     --------------------------------------------------------------------------- */
  function injectButton() {
    var actions = document.querySelector('#final-overlay .result-actions');
    if (!actions || $('btn-final-leaderboard')) return;
    var b = document.createElement('button');
    b.type = 'button'; b.id = 'btn-final-leaderboard';
    b.className = 'niat-btn ghost lb-open-btn';
    b.innerHTML = '<span aria-hidden="true">🏆</span> VIEW LEADERBOARD';
    b.addEventListener('click', openLB);
    actions.insertBefore(b, actions.firstChild);
  }

  var origWon = NF.stage3Won, origFinal = NF.showFinal, origHide = NF.hideAll;
  NF.stage3Won = function () {
    var r = origWon.apply(this, arguments);
    try { onRunCompleted(); } catch (e) { console.warn('[Leaderboard]', e); }
    return r;
  };
  NF.showFinal = function () {
    var r = origFinal.apply(this, arguments);
    try { ensureCss().then(injectButton); } catch (e) { console.warn('[Leaderboard]', e); }
    return r;
  };
  NF.hideAll = function () {
    var r = origHide.apply(this, arguments);
    try { closeLB(false); } catch (e) { /* not built yet */ }
    return r;
  };

  window.NiatLeaderboard = { open: openLB, close: function () { closeLB(true); } };
})();
