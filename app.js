// TraceRight prototype: Login (with location), Lookup, Primary Pack, authorisation dialog
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var M = null;                    // masters
  var skuByPart = {};
  var current = null;              // visible view name
  var lookupScanner = null, packScanner = null, loginScanner = null;
  var PKG = { '1': 'Pipe Bundle', '2': 'Fittings Box', '3': 'Agri Pipe' };
  var LEVEL = { 1: 'Operator', 2: 'Supervisor', 3: 'Manager' };
  var lastAgain = null;

  function todayYYMMDD() {
    var d = new Date(); return String(d.getFullYear()).slice(2) + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
  }
  function msg(el, kind, html) { $(el).innerHTML = '<div class="msg ' + kind + '">' + html + '</div>'; }
  function me() { return TRApi.user(); }
  function here() { var u = me(); return (u && u.loc) || null; }
  function level() { var u = me(); return u ? Number(u.access) : 0; }

  // ------------------------------------------------------------ navigation
  function show(view) {
    document.querySelectorAll('main > section').forEach(function (sec) { sec.classList.toggle('hidden', sec.id !== 'v-' + view); });
    if (view !== 'lookup' && lookupScanner) lookupScanner.stop().then(function () { $('k-cam').textContent = 'Start camera'; });
    if (view !== 'pack' && packScanner) packScanner.stop().then(function () { $('p-cam').textContent = 'Start camera'; });
    if (view !== 'login' && loginScanner) loginScanner.stop().then(function () { $('l-cam').textContent = 'Scan location QR'; });
    window.dispatchEvent(new CustomEvent('tr-view', { detail: view }));
    current = view;
    var u = me(), l = here();
    $('who').innerHTML = u && l && view !== 'login' && view !== 'setup'
      ? esc(u.name) + ' · ' + esc(u.role) + '<br><b>' + esc(l.code) + '</b><br><button class="link" id="logout">Log out</button>' : '';
    var lo = $('logout'); if (lo) lo.onclick = function () { TRApi.logout(); start(); };
    $('title').textContent = { lookup: 'Lookup', pack: 'Primary Pack', done: 'Primary Pack', move: (window.TRMoveTitle || 'Transfer'),
      ret: 'Returns', unp: 'Unpack', rep: 'Repack', loc: 'Location Correction', inbox: 'Approvals', myreq: 'My requests',
      dash: 'Dashboard', result: 'Saved' }[view] || 'TraceRight';
    document.querySelectorAll('.card.here').forEach(function (c) {
      c.innerHTML = l ? 'You are at <b>' + esc(l.name) + '</b><div class="muted">Fixed for this login. To work elsewhere, log out and log in there.</div>' : '';
    });
    if (view === 'home') applyAccess();
    window.scrollTo(0, 0);
  }
  document.addEventListener('click', function (e) {
    var g = e.target.closest('[data-go]');
    if (!g) return;
    var v = g.getAttribute('data-go');
    if (v === 'pack') resetPack();
    if (v === 'lookup') $('k-out').innerHTML = '';
    window.dispatchEvent(new CustomEvent('tr-enter', { detail: { view: v, arg: g.getAttribute('data-arg') } }));
    show(v);
  });
  window.addEventListener('tr-auth-expired', function () { show('login'); msg('l-msg', 'warn', 'Session expired. Please log in again.'); });

  /** Home menu: by location type (machine / storage) and level. */
  function applyAccess() {
    var l = here(), lvl = level();
    document.querySelectorAll('#v-home [data-go], #v-home a.tile').forEach(function (t) {
      var at = t.getAttribute('data-at'), min = Number(t.getAttribute('data-min') || 0), need = Number(t.getAttribute('data-lvl') || 0);
      t.classList.toggle('hidden', !!(at && l && at !== l.type) || (min && lvl < min));
      var sm = t.querySelector('small');
      if (sm && need) {
        var badge = t.querySelector('.lvl');
        if (!badge) { badge = document.createElement('span'); badge.className = 'lvl' + (need === 3 ? ' l3' : ''); t.insertBefore(badge, sm); }
        badge.textContent = lvl >= need ? LEVEL[need] : 'needs ' + LEVEL[need];
      }
    });
    if (l) $('home-loc').innerHTML = 'Logged in at <b>' + esc(l.name) + '</b> (' + (l.type === 'M' ? 'machine' : 'storage location') + ')';
    if (lvl >= 2) TRApi.call('inbox', {}).then(function (r) {
      if (r.ok) $('inbox-count').textContent = r.pending.length ? r.pending.length + ' waiting for you' : 'Nothing waiting';
    }).catch(function () {});
  }

  // ------------------------------------------------------------ start / login
  function loadMasters() {
    return TRApi.call('masters').then(function (res) {
      if (!res.ok) throw new Error(res.error);
      M = res; skuByPart = {};
      res.skus.forEach(function (s) { skuByPart[s.ERP_Part] = s; });
      return res;
    });
  }

  function start() {
    if (!(window.TR_CONFIG || {}).API_URL) { show('setup'); return; }
    var u = me();
    if (u && !u.loc) { TRApi.logout(); u = null; }          // login from an older version: needs a location now
    show(u ? 'home' : 'login');
    $('l-user').innerHTML = '<option value="">Loading users…</option>';
    loadMasters().then(function (res) {
      $('l-user').innerHTML = '<option value="">Select your name</option>' + res.users.map(function (x) {
        return '<option value="' + esc(x.code) + '">' + esc(x.name) + ' (' + esc(x.role) + ')</option>';
      }).join('');
      fillFactories();
      $('home-info').textContent = 'Connected. Server date ' + res.serverDate + '. Backend ' + (res.version || '') + '. Pipes per bundle: ' + res.pipeBundleQty + '.';
      if (current === 'home') applyAccess();
    }).catch(function (e) {
      $('l-user').innerHTML = '<option value="">Could not load users</option>';
      msg('l-msg', 'bad', esc(e.message));
      $('home-info').textContent = e.message;
    });
  }

  function remembered() { try { return localStorage.getItem('tr_login_loc') || ''; } catch (e) { return ''; } }
  function fillFactories() {
    var ftys = {};
    M.machines.forEach(function (m) { ftys[m.FTY_Code] = 1; });
    M.warehouses.forEach(function (w) { if (w.FTY_Code) ftys[w.FTY_Code] = 1; });
    $('l-fty').innerHTML = Object.keys(ftys).sort().map(function (f) {
      var wip = M.warehouses.filter(function (w) { return w.FTY_Code === f; })[0];
      return '<option value="' + esc(f) + '">Factory ' + esc(f) + (wip ? ' · ' + esc(wip.City) : '') + '</option>';
    }).join('') + '<option value="0">0 · Not in a factory (depot, yard elsewhere)</option>';
    var r = remembered().split('|');
    if (r[2]) $('l-fty').value = r[2];
    fillWhere(r[0] && r[1] ? r[0] + '|' + r[1] : '');
  }
  function fillWhere(sel) {
    var f = $('l-fty').value, h = '<option value="">Select</option>';
    if (f !== '0') {
      h += '<optgroup label="Machines">' + M.machines.filter(function (m) { return m.FTY_Code === f; }).map(function (m) {
        return '<option value="M|' + esc(m.MAC_Name) + '">' + esc(m.MAC_Name + ' · ' + m.MAC_Type) + '</option>';
      }).join('') + '</optgroup>';
    }
    h += '<optgroup label="Storage locations">' + M.warehouses.map(function (w) {
      return '<option value="S|' + esc(w.WHS_Code) + '">' + esc(w.WHS_Code + ' · ' + w.WHS_Name) + '</option>';
    }).join('') + '</optgroup>';
    $('l-where').innerHTML = h;
    if (sel) $('l-where').value = sel;
    if ($('l-where').selectedIndex < 0) $('l-where').value = '';
  }
  $('l-fty').onchange = function () { fillWhere(''); };

  function onLocQR(code) {
    var p = TR.parseLoc(code);
    if (!p || p.type === 'C') { TRBeep('bad'); return msg('l-msg', 'bad', 'That is not a location QR. Scan the location QR posted at the machine or storage location.'); }
    if (p.type === 'M') { $('l-fty').value = p.fty; fillWhere('M|' + p.code); }
    else {
      var w = (M.warehouses || []).filter(function (x) { return ('0' + x.Loc_No).slice(-2) === p.locNo; })[0];
      if (!w) { TRBeep('bad'); return msg('l-msg', 'bad', 'Location ' + esc(p.locNo) + ' is not in WHS_Master.'); }
      if (w.FTY_Code) $('l-fty').value = w.FTY_Code;
      fillWhere('S|' + w.WHS_Code);
    }
    if (!$('l-where').value) { TRBeep('bad'); return msg('l-msg', 'bad', 'Location not found in the masters.'); }
    TRBeep('ok');
    msg('l-msg', 'ok', 'Location: <b>' + esc($('l-where').selectedOptions[0].textContent) + '</b>');
    if (loginScanner) loginScanner.stop().then(function () { $('l-cam').textContent = 'Scan location QR'; });
  }

  $('l-go').onclick = function () {
    var usr = $('l-user').value, pin = $('l-pin').value.trim(), w = $('l-where').value;
    if (!usr) return msg('l-msg', 'warn', 'Select your name.');
    if (!pin) return msg('l-msg', 'warn', 'Enter your PIN.');
    if (!w) return msg('l-msg', 'warn', 'Choose where you are, or scan the location QR.');
    var parts = w.split('|');
    $('l-go').disabled = true; msg('l-msg', 'info', 'Checking…');
    TRApi.call('login', { usr: usr, pin: pin, loc: { type: parts[0], code: parts[1] } }).then(function (res) {
      $('l-go').disabled = false;
      if (!res.ok) return msg('l-msg', 'bad', esc(res.error));
      TRApi.saveLogin(res); $('l-pin').value = ''; $('l-msg').innerHTML = '';
      try { localStorage.setItem('tr_login_loc', w + '|' + $('l-fty').value); } catch (e) {}
      show('home');
    }).catch(function (e) { $('l-go').disabled = false; msg('l-msg', 'bad', esc(e.message)); });
  };
  $('l-pin').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('l-go').click(); });

  // ------------------------------------------------------------ camera buttons
  function camButton(btnId, readerId, getScanner, setScanner, onCode, idleText) {
    idleText = idleText || 'Start camera';
    $(btnId).onclick = function () {
      var s = getScanner();
      if (!s) { s = new TRScanner(readerId, onCode); setScanner(s); }
      if (s.running) { s.stop().then(function () { $(btnId).textContent = idleText; }); return; }
      $(btnId).textContent = 'Starting…';
      s.start().then(function () { $(btnId).textContent = 'Stop camera'; })
        .catch(function (e) { $(btnId).textContent = idleText; alert('Camera could not start: ' + e); });
    };
  }
  camButton('l-cam', 'l-reader', function () { return loginScanner; }, function (s) { loginScanner = s; }, onLocQR, 'Scan location QR');

  // ------------------------------------------------------------ authorisation
  /**
   * Calls a stock action. If the server says it needs a reason or a higher level,
   * opens the dialog: reason + approver PIN on this phone, or send for approval.
   * Resolves with the final server reply, { requested: true } or { cancelled: true }.
   */
  function authCall(action, body, timeout) {
    return TRApi.call(action, body, timeout).then(function (r) {
      if (r.ok || !(r.needAuth || r.needReason)) return r;
      return authDialog(action, body, r, timeout);
    });
  }
  function authDialog(action, body, r, timeout) {
    return new Promise(function (resolve) {
      var need = r.need || 2;
      var remoteOnly = !!r.needAuth;
      $('au-title').textContent = r.needAuth ? 'Level ' + need + ' (' + LEVEL[need] + ') authorisation needed' : 'Reason needed';
      $('au-why').innerHTML = '<div class="msg ' + (r.needAuth ? 'warn' : 'info') + '">' + (r.why || []).map(esc).join('<br>') +
        ((r.warnings || []).length ? '<br><span class="muted">' + r.warnings.map(esc).join('<br>') + '</span>' : '') + '</div>';
      $('au-reason').value = body.reason || '';
      $('au-pin').value = '';
      $('au-msg').innerHTML = '';
      $('au-appr').classList.toggle('hidden', !remoteOnly);
      $('au-ok').classList.toggle('hidden', remoteOnly);
      if (remoteOnly) {
        var u = me();
        var appr = ((M && M.users) || []).filter(function (x) { return Number(x.access) >= need && x.code !== u.code; });
        $('au-usr').innerHTML = '<option value="">Select ' + LEVEL[need].toLowerCase() + '</option>' + appr.map(function (x) {
          return '<option value="' + esc(x.code) + '">' + esc(x.name + ' (' + x.role + ')') + '</option>';
        }).join('');
        $('au-dev').textContent = 'Level ' + need + ' Authorisation';
        $('au-dev-h').textContent = 'Approver on this phone (' + LEVEL[need] + ' or above)';
      }
      $('auth').classList.remove('hidden');
      $('au-reason').focus();

      function close(res) {
        $('au-pin').value = '';
        $('auth').classList.add('hidden');
        ['au-dev', 'au-ok', 'au-remote', 'au-cancel'].forEach(function (id) { $(id).onclick = null; $(id).disabled = false; });
        resolve(res);
      }
      function reason() {
        var t = $('au-reason').value.trim();
        if (!t) { msg('au-msg', 'warn', 'Enter the reason.'); $('au-reason').focus(); }
        return t;
      }
      function busy(on) { ['au-dev', 'au-ok', 'au-remote'].forEach(function (id) { $(id).disabled = on; }); }
      function retry(extra) {
        busy(true); msg('au-msg', 'info', 'Saving…');
        TRApi.call(action, Object.assign({}, body, extra), timeout).then(function (res) {
          busy(false); $('au-pin').value = '';
          if (res.ok) return close(res);
          if (res.needAuth || res.needReason) { TRBeep('bad'); return msg('au-msg', 'bad', esc(res.authError || res.error).replace(/\n/g, '<br>')); }
          close(res);
        }).catch(function (e) { busy(false); msg('au-msg', 'bad', esc(e.message) + '<br>Try again; it will not be saved twice.'); });
      }
      $('au-ok').onclick = function () { var t = reason(); if (t) retry({ reason: t }); };
      $('au-dev').onclick = function () {
        var t = reason(); if (!t) return;
        if (!$('au-usr').value) return msg('au-msg', 'warn', 'Select the approver.');
        if (!$('au-pin').value.trim()) return msg('au-msg', 'warn', 'The approver enters their PIN.');
        retry({ reason: t, auth: { usr: $('au-usr').value, pin: $('au-pin').value.trim() } });
      };
      $('au-remote').onclick = function () {
        var t = reason(); if (!t) return;
        busy(true); msg('au-msg', 'info', 'Sending…');
        TRApi.call('authRequest', { forAction: action, payload: body, reason: t }).then(function (res) {
          busy(false);
          if (!res.ok) return msg('au-msg', 'bad', esc(res.error).replace(/\n/g, '<br>'));
          close({ ok: false, requested: true, reqId: res.reqId, need: res.need, needName: res.needName, summary: res.summary });
        }).catch(function (e) { busy(false); msg('au-msg', 'bad', esc(e.message)); });
      };
      $('au-cancel').onclick = function () { close({ ok: false, cancelled: true, error: 'Not saved: authorisation cancelled.' }); };
    });
  }

  function showResult(html, again) { $('rs-out').innerHTML = html; lastAgain = again; show('result'); }
  $('rs-again').onclick = function () { if (lastAgain) lastAgain(); };
  function showRequested(r, again) {
    TRBeep('ok');
    showResult('<div class="msg ok"><b>Request ' + esc(r.reqId) + ' sent</b></div><div class="card">' + kv([['Waiting for', 'Level ' + esc(r.need) + ' · ' + esc(r.needName)],
      ['Request', esc(r.summary)]]) + '</div><div class="msg info">Nothing is saved yet. A ' + esc(String(r.needName).toLowerCase()) +
      ' approves it from their Approvals inbox; you will see the result under <b>My requests</b>.</div>', again);
  }
  /** Shared handling of a reply that was not saved. Returns true when handled. */
  function notSaved(r, el, again) {
    if (r.requested) { showRequested(r, again); return true; }
    if (r.cancelled) { TRBeep('warn'); msg(el, 'warn', esc(r.error)); return true; }
    return false;
  }

  // ------------------------------------------------------------ Lookup
  camButton('k-cam', 'k-reader', function () { return lookupScanner; }, function (s) { lookupScanner = s; }, doLookup);
  $('k-manual-go').onclick = function () { var v = $('k-manual').value.trim(); if (v) doLookup(v); };

  function doLookup(code) {
    var lq = TR.parseLoc(code);
    if (lq) { TRBeep('ok'); return msg('k-out', 'info', '<b>Location QR</b> · ' + esc(lq.code || ('storage location ' + lq.locNo)) + '<br><span class="mono">' + esc(code) + '</span><br>Used at login to declare where you are.'); }
    var p = TR.parseQR(code);
    TRBeep(p.ok ? 'ok' : 'bad');
    if (!p.ok) { msg('k-out', 'bad', '<b>Not a valid TraceRight code</b><br><span class="mono">' + esc(code) + '</span><br>' + esc(p.errors.join('; '))); return; }
    msg('k-out', 'info', 'Looking up <span class="mono">' + esc(code) + '</span>…');
    TRApi.call('lookup', { code: code }).then(function (r) {
      if (!r.ok) return msg('k-out', 'bad', esc(r.error));
      $('k-out').innerHTML = renderLookup(r, p);
    }).catch(function (e) { msg('k-out', 'bad', esc(e.message)); });
  }

  function kv(rows) {
    return '<table class="kv">' + rows.filter(function (r) { return r[1] !== undefined && r[1] !== ''; })
      .map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + r[1] + '</td></tr>'; }).join('') + '</table>';
  }
  function userName(c) { var u = ((M && M.users) || []).filter(function (x) { return x.code === c; })[0]; return u ? u.name : c; }
  function timeline(events, newestFirst) {
    if (!events || !events.length) return '<p class="muted">No events yet.</p>';
    events.sort(function (a, b) { return (a.When === b.When ? (+a.EVT_ID - +b.EVT_ID) : (a.When > b.When ? 1 : -1)) * (newestFirst ? -1 : 1); });
    return '<div class="timeline">' + events.map(function (e) {
      var path = e.From_Where === e.To_Where ? esc(e.To_Where) : esc(e.From_Where) + ' → ' + esc(e.To_Where);
      var flag = e.Event === 'Location Corrected' || e.Auth_By || /not today|recorded at|logged in at/.test(e.Reason || '');
      return '<div class="ev"><b>' + esc(e.Event) + ' · ' + path + '</b><span class="muted">' + esc(e.When) +
        ' · qty ' + esc(e.Item_Qty) + ' · ' + esc(e.USR_Code) + (e.Auth_By ? ' · authorised by ' + esc(userName(e.Auth_By)) + (e.Auth_Ref ? ' (' + esc(e.Auth_Ref) + ')' : '') : '') +
        ' · EVT ' + esc(e.EVT_ID) + '</span>' +
        (e.Reason ? '<div class="muted">' + (flag ? '⚠ ' : '↳ ') + esc(e.Reason) + '</div>' : '') + '</div>';
    }).join('') + '</div>';
  }
  function skuLine(sku, part) { return sku ? esc(sku.SKU_Code) + ' · ' + esc(sku.SKU_Description) : 'Part ' + esc(part) + ' (not in SKU master)'; }

  function renderLookup(r, p) {
    var h = '';
    if (!r.found) {
      h += '<div class="msg warn"><b>' + esc(TR.kindLabel(p.kind)) + ' not in the system yet</b><br><span class="mono">' + esc(r.code) + '</span></div>';
      if (r.label) h += '<div class="card">' + kv([['Demo label', esc(r.label.Label_Type)], ['Printed', esc(r.label.Printed_At) + ' by ' + esc(r.label.Printed_By)],
        ['Batch', esc(r.label.Print_Batch)], ['Position', esc(r.label.Sheet_Row)], ['Status', esc(r.label.Status)]]) + '</div>';
      h += '<div class="card"><h2>Decoded</h2>' + kv(Object.keys(p.fields).map(function (k) { return [k, esc(p.fields[k])]; })) +
        (r.sku ? '<p class="muted">' + skuLine(r.sku) + '</p>' : '') + '</div>';
      return h;
    }
    if (r.pipe) {
      var active = (r.memberships || []).filter(function (m) { return m.Status === 'Active'; })[0];
      h += '<div class="msg ok"><b>Pipe</b> · ' + skuLine(r.sku, r.pipe.ERP_Part) + '</div>';
      h += '<div class="card">' + kv([['Pipe QR', '<span class="mono">' + esc(r.pipe.PIP_QR24) + '</span>'], ['Produced', esc(r.pipe.Prod_Date) + ' · MAC-' + esc(r.pipe.FTY_Code) + '-' + esc(r.pipe.MAC_Code)],
        ['Side / serial', esc(r.pipe.Side) + ' / ' + esc(r.pipe.Serial_No)], ['Bundled at', esc(r.pipe.Created_At) + ' by ' + esc(r.pipe.Created_By)],
        ['Current bundle', active ? '<span class="mono">' + esc(active.BUN_QR24) + '</span>' : '<span class="tag pend">Loose (no active bundle)</span>'],
        ['Bundle status', r.currentPackage ? esc(r.currentPackage.Current_Status) + ' · ' + esc(r.currentPackage.Current_Where) : '']]) + '</div>';
      h += '<div class="card"><h2>Bundle memberships</h2><ul class="list">' + (r.memberships || []).map(function (m) {
        return '<li><span class="mono">' + esc(m.BUN_QR24) + '</span><span>' + esc(m.From_Event) + ' ' + esc(m.From_When) +
          (m.To_When ? ' → ' + esc(m.To_Event) + ' ' + esc(m.To_When) : '') + ' <span class="tag ' + (m.Status === 'Active' ? 'ok' : '') + '">' + esc(m.Status) + '</span></span></li>';
      }).join('') + '</ul></div>';
      if (r.events) h += '<div class="card"><h2>Bundle timeline</h2>' + timeline(r.events) + '</div>';
      return h;
    }
    var k = r.package;
    h += '<div class="msg ok"><b>' + esc(k.PKG_Type.replace(/^\d = /, '')) + '</b> · ' + skuLine(r.sku, '') + '</div>';
    h += '<div class="card">' + kv([['QR-24', '<span class="mono">' + esc(k.BUN_QR24) + '</span>'], ['QR-15', k.BUN_QR15 ? '<span class="mono">' + esc(k.BUN_QR15) + '</span>' : '<span class="muted">none</span>'],
      ['Status', '<b>' + esc(k.Current_Status) + '</b> · ' + esc(k.Current_Where)], ['Quantity', esc(k.Current_Qty) + ' (packed ' + esc(k.Packed_Qty) + ')'],
      ['Origin', esc(k.Origin_Event) + ' · ' + esc(k.Origin_Date)], ['Last event', esc(k.Last_Event_When)]]) + '</div>';
    h += '<div class="card"><h2>Timeline</h2>' + timeline(r.events) + '</div>';
    if (r.pipes && r.pipes.length) {
      h += '<div class="card"><h2>Pipes (' + r.pipes.length + ')</h2><ul class="list">' + r.pipes.map(function (m, i) {
        return '<li><span class="mono">' + (i + 1) + '. ' + esc(m.PIP_QR24) + '</span><span class="tag ' + (m.Status === 'Active' ? 'ok' : '') + '">' + esc(m.Status) + '</span></li>';
      }).join('') + '</ul></div>';
    }
    return h;
  }

  // ------------------------------------------------------------ Primary Pack (logged in at a machine)
  var st;
  function resetPack() {
    st = { mode: null, pipes: [], bun24: null, bun15: null, sku: null, history: [], uuid: TRApi.uuid() };
    $('p-msg').innerHTML = ''; renderPack();
    if (packScanner) packScanner.forget();
  }
  function target() { return (M && M.pipeBundleQty) || 6; }
  function labelMachine(code) { return 'MAC-' + code[6] + '-' + code.slice(7, 9); }

  camButton('p-cam', 'p-reader', function () { return packScanner; }, function (s) { packScanner = s; }, packScan);
  $('p-manual-go').onclick = function () { var v = $('p-manual').value.trim(); if (v) { $('p-manual').value = ''; packScan(v); } };

  function fail(t) { TRBeep('bad'); msg('p-msg', 'bad', t); }
  function good(t) { TRBeep('ok'); msg('p-msg', 'ok', t); }

  function checkUnused(item, role, label) {
    item.status = 'pend'; renderPack();
    TRApi.call('checkCode', { code: item.code, role: role }).then(function (r) {
      if (!r.ok) { item.status = 'bad'; item.note = r.error; }
      else if (r.used) {
        item.status = 'bad'; item.note = 'Already used';
        fail('<b>' + label + ' already used.</b> This code is in the system already. It has been removed; scan a different one.');
        removeItem(item);
      } else item.status = 'ok';
      renderPack();
    }).catch(function (e) { item.status = 'bad'; item.note = e.message; renderPack(); msg('p-msg', 'bad', esc(e.message)); });
  }
  function removeItem(item) {
    var i = st.pipes.indexOf(item);
    if (i >= 0) st.pipes.splice(i, 1);
    if (st.bun24 === item) st.bun24 = null;
    if (st.bun15 === item) st.bun15 = null;
    if (!st.pipes.length && !st.bun24) { st.mode = null; st.sku = null; }
    st.history = st.history.filter(function (h) { return h !== item; });
  }

  function packScan(code) {
    var p = TR.parseQR(code);
    if (!p.ok) return fail('<b>Not a valid TraceRight code.</b><br><span class="mono">' + esc(code) + '</span><br>' + esc(p.errors.join('; ')));
    var part = code.slice(9, 17), oldDate = /^\d{24}$/.test(code) && code.slice(0, 6) !== todayYYMMDD();
    var dateNote = oldDate ? ' <span class="tag pend">label dated ' + esc(p.fields.Date) + '</span>' : '';
    var l = here();
    var macNote = /^\d{24}$/.test(code) && l && labelMachine(code) !== l.code
      ? ' <span class="tag pend">label is for ' + esc(labelMachine(code)) + (level() < 2 ? ' · needs supervisor' : ' · reason needed') + '</span>' : '';

    if (p.kind === 'PIPE_QR24') {
      if (st.mode === 'box') return fail('This package is a ' + esc(PKG[st.bun24.code[23]]) + '. It takes no pipe scans.');
      if (st.bun24) return fail('Bundle label already scanned. Pipes are scanned before the bundle label.');
      if (st.pipes.some(function (x) { return x.code === code; })) { TRBeep('warn'); return msg('p-msg', 'warn', 'This pipe is already in the list.'); }
      if (st.pipes.length >= target()) return fail('The bundle already has ' + target() + ' pipes. Scan the bundle label QR-24 next.');
      var sku = skuByPart[part];
      if (!sku) return fail('SKU part ' + esc(part) + ' is not in SKU_Master.');
      if (sku.SKU_Category !== 'Pipe') return fail(esc(sku.SKU_Code) + ' is a ' + esc(sku.SKU_Category) + ' SKU, not a pipe.');
      if (st.sku && st.sku.ERP_Part !== part) return fail('<b>Different SKU.</b> This pipe is ' + esc(sku.SKU_Code) + '; the bundle is ' + esc(st.sku.SKU_Code) + '.');
      st.mode = 'pipe'; st.sku = sku;
      var it = { code: code, status: 'pend', old: oldDate };
      st.pipes.push(it); st.history.push(it);
      good('Pipe ' + st.pipes.length + ' of ' + target() + ' · ' + esc(sku.SKU_Code) + dateNote);
      checkUnused(it, 'pipe', 'Pipe');
      return;
    }

    if (p.kind === 'BUNDLE_QR24') {
      var chk = code[23], qty = +code.slice(21, 23), s2 = skuByPart[part];
      if (st.bun24) return fail('A QR-24 label is already scanned for this package.');
      if (code[6] === '0') return fail('<b>This is a repack label</b> (factory digit 0). Use Repack at a storage location.');
      if (!s2) return fail('SKU part ' + esc(part) + ' is not in SKU_Master.');
      if (String(s2.PKG_Check) !== chk) return fail('Check digit ' + chk + ' does not match ' + esc(s2.SKU_Code) + ' (' + esc(s2.SKU_Category) + ').');
      if (chk === '1') {
        if (st.mode !== 'pipe' || st.pipes.length < target()) return fail('<b>Scan the ' + target() + ' pipes first</b>, then the bundle label. (' + st.pipes.length + ' scanned)');
        if (st.pipes.some(function (x) { return x.status !== 'ok'; })) return fail('Wait until every pipe shows a green tick.');
        if (part !== st.sku.ERP_Part) return fail('<b>Wrong bundle label.</b> Label is ' + esc(s2.SKU_Code) + '; pipes are ' + esc(st.sku.SKU_Code) + '.');
        if (qty !== target()) return fail('Bundle label quantity is ' + ('0' + qty).slice(-2) + '; it should be ' + ('0' + target()).slice(-2) + '.');
      } else {
        if (st.mode === 'pipe') return fail('This is a ' + PKG[chk] + ' label. Finish or cancel the pipe bundle first.');
        if (chk === '3' && qty !== 1) return fail('Agri Pipe quantity must be 01.');
        st.mode = 'box'; st.sku = s2;
      }
      st.bun24 = { code: code, status: 'pend', old: oldDate }; st.history.push(st.bun24);
      good(esc(PKG[chk]) + ' label QR-24 · ' + esc(s2.SKU_Code) + ' · qty ' + qty + dateNote + macNote);
      checkUnused(st.bun24, 'bun24', 'Package label QR-24');
      return;
    }

    if (p.kind === 'BUNDLE_QR15') {
      if (!st.bun24) return fail('Scan the QR-24 label before the QR-15.');
      if (st.bun15) return fail('QR-15 already scanned for this package.');
      st.bun15 = { code: code, status: 'pend' }; st.history.push(st.bun15);
      good('QR-15 scanned.');
      checkUnused(st.bun15, 'bun15', 'QR-15');
    }
  }

  function tag(it) {
    if (!it) return '<span class="tag">waiting</span>';
    return { ok: '<span class="tag ok">✓ new</span>', pend: '<span class="tag pend">checking…</span>', bad: '<span class="tag bad">✗ ' + esc(it.note || '') + '</span>' }[it.status];
  }

  function readyToClose() {
    if (st.mode === 'pipe') return st.pipes.length === target() && st.pipes.every(function (x) { return x.status === 'ok'; }) &&
      st.bun24 && st.bun24.status === 'ok' && st.bun15 && st.bun15.status === 'ok';
    if (st.mode === 'box') return st.bun24 && st.bun24.status === 'ok' && (!st.bun15 || st.bun15.status === 'ok');
    return false;
  }

  function renderPack() {
    var h = '';
    if (!st.mode) {
      h += '<h2>Start with the first scan</h2><p class="muted">Pipe bundle: scan the ' + target() + ' pipes, then the bundle QR-24, then the QR-15.<br>' +
        'Fittings box or Agri pipe: scan its QR-24; QR-15 is optional.<br>Closed packages go to the factory\'s WIP Store.</p>';
    } else if (st.mode === 'pipe') {
      var n = st.pipes.length, T = target();
      h += '<div class="steps"><span class="' + (n === T ? 'done' : 'now') + '">Pipes ' + n + '/' + T + '</span>' +
        '<span class="' + (st.bun24 ? 'done' : n === T ? 'now' : '') + '">QR-24</span>' +
        '<span class="' + (st.bun15 ? 'done' : st.bun24 ? 'now' : '') + '">QR-15</span>' +
        '<span class="' + (readyToClose() ? 'now' : '') + '">Close</span></div>';
      h += '<div class="counter">' + n + ' / ' + T + ' pipes</div><div class="muted">' + esc(st.sku.SKU_Code) + ' · ' + esc(st.sku.SKU_Description) + '</div>';
      h += '<ul class="list">' + st.pipes.map(function (x, i) {
        return '<li><span class="mono">' + (i + 1) + '. ' + esc(x.code) + '</span>' + tag(x) + '</li>';
      }).join('') + '</ul>';
      h += '<ul class="list"><li><span>Bundle QR-24 ' + (st.bun24 ? '<span class="mono">' + esc(st.bun24.code) + '</span>' : '') + '</span>' + tag(st.bun24) + '</li>' +
        '<li><span>QR-15 (mandatory) ' + (st.bun15 ? '<span class="mono">' + esc(st.bun15.code) + '</span>' : '') + '</span>' + tag(st.bun15) + '</li></ul>';
    } else {
      var c = st.bun24.code;
      h += '<div class="steps"><span class="done">QR-24</span><span class="' + (st.bun15 ? 'done' : '') + '">QR-15 (optional)</span><span class="' + (readyToClose() ? 'now' : '') + '">Close</span></div>';
      h += '<div class="counter">' + esc(PKG[c[23]]) + '</div><div class="muted">' + esc(st.sku.SKU_Code) + ' · ' + esc(st.sku.SKU_Description) + ' · qty ' + (+c.slice(21, 23)) + '</div>';
      h += '<ul class="list"><li><span>QR-24 <span class="mono">' + esc(c) + '</span></span>' + tag(st.bun24) + '</li>' +
        '<li><span>QR-15 (optional) ' + (st.bun15 ? '<span class="mono">' + esc(st.bun15.code) + '</span>' : '') + '</span>' + (st.bun15 ? tag(st.bun15) : '<span class="tag">skip allowed</span>') + '</li></ul>';
    }
    $('p-state').innerHTML = h;
    $('p-close').disabled = !readyToClose();
    $('p-undo').disabled = !st.history.length;
  }

  $('p-undo').onclick = function () {
    var it = st.history[st.history.length - 1]; if (!it) return;
    removeItem(it); $('p-msg').innerHTML = ''; renderPack();
    if (packScanner) packScanner.forget();
  };
  $('p-cancel').onclick = function () {
    if (st.history.length && !confirm('Discard all scans for this package?')) return;
    resetPack();
  };

  $('p-close').onclick = function () {
    if (!readyToClose()) return;
    $('p-close').disabled = true; msg('p-msg', 'info', 'Saving…');
    authCall('closePackage', {
      clientUUID: st.uuid, bun24: st.bun24.code, bun15: st.bun15 ? st.bun15.code : '',
      pipes: st.pipes.map(function (x) { return x.code; })
    }, 45000).then(function (r) {
      if (!r.ok) {
        $('p-close').disabled = false;
        if (notSaved(r, 'p-msg', function () { resetPack(); show('pack'); })) return;
        TRBeep('bad');
        return msg('p-msg', 'bad', '<b>Not saved.</b><br>' + esc(r.error).replace(/\n/g, '<br>'));
      }
      TRBeep('ok');
      var w = (r.warnings || []).length ? '<div class="msg warn"><b>Saved with warnings:</b><br>' + r.warnings.map(esc).join('<br>') + '</div>' : '';
      $('d-out').innerHTML = '<div class="msg ok"><b>' + esc(r.pkgType || 'Package') + ' closed' + (r.duplicate ? ' (already saved earlier)' : '') + '</b></div>' + w +
        '<div class="card">' + kv([['Event', 'Produced · EVT ' + esc(r.evtId)], ['SKU', r.sku ? esc(r.sku) + ' · ' + esc(r.skuName || '') : ''],
          ['Quantity', esc(r.qty)], ['From', esc(r.from)], ['To', esc(r.where) + (r.whereName ? ' · ' + esc(r.whereName) : '')], ['When', esc(r.when)],
          ['Authorised by', r.authBy ? esc(userName(r.authBy)) : ''],
          ['QR-24', '<span class="mono">' + esc(r.bun24) + '</span>'], ['QR-15', r.bun15 ? '<span class="mono">' + esc(r.bun15) + '</span>' : (r.duplicate ? '' : 'none')]]) + '</div>';
      show('done');
    }).catch(function (e) {
      $('p-close').disabled = false;
      msg('p-msg', 'bad', esc(e.message) + '<br>Your scans are kept. Tap Close package again to retry; it will not be saved twice.');
    });
  };
  $('d-next').onclick = function () { resetPack(); show('pack'); };

  window.TRApp = {
    show: show, msg: msg, esc: esc, kv: kv, timeline: timeline, camButton: camButton, authCall: authCall, notSaved: notSaved,
    showResult: showResult, here: here, level: level, userName: userName, LEVEL: LEVEL,
    masters: function () { return M; }, skuByCode: function (c) { return (M && M.skus || []).filter(function (s) { return s.SKU_Code === c; })[0]; },
    skuByPart: function (p) { return skuByPart[p]; }, target: target, todayYYMMDD: todayYYMMDD
  };

  resetPack();
  start();
})();
