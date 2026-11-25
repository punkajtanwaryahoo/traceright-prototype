// TraceRight prototype: Transfer, Sales, Returns, Unpack, Repack, Dashboard (MOD003-MOD007)
(function () {
  var A = window.TRApp;
  var $ = function (id) { return document.getElementById(id); };
  var esc = A.esc, msg = A.msg, kv = A.kv;
  var PKG = { '1': 'Pipe Bundle', '2': 'Fittings Box', '3': 'Agri Pipe' };
  var scanners = {};
  var lastAgain = null;               // what "Start another" does on the result screen
  function isSup() { var u = TRApi.user(); return u && Number(u.access) >= 2; }
  function bad(el, t) { TRBeep('bad'); msg(el, 'bad', t); }
  function good(el, t) { TRBeep('ok'); msg(el, 'ok', t); }
  function code(s) { return '<span class="mono">' + esc(s) + '</span>'; }
  function skuText(c) { var s = A.skuByCode(c); return s ? esc(s.SKU_Code) + ' · ' + esc(s.SKU_Description) : esc(c); }
  function placeName(c) {
    var m = A.masters() || {};
    var w = (m.warehouses || []).filter(function (x) { return x.WHS_Code === c; })[0];
    if (w) return w.WHS_Code + ' · ' + w.WHS_Name;
    var k = (m.customers || []).filter(function (x) { return x.code === c; })[0];
    return k ? k.code + ' · ' + k.name : c;
  }
  function remember(key, val) { try { localStorage.setItem('tr_' + key, val); } catch (e) {} }
  function recall(key) { try { return localStorage.getItem('tr_' + key) || ''; } catch (e) { return ''; } }

  function locOptions(sel, key) {
    var m = A.masters(); if (!m) return;
    var cur = sel.value || recall(key);
    sel.innerHTML = '<option value="">Select location</option>' + m.warehouses.map(function (w) {
      return '<option value="' + esc(w.WHS_Code) + '">' + esc(w.WHS_Code + ' · ' + w.WHS_Name) + '</option>';
    }).join('');
    sel.value = cur;
    sel.onchange = function () { remember(key, sel.value); };
  }

  function cam(btn, reader, onCode) {
    A.camButton(btn, reader, function () { return scanners[reader]; }, function (s) { scanners[reader] = s; }, onCode);
  }
  window.addEventListener('tr-view', function () {
    Object.keys(scanners).forEach(function (r) {
      var s = scanners[r];
      if (s && s.running) s.stop().then(function () {
        var b = document.querySelector('[id$="-cam"][data-reader="' + r + '"]');
        if (b) b.textContent = 'Start camera';
      });
    });
    ['mv-cam', 'rt-cam', 'up-cam', 'rp-cam'].forEach(function (id) { $(id).textContent = 'Start camera'; });
  });
  function manual(input, btn, fn) { $(btn).onclick = function () { var v = $(input).value.trim(); if (v) { $(input).value = ''; fn(v); } }; }

  function showResult(html, again) {
    $('rs-out').innerHTML = html; lastAgain = again; A.show('result');
  }
  $('rs-again').onclick = function () { if (lastAgain) lastAgain(); };

  function pkgCard(p) {
    return kv([['Type', esc(p.PKG_Type.replace(/^\d = /, ''))], ['SKU', skuText(p.SKU_Code)], ['QR-24', code(p.BUN_QR24)],
      ['QR-15', p.BUN_QR15 ? code(p.BUN_QR15) : '<span class="muted">none</span>'],
      ['Status', '<b>' + esc(p.Current_Status) + '</b> · ' + esc(placeName(p.Current_Where))], ['Quantity', esc(p.Current_Qty)], ['Last event', esc(p.Last_Event_When)]]);
  }

  // =========================================================== Transfer & Sales
  var mv = null;
  function startMove(mode) {
    mv = { mode: mode, items: [], uuid: TRApi.uuid() };
    window.TRMoveTitle = mode === 'sales' ? 'Sales' : 'Transfer';
    var m = A.masters() || { customers: [] };
    var f = '';
    if (mode === 'transfer') {
      f += '<label for="mv-dest">Destination</label><select id="mv-dest" class="loc"></select>';
      f += '<label for="mv-doc">Transfer advice no. (optional)</label><input id="mv-doc" autocomplete="off">';
    } else {
      f += '<label for="mv-from">Dispatching from</label><select id="mv-from" class="loc"></select>';
      f += '<label for="mv-cst">Customer</label><select id="mv-cst"><option value="">Select customer</option>' + m.customers.map(function (c) {
        return '<option value="' + esc(c.code) + '">' + esc(c.name + ' · ' + c.city) + '</option>';
      }).join('') + '</select>';
      f += '<div class="row"><div><label for="mv-doc">Invoice / SO no.</label><input id="mv-doc" autocomplete="off"></div>' +
        '<div><label for="mv-veh">Vehicle no.</label><input id="mv-veh" autocomplete="off"></div></div>';
      if (isSup()) f += '<label class="check"><input type="checkbox" id="mv-ovr"> Allow packages recorded at another location (supervisor override)</label>';
    }
    $('mv-fields').innerHTML = f;
    if (mode === 'transfer') locOptions($('mv-dest'), 'dest'); else locOptions($('mv-from'), 'from');
    $('mv-save').textContent = mode === 'sales' ? 'Loading complete · record Sold' : 'Loading complete · record Transfer';
    $('mv-msg').innerHTML = '';
    renderMove();
  }

  function moveScan(c) {
    var p = TR.parseQR(c);
    if (!p.ok) return bad('mv-msg', '<b>Not a valid TraceRight code.</b> ' + code(c));
    if (p.kind === 'PIPE_QR24') return bad('mv-msg', 'That is a pipe. Scan the package label (QR-24 or QR-15).');
    var place = mv.mode === 'transfer' ? $('mv-dest').value : $('mv-from').value;
    if (!place) return bad('mv-msg', mv.mode === 'transfer' ? 'Choose the destination first.' : 'Choose the dispatching location first.');
    if (mv.mode === 'sales' && !$('mv-cst').value) return bad('mv-msg', 'Choose the customer first.');
    msg('mv-msg', 'info', 'Checking ' + code(c) + '…');
    TRApi.call('info', { code: c }).then(function (r) {
      if (!r.ok) return bad('mv-msg', esc(r.error));
      if (!r.found) return bad('mv-msg', '<b>Package not in the system.</b> ' + code(c));
      var k = r.package, st = k.Current_Status;
      if (mv.items.some(function (x) { return x.pkg.BUN_QR24 === k.BUN_QR24; })) { TRBeep('warn'); return msg('mv-msg', 'warn', 'This package is already in the list.'); }
      if (st === 'Sold') return bad('mv-msg', '<b>Already sold</b> to ' + esc(placeName(k.Current_Where)) + '.');
      if (st === 'Unpacked') return bad('mv-msg', '<b>Package no longer active</b> (unpacked).');
      if (st === 'Return Received') {
        if (mv.mode === 'sales') return bad('mv-msg', '<b>Return awaiting inspection.</b> A supervisor must transfer it back into stock first.');
        if (!isSup()) return bad('mv-msg', '<b>Return awaiting inspection.</b> Only a supervisor can transfer it.');
      }
      var note = '';
      if (mv.mode === 'transfer' && k.Current_Where === place) return bad('mv-msg', 'Package is already at ' + esc(place) + '.');
      if (mv.mode === 'sales' && k.Current_Where !== place) {
        var ovr = $('mv-ovr') && $('mv-ovr').checked;
        if (!ovr) return bad('mv-msg', 'Package is recorded at <b>' + esc(placeName(k.Current_Where)) + '</b>, not ' + esc(place) + '.' + (isSup() ? ' Tick the override box if it is really here.' : ' Ask a supervisor.'));
        note = 'override: was at ' + k.Current_Where;
      }
      mv.items.push({ pkg: k, note: note });
      good('mv-msg', 'Added ' + esc(k.PKG_Type.replace(/^\d = /, '')) + ' · ' + esc(k.SKU_Code) + ' · qty ' + esc(k.Current_Qty) + (note ? ' <span class="tag pend">' + esc(note) + '</span>' : ''));
      renderMove();
    }).catch(function (e) { bad('mv-msg', esc(e.message)); });
  }

  function renderMove() {
    var h = '<h2>' + mv.items.length + ' package' + (mv.items.length === 1 ? '' : 's') + ' scanned</h2>';
    if (!mv.items.length) h += '<p class="muted">Scan the QR-24 or QR-15 of each package as it is loaded.</p>';
    else {
      var by = {};
      mv.items.forEach(function (x) { var s = x.pkg.SKU_Code; by[s] = by[s] || { n: 0, q: 0 }; by[s].n++; by[s].q += Number(x.pkg.Current_Qty) || 0; });
      h += '<table class="grid"><tr><th>SKU</th><th class="n">Packages</th><th class="n">Pieces</th></tr>' + Object.keys(by).sort().map(function (s) {
        return '<tr><td>' + skuText(s) + '</td><td class="n">' + by[s].n + '</td><td class="n">' + by[s].q + '</td></tr>';
      }).join('') + '</table><div style="height:8px"></div><ul class="list">' + mv.items.map(function (x, i) {
        return '<li><span class="mono">' + (i + 1) + '. ' + esc(x.pkg.BUN_QR24) + '</span><span class="muted">' + esc(x.pkg.Current_Where) + '</span></li>';
      }).join('') + '</ul>';
    }
    $('mv-list').innerHTML = h;
    $('mv-save').disabled = !mv.items.length;
    $('mv-undo').disabled = !mv.items.length;
  }
  cam('mv-cam', 'mv-reader', moveScan);
  manual('mv-manual', 'mv-manual-go', moveScan);
  $('mv-undo').onclick = function () { mv.items.pop(); $('mv-msg').innerHTML = ''; renderMove(); if (scanners['mv-reader']) scanners['mv-reader'].forget(); };
  $('mv-cancel').onclick = function () { if (!mv.items.length || confirm('Discard this loading session?')) startMove(mv.mode); };
  $('mv-save').onclick = function () {
    var sales = mv.mode === 'sales';
    var body = { clientUUID: mv.uuid, codes: mv.items.map(function (x) { return x.pkg.BUN_QR24; }), docRef: $('mv-doc').value.trim() };
    if (sales) {
      body.from = $('mv-from').value; body.customer = $('mv-cst').value; body.vehicle = $('mv-veh').value.trim();
      body.override = !!($('mv-ovr') && $('mv-ovr').checked);
      if (!body.customer) return bad('mv-msg', 'Choose the customer.');
    } else body.dest = $('mv-dest').value;
    var n = mv.items.length;
    if (!confirm((sales ? 'Record ' + n + ' package(s) as Sold to ' + placeName(body.customer) : 'Record transfer of ' + n + ' package(s) to ' + placeName(body.dest)) + '?')) return;
    $('mv-save').disabled = true; msg('mv-msg', 'info', 'Saving…');
    TRApi.call(sales ? 'sell' : 'transfer', body, 60000).then(function (r) {
      if (!r.ok) { $('mv-save').disabled = false; return bad('mv-msg', '<b>Not saved.</b><br>' + (r.errors || [r.error]).map(esc).join('<br>')); }
      TRBeep('ok');
      var mode = mv.mode;
      showResult('<div class="msg ok"><b>' + (sales ? 'Sold' : 'Transferred') + (r.duplicate ? ' (already saved earlier)' : '') + '</b></div>' +
        ((r.warnings || []).length ? '<div class="msg warn">' + r.warnings.map(esc).join('<br>') + '</div>' : '') +
        '<div class="card">' + kv([[sales ? 'Customer' : 'To', esc(r.whereName ? r.where + ' · ' + r.whereName : r.where)], ['Packages', esc(r.count)], ['Pieces', esc(r.pieces)],
          ['When', esc(r.when)], ['Events', esc((r.evtIds || []).join(', '))]]) + '</div>', function () { startMove(mode); A.show('move'); });
    }).catch(function (e) { $('mv-save').disabled = false; bad('mv-msg', esc(e.message) + '<br>Scans kept; tap again to retry. It will not be saved twice.'); });
  };

  // =========================================================== Returns (supervisor)
  var rt = null;
  function startReturn() { rt = { uuid: TRApi.uuid(), pkg: null }; $('rt-form').classList.add('hidden'); $('rt-msg').innerHTML = ''; locOptions($('rt-at'), 'ret'); }
  function returnScan(c) {
    var p = TR.parseQR(c);
    if (!p.ok || p.kind === 'PIPE_QR24' || p.kind === 'UNKNOWN') return bad('rt-msg', 'Scan the package label (QR-24 or QR-15).');
    msg('rt-msg', 'info', 'Checking…');
    TRApi.call('info', { code: c }).then(function (r) {
      if (!r.ok) return bad('rt-msg', esc(r.error));
      if (!r.found) return bad('rt-msg', '<b>Package not in the system.</b> If both labels are missing it must be handled as loose stock.');
      var k = r.package;
      if (k.Current_Status !== 'Sold') return bad('rt-msg', '<b>Only a sold package can be returned.</b> This one is ' + esc(k.Current_Status) + ' at ' + esc(placeName(k.Current_Where)) + '.');
      rt.pkg = k; good('rt-msg', 'Sold package found.');
      $('rt-form').innerHTML = '<h2>Return from ' + esc(placeName(k.Current_Where)) + '</h2>' + pkgCard(k) +
        '<label for="rt-qty">Quantity received (sold ' + esc(k.Current_Qty) + ')</label><input id="rt-qty" type="number" inputmode="numeric" min="1" max="' + esc(k.Current_Qty) + '" value="' + esc(k.Current_Qty) + '">' +
        '<label for="rt-cond">Condition</label><select id="rt-cond"><option>Intact</option><option>Damaged</option><option>Short</option></select>' +
        '<label for="rt-reason">Reason (optional)</label><input id="rt-reason" autocomplete="off">' +
        '<label for="rt-doc">Sales return / credit note no. (optional)</label><input id="rt-doc" autocomplete="off">' +
        '<div style="height:12px"></div><button class="ok" id="rt-save">Record Return Received</button>';
      $('rt-form').classList.remove('hidden');
      $('rt-save').onclick = saveReturn;
    }).catch(function (e) { bad('rt-msg', esc(e.message)); });
  }
  function saveReturn() {
    if (!$('rt-at').value) return bad('rt-msg', 'Choose the receiving location.');
    var q = Number($('rt-qty').value);
    $('rt-save').disabled = true; msg('rt-msg', 'info', 'Saving…');
    TRApi.call('returnReceive', { clientUUID: rt.uuid, code: rt.pkg.BUN_QR24, at: $('rt-at').value, qty: q, condition: $('rt-cond').value,
      reason: $('rt-reason').value.trim(), docRef: $('rt-doc').value.trim() }).then(function (r) {
      if (!r.ok) { $('rt-save').disabled = false; return bad('rt-msg', (r.errors || [r.error]).map(esc).join('<br>')); }
      TRBeep('ok');
      showResult('<div class="msg ok"><b>Return Received' + (r.duplicate ? ' (already saved earlier)' : '') + '</b></div>' +
        '<div class="card">' + kv([['Package', code(r.bun24 || rt.pkg.BUN_QR24)], ['From customer', esc(placeName(r.customer || ''))], ['Received at', esc(r.where + ' · ' + (r.whereName || ''))],
          ['Quantity', esc(r.pieces)], ['Condition', esc(r.condition || '')], ['When', esc(r.when)]]) + '</div>' +
        '<div class="msg info">Next: if intact and complete, a supervisor <b>Transfers</b> it to a saleable location. If damaged or short, <b>Unpack</b> it and repack the good pipes.</div>',
        function () { startReturn(); A.show('ret'); });
    }).catch(function (e) { $('rt-save').disabled = false; bad('rt-msg', esc(e.message)); });
  }
  cam('rt-cam', 'rt-reader', returnScan);
  manual('rt-manual', 'rt-manual-go', returnScan);

  // =========================================================== Unpack (supervisor)
  var up = null;
  function startUnpack() { up = { uuid: TRApi.uuid(), pkg: null }; $('up-form').classList.add('hidden'); $('up-msg').innerHTML = ''; locOptions($('up-at'), 'unp'); }
  function unpackScan(c) {
    var p = TR.parseQR(c);
    if (!p.ok || p.kind === 'PIPE_QR24' || p.kind === 'UNKNOWN') return bad('up-msg', 'Scan the package label (QR-24 or QR-15).');
    msg('up-msg', 'info', 'Checking…');
    TRApi.call('info', { code: c }).then(function (r) {
      if (!r.ok) return bad('up-msg', esc(r.error));
      if (!r.found) return bad('up-msg', '<b>Package not in the system.</b>');
      var k = r.package;
      if (k.Current_Status === 'Unpacked') return bad('up-msg', '<b>Already unpacked.</b>');
      if (k.Current_Status === 'Sold') return bad('up-msg', '<b>Package is with the customer.</b> Receive it first using Returns.');
      up.pkg = k; good('up-msg', 'Package found.');
      var chk = k.BUN_QR24[23];
      $('up-form').innerHTML = '<h2>Unpack this package?</h2>' + pkgCard(k) +
        (chk === '1' ? '<p class="muted">All ' + esc(k.Current_Qty) + ' pipes are released as loose stock. They keep their QR and can go into a new bundle with Repack.</p>' :
          chk === '3' ? '<p class="muted">Agri pipe: the virtual bundle ends. The pipe has no pipe QR; it can only re-enter with a new Agri repack label.</p>' :
          '<p class="muted">Fittings box: contents become loose stock (not tracked individually).</p>') +
        '<label for="up-reason">Reason</label><select id="up-reason"><option>Damaged package</option><option>Return inspection failed</option><option>Mixed / wrong SKU</option><option>Re-bundling</option><option>Other</option></select>' +
        '<label for="up-remark">Remark (optional)</label><input id="up-remark" autocomplete="off">' +
        '<div style="height:12px"></div><button class="danger" id="up-save">Unpack (cannot be undone)</button>';
      $('up-form').classList.remove('hidden');
      $('up-save').onclick = saveUnpack;
    }).catch(function (e) { bad('up-msg', esc(e.message)); });
  }
  function saveUnpack() {
    if (!$('up-at').value) return bad('up-msg', 'Choose the location.');
    if (!confirm('Unpack ' + up.pkg.BUN_QR24 + '? This cannot be undone and its labels can never be reused.')) return;
    $('up-save').disabled = true; msg('up-msg', 'info', 'Saving…');
    TRApi.call('unpack', { clientUUID: up.uuid, code: up.pkg.BUN_QR24, at: $('up-at').value, reason: $('up-reason').value, remark: $('up-remark').value.trim() }).then(function (r) {
      if (!r.ok) { $('up-save').disabled = false; return bad('up-msg', (r.errors || [r.error]).map(esc).join('<br>')); }
      TRBeep('ok');
      showResult('<div class="msg ok"><b>Unpacked' + (r.duplicate ? ' (already saved earlier)' : '') + '</b></div>' +
        '<div class="card">' + kv([['Package', code(r.bun24 || up.pkg.BUN_QR24)], ['At', esc(r.where + ' · ' + (r.whereName || ''))], ['Pieces released', esc(r.pieces)],
          ['Pipe memberships closed', esc(r.released != null ? r.released : '')], ['When', esc(r.when)]]) + '</div>',
        function () { startUnpack(); A.show('unp'); });
    }).catch(function (e) { $('up-save').disabled = false; bad('up-msg', esc(e.message)); });
  }
  cam('up-cam', 'up-reader', unpackScan);
  manual('up-manual', 'up-manual-go', unpackScan);

  // =========================================================== Repack
  var rp = null;
  function startRepack() {
    rp = { uuid: TRApi.uuid(), mode: null, pipes: [], bun24: null, bun15: null, sku: null, history: [] };
    $('rp-msg').innerHTML = ''; locOptions($('rp-at'), 'rep'); renderRepack();
  }
  function locNo() {
    var m = A.masters() || {}, v = $('rp-at').value;
    var w = (m.warehouses || []).filter(function (x) { return x.WHS_Code === v; })[0];
    return w ? ('0' + w.Loc_No).slice(-2) : '';
  }
  function repackScan(c) {
    var p = TR.parseQR(c);
    if (!p.ok) return bad('rp-msg', '<b>Not a valid TraceRight code.</b> ' + code(c));
    if (!$('rp-at').value) return bad('rp-msg', 'Choose the repack location first.');
    var part = c.slice(9, 17);
    if (p.kind === 'PIPE_QR24') {
      if (rp.mode === 'box') return bad('rp-msg', 'This repack is a ' + esc(PKG[rp.bun24.code[23]]) + '; it takes no pipes.');
      if (rp.bun24) return bad('rp-msg', 'Label already scanned. Scan pipes before the new label.');
      if (rp.pipes.some(function (x) { return x.code === c; })) { TRBeep('warn'); return msg('rp-msg', 'warn', 'Pipe already in the list.'); }
      if (rp.pipes.length >= A.target()) return bad('rp-msg', 'Already ' + A.target() + ' pipes. Scan the new bundle label.');
      if (rp.sku && rp.sku.ERP_Part !== part) return bad('rp-msg', '<b>Different SKU.</b> All pipes must be ' + esc(rp.sku.SKU_Code) + '.');
      var item = { code: c, status: 'pend' };
      rp.mode = 'pipe'; rp.sku = rp.sku || A.skuByPart(part); rp.pipes.push(item); rp.history.push(item); renderRepack();
      TRApi.call('info', { code: c }).then(function (r) {
        if (!r.ok || !r.found) { item.status = 'bad'; drop(item); bad('rp-msg', 'Pipe is not in the system (never bundled). Removed.'); }
        else if (!r.loose) { item.status = 'bad'; drop(item); bad('rp-msg', 'Pipe still belongs to package ' + code(r.activeBundle) + '. Unpack that package first. Removed.'); }
        else { item.status = 'ok'; good('rp-msg', 'Loose pipe ' + rp.pipes.length + ' · ' + esc(rp.sku ? rp.sku.SKU_Code : part)); }
        renderRepack();
      }).catch(function (e) { item.status = 'bad'; drop(item); bad('rp-msg', esc(e.message)); renderRepack(); });
      return;
    }
    if (p.kind === 'BUNDLE_QR24') {
      var chk = c[23], qty = +c.slice(21, 23), s2 = A.skuByPart(part);
      if (rp.bun24) return bad('rp-msg', 'New label already scanned.');
      if (c[6] !== '0') return bad('rp-msg', '<b>This is a production label.</b> Repack needs a repack label (factory digit 0). Print them from Print demo labels → Repack.');
      if (c.slice(7, 9) !== locNo()) return bad('rp-msg', 'Label is for location ' + esc(c.slice(7, 9)) + '; ' + esc($('rp-at').value) + ' is location ' + esc(locNo()) + '.');
      if (!s2 || String(s2.PKG_Check) !== chk) return bad('rp-msg', 'Label SKU / check digit do not match SKU_Master.');
      if (chk === '1') {
        if (rp.mode !== 'pipe' || !rp.pipes.length) return bad('rp-msg', 'Scan the loose pipes first.');
        if (rp.pipes.some(function (x) { return x.status !== 'ok'; })) return bad('rp-msg', 'Wait until every pipe shows a green tick.');
        if (part !== rp.sku.ERP_Part) return bad('rp-msg', 'Label is ' + esc(s2.SKU_Code) + '; pipes are ' + esc(rp.sku.SKU_Code) + '.');
        if (qty !== rp.pipes.length) return bad('rp-msg', 'Label quantity is ' + ('0' + qty).slice(-2) + ' but ' + rp.pipes.length + ' pipes scanned.');
        if (qty < A.target() && !isSup()) return bad('rp-msg', 'A short bundle needs a supervisor.');
      } else {
        if (rp.mode === 'pipe') return bad('rp-msg', 'This is a ' + PKG[chk] + ' label. Cancel the pipe repack first.');
        if (chk === '3' && !isSup()) return bad('rp-msg', 'Agri repack needs a supervisor.');
        rp.mode = 'box'; rp.sku = s2;
      }
      rp.bun24 = { code: c, status: 'pend' }; rp.history.push(rp.bun24); renderRepack();
      unused(rp.bun24, 'bun24');
      return;
    }
    if (p.kind === 'BUNDLE_QR15') {
      if (!rp.bun24) return bad('rp-msg', 'Scan the new QR-24 first.');
      if (rp.bun15) return bad('rp-msg', 'QR-15 already scanned.');
      rp.bun15 = { code: c, status: 'pend' }; rp.history.push(rp.bun15); renderRepack();
      unused(rp.bun15, 'bun15');
    }
  }
  function unused(item, role) {
    TRApi.call('checkCode', { code: item.code, role: role }).then(function (r) {
      if (r.ok && !r.used) { item.status = 'ok'; good('rp-msg', 'New label OK.'); }
      else { item.status = 'bad'; drop(item); bad('rp-msg', 'Label already used. Removed; scan an unused one.'); }
      renderRepack();
    }).catch(function (e) { item.status = 'bad'; drop(item); bad('rp-msg', esc(e.message)); renderRepack(); });
  }
  function drop(item) {
    rp.pipes = rp.pipes.filter(function (x) { return x !== item; });
    if (rp.bun24 === item) rp.bun24 = null;
    if (rp.bun15 === item) rp.bun15 = null;
    rp.history = rp.history.filter(function (x) { return x !== item; });
    if (!rp.pipes.length && !rp.bun24) { rp.mode = null; rp.sku = null; }
  }
  function tag(it) {
    if (!it) return '<span class="tag">waiting</span>';
    return { ok: '<span class="tag ok">✓</span>', pend: '<span class="tag pend">checking…</span>', bad: '<span class="tag bad">✗</span>' }[it.status];
  }
  function repackReady() {
    if (rp.mode === 'pipe') return rp.pipes.length && rp.pipes.every(function (x) { return x.status === 'ok'; }) && rp.bun24 && rp.bun24.status === 'ok' && rp.bun15 && rp.bun15.status === 'ok';
    if (rp.mode === 'box') return rp.bun24 && rp.bun24.status === 'ok' && (!rp.bun15 || rp.bun15.status === 'ok');
    return false;
  }
  function renderRepack() {
    var h;
    if (!rp.mode) h = '<h2>Repack from loose stock</h2><p class="muted">Pipe bundle: scan the loose pipes, then a <b>repack</b> QR-24 and QR-15.<br>Fittings box or Agri pipe: scan its repack QR-24; QR-15 optional.</p>';
    else if (rp.mode === 'pipe') {
      h = '<div class="counter">' + rp.pipes.length + ' loose pipe' + (rp.pipes.length === 1 ? '' : 's') + '</div><div class="muted">' + (rp.sku ? esc(rp.sku.SKU_Code + ' · ' + rp.sku.SKU_Description) : '') +
        ' · full bundle ' + A.target() + (rp.pipes.length < A.target() ? ' (short bundles: supervisor only)' : '') + '</div><ul class="list">' + rp.pipes.map(function (x, i) {
          return '<li><span class="mono">' + (i + 1) + '. ' + esc(x.code) + '</span>' + tag(x) + '</li>'; }).join('') + '</ul>' +
        '<ul class="list"><li><span>New QR-24 ' + (rp.bun24 ? code(rp.bun24.code) : '') + '</span>' + tag(rp.bun24) + '</li><li><span>QR-15 (mandatory) ' + (rp.bun15 ? code(rp.bun15.code) : '') + '</span>' + tag(rp.bun15) + '</li></ul>';
    } else {
      var c = rp.bun24.code;
      h = '<div class="counter">' + esc(PKG[c[23]]) + '</div><div class="muted">' + esc(rp.sku.SKU_Code + ' · ' + rp.sku.SKU_Description) + ' · qty ' + (+c.slice(21, 23)) + '</div>' +
        '<ul class="list"><li><span>New QR-24 ' + code(c) + '</span>' + tag(rp.bun24) + '</li><li><span>QR-15 (optional) ' + (rp.bun15 ? code(rp.bun15.code) : '') + '</span>' + (rp.bun15 ? tag(rp.bun15) : '<span class="tag">skip allowed</span>') + '</li></ul>' +
        (c[23] === '2' ? '<label for="rp-count">Pieces counted into the box</label><input id="rp-count" type="number" inputmode="numeric" value="' + (+c.slice(21, 23)) + '">' : '');
    }
    $('rp-state').innerHTML = h;
    $('rp-close').disabled = !repackReady();
    $('rp-undo').disabled = !rp.history.length;
  }
  cam('rp-cam', 'rp-reader', repackScan);
  manual('rp-manual', 'rp-manual-go', repackScan);
  $('rp-undo').onclick = function () { var it = rp.history[rp.history.length - 1]; if (it) { drop(it); $('rp-msg').innerHTML = ''; renderRepack(); } };
  $('rp-cancel').onclick = function () { if (!rp.history.length || confirm('Discard this repack?')) startRepack(); };
  $('rp-close').onclick = function () {
    var body = { clientUUID: rp.uuid, at: $('rp-at').value, bun24: rp.bun24.code, bun15: rp.bun15 ? rp.bun15.code : '', pipes: rp.pipes.map(function (x) { return x.code; }) };
    if ($('rp-count')) body.count = Number($('rp-count').value);
    $('rp-close').disabled = true; msg('rp-msg', 'info', 'Saving…');
    TRApi.call('repack', body, 45000).then(function (r) {
      if (!r.ok) { $('rp-close').disabled = false; return bad('rp-msg', '<b>Not saved.</b><br>' + (r.errors || [r.error]).map(esc).join('<br>')); }
      TRBeep('ok');
      showResult('<div class="msg ok"><b>' + esc(r.pkgType || 'Package') + ' repacked' + (r.duplicate ? ' (already saved earlier)' : '') + '</b></div>' +
        '<div class="card">' + kv([['Event', 'Packed' + (r.evtId ? ' · EVT ' + esc(r.evtId) : '')], ['SKU', esc((r.sku || '') + ' · ' + (r.skuName || ''))], ['Quantity', esc(r.qty)],
          ['At', esc(r.where)], ['When', esc(r.when)], ['QR-24', code(r.bun24 || body.bun24)], ['QR-15', (r.bun15 || body.bun15) ? code(r.bun15 || body.bun15) : 'none']]) + '</div>',
        function () { startRepack(); A.show('rep'); });
    }).catch(function (e) { $('rp-close').disabled = false; bad('rp-msg', esc(e.message) + '<br>Tap again to retry; it will not be saved twice.'); });
  };

  // =========================================================== Dashboard
  function loadDash() {
    $('db-out').innerHTML = '<div class="msg info">Loading…</div>';
    TRApi.call('dashboard', {}, 60000).then(function (d) {
      if (!d.ok) return msg('db-out', 'bad', esc(d.error));
      var pn = function (c) { return d.placeName[c] ? c + ' · ' + d.placeName[c] : c; };
      var sn = function (c) { return c ? c + ' · ' + (d.skuName[c] || '') : ''; };
      var table = function (head, rows) {
        if (!rows.length) return '<p class="muted">Nothing yet.</p>';
        return '<table class="grid"><tr>' + head.map(function (x, i) { return '<th' + (i >= head.length - 2 ? ' class="n"' : '') + '>' + x + '</th>'; }).join('') + '</tr>' +
          rows.map(function (r) { return '<tr>' + r.map(function (x, i) { return '<td' + (i >= r.length - 2 ? ' class="n"' : '') + '>' + esc(x) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table>';
      };
      var h = '<div class="big"><div><b>' + d.pipes.total + '</b><span class="muted">pipes tracked</span></div><div><b>' + d.pipes.inPackages + '</b><span class="muted">in packages</span></div><div><b>' + d.pipes.loose + '</b><span class="muted">loose</span></div></div><div style="height:12px"></div>';
      h += '<div class="card"><h2>Packages by status</h2>' + table(['Status', 'Packages', 'Pieces'], d.status.map(function (s) { return [s.key, s.packages, s.pieces]; })) + '</div>';
      h += '<div class="card"><h2>Stock by location</h2>' + table(['Location', 'SKU', 'Packages', 'Pieces'], d.stock.map(function (s) {
        var k = s.key.split('|'); return [pn(k[0]) + (k[2] === 'Awaiting inspection' ? ' (returns)' : ''), sn(k[1]), s.packages, s.pieces]; })) + '</div>';
      h += '<div class="card"><h2>Production today (' + esc(d.today) + ')</h2>' + table(['Machine', 'SKU', 'Packages', 'Pieces'], d.productionToday.map(function (s) {
        var k = s.key.split('|'); return [k[0], sn(k[1]), s.packages, s.pieces]; })) + '</div>';
      h += '<div class="card"><h2>Sales by customer</h2>' + table(['Customer', 'Packages', 'Pieces'], d.sales.map(function (s) { return [pn(s.key), s.packages, s.pieces]; })) + '</div>';
      h += '<div class="card"><h2>Latest events</h2>' + A.timeline(d.recent.slice(), true) + '</div>';
      $('db-out').innerHTML = h;
    }).catch(function (e) { msg('db-out', 'bad', esc(e.message)); });
  }
  $('db-refresh').onclick = loadDash;

  // =========================================================== entering a module
  window.addEventListener('tr-enter', function (e) {
    var v = e.detail.view;
    if (v === 'move') startMove(e.detail.arg || 'transfer');
    if (v === 'ret') startReturn();
    if (v === 'unp') startUnpack();
    if (v === 'rep') startRepack();
    if (v === 'dash') loadDash();
  });
})();
