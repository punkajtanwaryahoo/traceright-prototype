// TraceRight prototype: Login, Lookup, Primary Pack
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var M = null;                    // masters
  var skuByPart = {};
  var current = null;              // visible view name
  var lookupScanner = null, packScanner = null;
  var PKG = { '1': 'Pipe Bundle', '2': 'Fittings Box', '3': 'Agri Pipe' };

  function todayYYMMDD() {
    var d = new Date(); return String(d.getFullYear()).slice(2) + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
  }
  function msg(el, kind, html) { $(el).innerHTML = '<div class="msg ' + kind + '">' + html + '</div>'; }

  // ------------------------------------------------------------ navigation
  function show(view) {
    ['setup', 'login', 'home', 'lookup', 'pack', 'done'].forEach(function (v) { $('v-' + v).classList.toggle('hidden', v !== view); });
    if (view !== 'lookup' && lookupScanner) lookupScanner.stop().then(function () { $('k-cam').textContent = 'Start camera'; });
    if (view !== 'pack' && packScanner) packScanner.stop().then(function () { $('p-cam').textContent = 'Start camera'; });
    current = view;
    var u = TRApi.user();
    $('who').innerHTML = u && view !== 'login' && view !== 'setup'
      ? esc(u.name) + ' · ' + esc(u.role) + '<br><button class="link" id="logout">Log out</button>' : '';
    var lo = $('logout'); if (lo) lo.onclick = function () { TRApi.logout(); start(); };
    $('title').textContent = { lookup: 'Lookup', pack: 'Primary Pack', done: 'Primary Pack' }[view] || 'TraceRight';
    window.scrollTo(0, 0);
  }
  document.addEventListener('click', function (e) {
    var g = e.target.closest('[data-go]');
    if (!g) return;
    var v = g.getAttribute('data-go');
    if (v === 'pack') resetPack();
    if (v === 'lookup') $('k-out').innerHTML = '';
    show(v);
  });
  window.addEventListener('tr-auth-expired', function () { show('login'); msg('l-msg', 'warn', 'Session expired. Please log in again.'); });

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
    show(TRApi.user() ? 'home' : 'login');
    $('l-user').innerHTML = '<option value="">Loading users…</option>';
    loadMasters().then(function (res) {
      $('l-user').innerHTML = '<option value="">Select your name</option>' + res.users.map(function (u) {
        return '<option value="' + esc(u.code) + '">' + esc(u.name) + ' (' + esc(u.role) + ')</option>';
      }).join('');
      $('home-info').textContent = 'Connected. Server date ' + res.serverDate + '. Pipes per bundle: ' + res.pipeBundleQty + '.';
    }).catch(function (e) {
      $('l-user').innerHTML = '<option value="">Could not load users</option>';
      msg('l-msg', 'bad', esc(e.message));
      $('home-info').textContent = e.message;
    });
  }

  $('l-go').onclick = function () {
    var usr = $('l-user').value, pin = $('l-pin').value.trim();
    if (!usr) return msg('l-msg', 'warn', 'Select your name.');
    if (!pin) return msg('l-msg', 'warn', 'Enter your PIN.');
    $('l-go').disabled = true; msg('l-msg', 'info', 'Checking…');
    TRApi.call('login', { usr: usr, pin: pin }).then(function (res) {
      $('l-go').disabled = false;
      if (!res.ok) return msg('l-msg', 'bad', esc(res.error));
      TRApi.saveLogin(res); $('l-pin').value = ''; $('l-msg').innerHTML = '';
      show('home');
    }).catch(function (e) { $('l-go').disabled = false; msg('l-msg', 'bad', esc(e.message)); });
  };
  $('l-pin').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('l-go').click(); });

  // ------------------------------------------------------------ camera buttons
  function camButton(btnId, readerId, getScanner, setScanner, onCode) {
    $(btnId).onclick = function () {
      var s = getScanner();
      if (!s) { s = new TRScanner(readerId, onCode); setScanner(s); }
      if (s.running) { s.stop().then(function () { $(btnId).textContent = 'Start camera'; }); return; }
      $(btnId).textContent = 'Starting…';
      s.start().then(function () { $(btnId).textContent = 'Stop camera'; })
        .catch(function (e) { $(btnId).textContent = 'Start camera'; alert('Camera could not start: ' + e); });
    };
  }

  // ------------------------------------------------------------ Screen 2: Lookup
  camButton('k-cam', 'k-reader', function () { return lookupScanner; }, function (s) { lookupScanner = s; }, doLookup);
  $('k-manual-go').onclick = function () { var v = $('k-manual').value.trim(); if (v) doLookup(v); };

  function doLookup(code) {
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
  function timeline(events) {
    if (!events || !events.length) return '<p class="muted">No events yet.</p>';
    events.sort(function (a, b) { return (a.When > b.When ? 1 : -1) || (+a.EVT_ID - +b.EVT_ID); });
    return '<div class="timeline">' + events.map(function (e) {
      return '<div class="ev"><b>' + esc(e.Event) + ' · ' + esc(e.Where) + '</b><span class="muted">' + esc(e.When) +
        ' · qty ' + esc(e.Item_Qty) + ' · ' + esc(e.USR_Code) + ' · EVT ' + esc(e.EVT_ID) + '</span>' +
        (e.Reason ? '<div class="muted">⚠ ' + esc(e.Reason) + '</div>' : '') + '</div>';
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

  // ------------------------------------------------------------ Screen 3: Primary Pack
  var st;
  function resetPack() {
    st = { mode: null, pipes: [], bun24: null, bun15: null, sku: null, history: [], uuid: TRApi.uuid() };
    $('p-msg').innerHTML = ''; renderPack();
    if (packScanner) packScanner.forget();
  }
  function target() { return (M && M.pipeBundleQty) || 6; }

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
      good(esc(PKG[chk]) + ' label QR-24 · ' + esc(s2.SKU_Code) + ' · qty ' + qty + dateNote);
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
        'Fittings box or Agri pipe: scan its QR-24; QR-15 is optional.</p>';
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
    TRApi.call('closePackage', {
      clientUUID: st.uuid, bun24: st.bun24.code, bun15: st.bun15 ? st.bun15.code : '',
      pipes: st.pipes.map(function (x) { return x.code; })
    }, 45000).then(function (r) {
      if (!r.ok) {
        $('p-close').disabled = false; TRBeep('bad');
        return msg('p-msg', 'bad', '<b>Not saved.</b><br>' + esc(r.error).replace(/\n/g, '<br>'));
      }
      TRBeep('ok');
      var w = (r.warnings || []).length ? '<div class="msg warn"><b>Saved with warnings:</b><br>' + r.warnings.map(esc).join('<br>') + '</div>' : '';
      $('d-out').innerHTML = '<div class="msg ok"><b>' + esc(r.pkgType || 'Package') + ' closed' + (r.duplicate ? ' (already saved earlier)' : '') + '</b></div>' + w +
        '<div class="card">' + kv([['Event', 'Produced · EVT ' + esc(r.evtId)], ['SKU', esc(r.sku || '') + ' · ' + esc(r.skuName || '')],
          ['Quantity', esc(r.qty)], ['Where', esc(r.where)], ['When', esc(r.when)],
          ['QR-24', '<span class="mono">' + esc(r.bun24) + '</span>'], ['QR-15', r.bun15 ? '<span class="mono">' + esc(r.bun15) + '</span>' : 'none']]) + '</div>';
      show('done');
    }).catch(function (e) {
      $('p-close').disabled = false;
      msg('p-msg', 'bad', esc(e.message) + '<br>Your scans are kept. Tap Close package again to retry; it will not be saved twice.');
    });
  };
  $('d-next').onclick = function () { resetPack(); show('pack'); };

  resetPack();
  start();
})();
