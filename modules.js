// TraceRight prototype: Transfer, Sales, Returns, Unpack, Repack, Location Correction, Approvals, Dashboard
(function () {
  var A = window.TRApp;
  var $ = function (id) { return document.getElementById(id); };
  var esc = A.esc, msg = A.msg, kv = A.kv;
  var PKG = { '1': 'Pipe Bundle', '2': 'Fittings Box', '3': 'Agri Pipe' };
  var scanners = {};
  function hereCode() { var l = A.here(); return l ? l.code : ''; }
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
  function errs(r) { return (r.errors || [r.error || 'Not saved']).map(esc).join('<br>').replace(/\n/g, '<br>'); }
  function authLine(r) { return r.authBy ? esc(A.userName(r.authBy)) + (r.reqId ? ' (' + esc(r.reqId) + ')' : '') : ''; }

  function cam(btn, reader, onCode) {
    A.camButton(btn, reader, function () { return scanners[reader]; }, function (s) { scanners[reader] = s; }, onCode);
  }
  window.addEventListener('tr-view', function () {
    Object.keys(scanners).forEach(function (r) { var s = scanners[r]; if (s && s.running) s.stop(); });
    ['mv-cam', 'rt-cam', 'up-cam', 'rp-cam', 'lc-cam'].forEach(function (id) { $(id).textContent = 'Start camera'; });
  });
  function manual(input, btn, fn) { $(btn).onclick = function () { var v = $(input).value.trim(); if (v) { $(input).value = ''; fn(v); } }; }

  function pkgCard(p) {
    return kv([['Type', esc(p.PKG_Type.replace(/^\d = /, ''))], ['SKU', skuText(p.SKU_Code)], ['QR-24', code(p.BUN_QR24)],
      ['QR-15', p.BUN_QR15 ? code(p.BUN_QR15) : '<span class="muted">none</span>'],
      ['Status', '<b>' + esc(p.Current_Status) + '</b> · ' + esc(placeName(p.Current_Where))], ['Quantity', esc(p.Current_Qty)], ['Last event', esc(p.Last_Event_When)]]);
  }
  /** Offered whenever a package is recorded somewhere other than here. */
  function correctionButton(bun) {
    return '<div style="height:8px"></div><button class="sec" data-fixloc="' + esc(bun) + '">Request Location Correction (Manager)</button>';
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-fixloc]');
    if (!b) return;
    startCorrection(); A.show('loc'); correctionScan(b.getAttribute('data-fixloc'));
  });
  function elsewhereNote(k) {
    return 'Recorded at <b>' + esc(placeName(k.Current_Where)) + '</b>, not here (' + esc(hereCode()) + ').';
  }

  // =========================================================== Transfer & Sales (from here)
  var mv = null;
  function startMove(mode) {
    mv = { mode: mode, items: [], uuid: TRApi.uuid() };
    window.TRMoveTitle = mode === 'sales' ? 'Sales' : 'Transfer';
    var m = A.masters() || { customers: [], warehouses: [] };
    var f = '<div class="muted">' + (mode === 'sales' ? 'Dispatching from' : 'From') + '</div><b>' + esc(placeName(hereCode())) + '</b>';
    if (mode === 'transfer') {
      f += '<label for="mv-dest">Destination</label><select id="mv-dest"><option value="">Select destination</option>' + m.warehouses.filter(function (w) {
        return w.WHS_Code !== hereCode();
      }).map(function (w) { return '<option value="' + esc(w.WHS_Code) + '">' + esc(w.WHS_Code + ' · ' + w.WHS_Name) + '</option>'; }).join('') + '</select>';
      f += '<label for="mv-doc">Transfer advice no. (optional)</label><input id="mv-doc" autocomplete="off">';
    } else {
      f += '<label for="mv-cst">Customer</label><select id="mv-cst"><option value="">Select customer</option>' + m.customers.map(function (c) {
        return '<option value="' + esc(c.code) + '">' + esc(c.name + ' · ' + c.city) + '</option>';
      }).join('') + '</select>';
      f += '<div class="row"><div><label for="mv-doc">Invoice / SO no.</label><input id="mv-doc" autocomplete="off"></div>' +
        '<div><label for="mv-veh">Vehicle no.</label><input id="mv-veh" autocomplete="off"></div></div>';
    }
    $('mv-fields').innerHTML = f;
    $('mv-save').textContent = mode === 'sales' ? 'Loading complete · record Sold' : 'Loading complete · record Transfer';
    $('mv-msg').innerHTML = '';
    renderMove();
  }

  function moveScan(c) {
    var p = TR.parseQR(c);
    if (!p.ok) return bad('mv-msg', '<b>Not a valid TraceRight code.</b> ' + code(c));
    if (p.kind === 'PIPE_QR24') return bad('mv-msg', 'That is a pipe. Scan the package label (QR-24 or QR-15).');
    var dest = mv.mode === 'transfer' ? $('mv-dest').value : '';
    if (mv.mode === 'transfer' && !dest) return bad('mv-msg', 'Choose the destination first.');
    if (mv.mode === 'sales' && !$('mv-cst').value) return bad('mv-msg', 'Choose the customer first.');
    msg('mv-msg', 'info', 'Checking ' + code(c) + '…');
    TRApi.call('info', { code: c }).then(function (r) {
      if (!r.ok) return bad('mv-msg', esc(r.error));
      if (!r.found) return bad('mv-msg', '<b>Package not in the system.</b> ' + code(c));
      var k = r.package, st = k.Current_Status;
      if (mv.items.some(function (x) { return x.pkg.BUN_QR24 === k.BUN_QR24; })) { TRBeep('warn'); return msg('mv-msg', 'warn', 'This package is already in the list.'); }
      if (st === 'Sold') return bad('mv-msg', '<b>Already sold</b> to ' + esc(placeName(k.Current_Where)) + '.');
      if (st === 'Unpacked') return bad('mv-msg', '<b>Package no longer active</b> (unpacked).');
      if (st === 'Return Received' && mv.mode === 'sales') return bad('mv-msg', '<b>Return awaiting inspection.</b> Transfer it back into stock first.');
      if (mv.mode === 'transfer' && k.Current_Where === dest) return bad('mv-msg', 'Package is already at ' + esc(dest) + '.');
      var flags = [];
      if (st === 'Return Received') flags.push('return awaiting inspection');
      var away = k.Current_Where !== hereCode();
      if (away) flags.push('recorded at ' + k.Current_Where);
      mv.items.push({ pkg: k, flags: flags });
      var lvlNote = A.level() >= 2 ? 'you will be asked for a reason when you save' : 'a supervisor must authorise it when you save';
      if (away) {
        TRBeep('warn');
        msg('mv-msg', 'warn', '<b>Added, but check:</b> ' + elsewhereNote(k) + '<br>It stays in the list; ' + lvlNote +
          '. If it has simply been put here, ask a manager for a Location Correction instead.' + correctionButton(k.BUN_QR24));
      } else if (flags.length) {
        TRBeep('warn'); msg('mv-msg', 'warn', 'Added · ' + esc(flags.join(', ')) + ' · ' + lvlNote + '.');
      } else good('mv-msg', 'Added ' + esc(k.PKG_Type.replace(/^\d = /, '')) + ' · ' + esc(k.SKU_Code) + ' · qty ' + esc(k.Current_Qty));
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
        return '<li><span class="mono">' + (i + 1) + '. ' + esc(x.pkg.BUN_QR24) + '</span>' +
          (x.flags.length ? '<span class="tag pend">' + esc(x.flags.join(' · ')) + '</span>' : '<span class="tag ok">here</span>') + '</li>';
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
    var sales = mv.mode === 'sales', mode = mv.mode;
    var body = { clientUUID: mv.uuid, codes: mv.items.map(function (x) { return x.pkg.BUN_QR24; }), docRef: $('mv-doc').value.trim() };
    if (sales) {
      body.customer = $('mv-cst').value; body.vehicle = $('mv-veh').value.trim();
      if (!body.customer) return bad('mv-msg', 'Choose the customer.');
    } else body.dest = $('mv-dest').value;
    var n = mv.items.length;
    if (!confirm((sales ? 'Record ' + n + ' package(s) as Sold to ' + placeName(body.customer) : 'Record transfer of ' + n + ' package(s) to ' + placeName(body.dest)) + '?')) return;
    $('mv-save').disabled = true; msg('mv-msg', 'info', 'Saving…');
    var again = function () { startMove(mode); A.show('move'); };
    A.authCall(sales ? 'sell' : 'transfer', body, 60000).then(function (r) {
      $('mv-save').disabled = false;
      if (!r.ok) { if (A.notSaved(r, 'mv-msg', again)) return; return bad('mv-msg', '<b>Not saved.</b><br>' + errs(r)); }
      TRBeep('ok');
      A.showResult('<div class="msg ok"><b>' + (sales ? 'Sold' : 'Transferred') + (r.duplicate ? ' (already saved earlier)' : '') + '</b></div>' +
        '<div class="card">' + kv([['From', esc(placeName(r.from || hereCode()))], [sales ? 'Customer' : 'To', esc(r.whereName ? r.where + ' · ' + r.whereName : r.where)],
          ['Packages', esc(r.count)], ['Pieces', esc(r.pieces)], ['Authorised by', authLine(r)], ['When', esc(r.when)], ['Events', esc((r.evtIds || []).join(', '))]]) + '</div>', again);
    }).catch(function (e) { $('mv-save').disabled = false; bad('mv-msg', esc(e.message) + '<br>Scans kept; tap again to retry. It will not be saved twice.'); });
  };

  // =========================================================== Returns (Level 2, or with authorisation)
  var rt = null;
  function startReturn() { rt = { uuid: TRApi.uuid(), pkg: null }; $('rt-form').classList.add('hidden'); $('rt-msg').innerHTML = ''; }
  function returnScan(c) {
    var p = TR.parseQR(c);
    if (!p.ok || p.kind === 'PIPE_QR24' || p.kind === 'UNKNOWN') return bad('rt-msg', 'Scan the package label (QR-24 or QR-15).');
    msg('rt-msg', 'info', 'Checking…');
    TRApi.call('info', { code: c }).then(function (r) {
      if (!r.ok) return bad('rt-msg', esc(r.error));
      if (!r.found) return bad('rt-msg', '<b>Package not in the system.</b> If both labels are missing it must be handled as loose stock.');
      var k = r.package;
      if (k.Current_Status !== 'Sold') return bad('rt-msg', '<b>Only a sold package can be returned.</b> This one is ' + esc(k.Current_Status) + ' at ' + esc(placeName(k.Current_Where)) + '.');
      rt.pkg = k; good('rt-msg', 'Sold package found.' + (A.level() < 2 ? ' A supervisor must authorise the return when you save.' : ''));
      $('rt-form').innerHTML = '<h2>Return from ' + esc(placeName(k.Current_Where)) + '</h2>' + pkgCard(k) +
        '<label for="rt-qty">Quantity received (sold ' + esc(k.Current_Qty) + ')</label><input id="rt-qty" type="number" inputmode="numeric" min="1" max="' + esc(k.Current_Qty) + '" value="' + esc(k.Current_Qty) + '">' +
        '<label for="rt-cond">Condition</label><select id="rt-cond"><option>Intact</option><option>Damaged</option><option>Short</option></select>' +
        '<label for="rt-remark">Remark (optional)</label><input id="rt-remark" autocomplete="off">' +
        '<label for="rt-doc">Sales return / credit note no. (optional)</label><input id="rt-doc" autocomplete="off">' +
        '<div style="height:12px"></div><button class="ok" id="rt-save">Record Return Received at ' + esc(hereCode()) + '</button>';
      $('rt-form').classList.remove('hidden');
      $('rt-save').onclick = saveReturn;
    }).catch(function (e) { bad('rt-msg', esc(e.message)); });
  }
  function saveReturn() {
    var q = Number($('rt-qty').value);
    $('rt-save').disabled = true; msg('rt-msg', 'info', 'Saving…');
    var again = function () { startReturn(); A.show('ret'); };
    A.authCall('returnReceive', { clientUUID: rt.uuid, code: rt.pkg.BUN_QR24, qty: q, condition: $('rt-cond').value,
      remark: $('rt-remark').value.trim(), docRef: $('rt-doc').value.trim() }).then(function (r) {
      $('rt-save').disabled = false;
      if (!r.ok) { if (A.notSaved(r, 'rt-msg', again)) return; return bad('rt-msg', errs(r)); }
      TRBeep('ok');
      A.showResult('<div class="msg ok"><b>Return Received' + (r.duplicate ? ' (already saved earlier)' : '') + '</b></div>' +
        '<div class="card">' + kv([['Package', code(r.bun24 || rt.pkg.BUN_QR24)], ['From customer', esc(placeName(r.customer || r.from || ''))], ['Received at', esc(placeName(r.where))],
          ['Quantity', esc(r.pieces != null ? r.pieces : r.qty)], ['Condition', esc(r.condition || '')], ['Authorised by', authLine(r)], ['When', esc(r.when)]]) + '</div>' +
        '<div class="msg info">Next: if intact and complete, <b>Transfer</b> it to a saleable location (needs a supervisor). If damaged or short, <b>Unpack</b> it and repack the good pipes.</div>', again);
    }).catch(function (e) { $('rt-save').disabled = false; bad('rt-msg', esc(e.message)); });
  }
  cam('rt-cam', 'rt-reader', returnScan);
  manual('rt-manual', 'rt-manual-go', returnScan);

  // =========================================================== Unpack (Level 2, or with authorisation)
  var up = null;
  function startUnpack() { up = { uuid: TRApi.uuid(), pkg: null }; $('up-form').classList.add('hidden'); $('up-msg').innerHTML = ''; }
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
      up.pkg = k;
      var away = k.Current_Where !== hereCode();
      if (away) { TRBeep('warn'); msg('up-msg', 'warn', elsewhereNote(k) + ' Unpacking it here needs a reason.' + correctionButton(k.BUN_QR24)); }
      else good('up-msg', 'Package found.' + (A.level() < 2 ? ' A supervisor must authorise unpacking when you save.' : ''));
      var chk = k.BUN_QR24[23];
      $('up-form').innerHTML = '<h2>Unpack this package?</h2>' + pkgCard(k) +
        (chk === '1' ? '<p class="muted">All ' + esc(k.Current_Qty) + ' pipes are released as loose stock at ' + esc(hereCode()) + '. They keep their QR and can go into a new bundle with Repack.</p>' :
          chk === '3' ? '<p class="muted">Agri pipe: the virtual bundle ends. The pipe has no pipe QR; it can only re-enter with a new Agri repack label.</p>' :
          '<p class="muted">Fittings box: contents become loose stock (not tracked individually).</p>') +
        '<label for="up-cause">Cause</label><select id="up-cause"><option>Damaged package</option><option>Return inspection failed</option><option>Mixed / wrong SKU</option><option>Re-bundling</option><option>Other</option></select>' +
        '<label for="up-remark">Remark (optional)</label><input id="up-remark" autocomplete="off">' +
        '<div style="height:12px"></div><button class="danger" id="up-save">Unpack (cannot be undone)</button>';
      $('up-form').classList.remove('hidden');
      $('up-save').onclick = saveUnpack;
    }).catch(function (e) { bad('up-msg', esc(e.message)); });
  }
  function saveUnpack() {
    if (!confirm('Unpack ' + up.pkg.BUN_QR24 + '? This cannot be undone and its labels can never be reused.')) return;
    $('up-save').disabled = true; msg('up-msg', 'info', 'Saving…');
    var again = function () { startUnpack(); A.show('unp'); };
    A.authCall('unpack', { clientUUID: up.uuid, code: up.pkg.BUN_QR24, cause: $('up-cause').value, remark: $('up-remark').value.trim() }).then(function (r) {
      $('up-save').disabled = false;
      if (!r.ok) { if (A.notSaved(r, 'up-msg', again)) return; return bad('up-msg', errs(r)); }
      TRBeep('ok');
      A.showResult('<div class="msg ok"><b>Unpacked' + (r.duplicate ? ' (already saved earlier)' : '') + '</b></div>' +
        '<div class="card">' + kv([['Package', code(r.bun24 || up.pkg.BUN_QR24)], ['At', esc(placeName(r.where))], ['Pieces released', esc(r.pieces != null ? r.pieces : r.qty)],
          ['Pipe memberships closed', esc(r.released != null ? r.released : '')], ['Authorised by', authLine(r)], ['When', esc(r.when)]]) + '</div>', again);
    }).catch(function (e) { $('up-save').disabled = false; bad('up-msg', esc(e.message)); });
  }
  cam('up-cam', 'up-reader', unpackScan);
  manual('up-manual', 'up-manual-go', unpackScan);

  // =========================================================== Repack (here)
  var rp = null;
  function startRepack() {
    rp = { uuid: TRApi.uuid(), mode: null, pipes: [], bun24: null, bun15: null, sku: null, history: [] };
    $('rp-msg').innerHTML = ''; renderRepack();
  }
  function locNo() { var l = A.here(); return l && l.locNo ? l.locNo : ''; }
  function repackScan(c) {
    var p = TR.parseQR(c);
    if (!p.ok) return bad('rp-msg', '<b>Not a valid TraceRight code.</b> ' + code(c));
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
      if (c.slice(7, 9) !== locNo()) return bad('rp-msg', 'Label is for location ' + esc(c.slice(7, 9)) + '; you are at ' + esc(hereCode()) + ' (location ' + esc(locNo()) + ').');
      if (!s2 || String(s2.PKG_Check) !== chk) return bad('rp-msg', 'Label SKU / check digit do not match SKU_Master.');
      var note = '';
      if (chk === '1') {
        if (rp.mode !== 'pipe' || !rp.pipes.length) return bad('rp-msg', 'Scan the loose pipes first.');
        if (rp.pipes.some(function (x) { return x.status !== 'ok'; })) return bad('rp-msg', 'Wait until every pipe shows a green tick.');
        if (part !== rp.sku.ERP_Part) return bad('rp-msg', 'Label is ' + esc(s2.SKU_Code) + '; pipes are ' + esc(rp.sku.SKU_Code) + '.');
        if (qty !== rp.pipes.length) return bad('rp-msg', 'Label quantity is ' + ('0' + qty).slice(-2) + ' but ' + rp.pipes.length + ' pipes scanned.');
        if (qty < A.target()) note = 'Short bundle: needs a supervisor (or a reason, if you are one) when you save.';
      } else {
        if (rp.mode === 'pipe') return bad('rp-msg', 'This is a ' + PKG[chk] + ' label. Cancel the pipe repack first.');
        if (chk === '3') note = 'Agri repack: needs a supervisor (or a reason, if you are one) when you save.';
        rp.mode = 'box'; rp.sku = s2;
      }
      rp.bun24 = { code: c, status: 'pend', note: note }; rp.history.push(rp.bun24); renderRepack();
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
      if (r.ok && !r.used) { item.status = 'ok'; if (item.note) { TRBeep('warn'); msg('rp-msg', 'warn', 'New label OK. ' + esc(item.note)); } else good('rp-msg', 'New label OK.'); }
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
    if (!rp.mode) h = '<h2>Repack from loose stock</h2><p class="muted">Pipe bundle: scan the loose pipes, then a <b>repack</b> QR-24 for location ' + esc(locNo()) + ' and its QR-15.<br>Fittings box or Agri pipe: scan its repack QR-24; QR-15 optional.</p>';
    else if (rp.mode === 'pipe') {
      h = '<div class="counter">' + rp.pipes.length + ' loose pipe' + (rp.pipes.length === 1 ? '' : 's') + '</div><div class="muted">' + (rp.sku ? esc(rp.sku.SKU_Code + ' · ' + rp.sku.SKU_Description) : '') +
        ' · full bundle ' + A.target() + (rp.pipes.length < A.target() ? ' (short bundles need a supervisor)' : '') + '</div><ul class="list">' + rp.pipes.map(function (x, i) {
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
    var body = { clientUUID: rp.uuid, bun24: rp.bun24.code, bun15: rp.bun15 ? rp.bun15.code : '', pipes: rp.pipes.map(function (x) { return x.code; }) };
    if ($('rp-count')) body.count = Number($('rp-count').value);
    $('rp-close').disabled = true; msg('rp-msg', 'info', 'Saving…');
    var again = function () { startRepack(); A.show('rep'); };
    A.authCall('repack', body, 45000).then(function (r) {
      $('rp-close').disabled = false;
      if (!r.ok) { if (A.notSaved(r, 'rp-msg', again)) return; return bad('rp-msg', '<b>Not saved.</b><br>' + errs(r)); }
      TRBeep('ok');
      A.showResult('<div class="msg ok"><b>' + esc(r.pkgType || 'Package') + ' repacked' + (r.duplicate ? ' (already saved earlier)' : '') + '</b></div>' +
        '<div class="card">' + kv([['Event', 'Packed' + (r.evtId ? ' · EVT ' + esc(r.evtId) : '')], ['SKU', r.sku ? esc(r.sku + ' · ' + (r.skuName || '')) : ''], ['Quantity', esc(r.qty)],
          ['At', esc(placeName(r.where))], ['Authorised by', authLine(r)], ['When', esc(r.when)], ['QR-24', code(r.bun24 || body.bun24)], ['QR-15', (r.bun15 || body.bun15) ? code(r.bun15 || body.bun15) : 'none']]) + '</div>', again);
    }).catch(function (e) { $('rp-close').disabled = false; bad('rp-msg', esc(e.message) + '<br>Tap again to retry; it will not be saved twice.'); });
  };

  // =========================================================== Location Correction (Level 3, or with authorisation)
  var lc = null;
  function startCorrection() { lc = { uuid: TRApi.uuid(), pkg: null }; $('lc-form').classList.add('hidden'); $('lc-msg').innerHTML = ''; }
  function correctionScan(c) {
    var p = TR.parseQR(c);
    if (!p.ok || p.kind === 'PIPE_QR24' || p.kind === 'UNKNOWN') return bad('lc-msg', 'Scan the package label (QR-24 or QR-15).');
    msg('lc-msg', 'info', 'Checking…');
    TRApi.call('info', { code: c }).then(function (r) {
      if (!r.ok) return bad('lc-msg', esc(r.error));
      if (!r.found) return bad('lc-msg', '<b>Package not in the system.</b>');
      var k = r.package;
      if (k.Current_Status === 'Sold') return bad('lc-msg', '<b>Recorded as sold</b> to ' + esc(placeName(k.Current_Where)) + '. Use Returns, not Location Correction.');
      if (k.Current_Status === 'Unpacked') return bad('lc-msg', '<b>Package was unpacked.</b> It cannot be corrected.');
      if (k.Current_Where === hereCode()) { TRBeep('ok'); $('lc-form').classList.add('hidden'); return msg('lc-msg', 'ok', 'Already recorded here (' + esc(hereCode()) + '). No correction needed.'); }
      lc.pkg = k; TRBeep('warn');
      msg('lc-msg', 'warn', elsewhereNote(k));
      $('lc-form').innerHTML = '<h2>Correct the location</h2>' + pkgCard(k) +
        kv([['Expected (recorded)', '<b>' + esc(placeName(k.Current_Where)) + '</b>'], ['Actual (found here)', '<b>' + esc(placeName(hereCode())) + '</b>']]) +
        '<p class="muted">This is not a transfer. It records where the package really is. Status stays ' + esc(k.Current_Status) + '.' +
        (A.level() < 3 ? ' A manager must authorise it: on this phone, or from the Approvals inbox.' : '') + '</p>' +
        '<label for="lc-reason">Why is it here? (required)</label><textarea id="lc-reason" rows="2"></textarea>' +
        '<div style="height:12px"></div><button class="ok" id="lc-save">Record Location Corrected</button>';
      $('lc-form').classList.remove('hidden');
      $('lc-save').onclick = saveCorrection;
    }).catch(function (e) { bad('lc-msg', esc(e.message)); });
  }
  function saveCorrection() {
    var reason = $('lc-reason').value.trim();
    if (!reason) return bad('lc-msg', 'Enter why the package is here.');
    $('lc-save').disabled = true; msg('lc-msg', 'info', 'Saving…');
    var again = function () { startCorrection(); A.show('loc'); };
    A.authCall('locationCorrect', { clientUUID: lc.uuid, code: lc.pkg.BUN_QR24, reason: reason }).then(function (r) {
      $('lc-save').disabled = false;
      if (!r.ok) { if (A.notSaved(r, 'lc-msg', again)) return; return bad('lc-msg', errs(r)); }
      TRBeep('ok');
      A.showResult('<div class="msg ok"><b>Location Corrected' + (r.duplicate ? ' (already saved earlier)' : '') + '</b></div>' +
        '<div class="card">' + kv([['Package', code(r.bun24 || lc.pkg.BUN_QR24)], ['Expected', esc(placeName(r.from))], ['Actual', esc(placeName(r.where))],
          ['Authorised by', authLine(r)], ['When', esc(r.when)], ['Event', esc((r.evtIds || []).join(', '))]]) + '</div>' +
        '<div class="msg info">The package is now recorded here and can be transferred or sold normally.</div>', again);
    }).catch(function (e) { $('lc-save').disabled = false; bad('lc-msg', esc(e.message)); });
  }
  cam('lc-cam', 'lc-reader', correctionScan);
  manual('lc-manual', 'lc-manual-go', correctionScan);

  // =========================================================== Approvals inbox (Level 2 and 3)
  function reqCard(q, actions) {
    return '<div class="card req ' + esc(q.status) + '"><h2>' + esc(q.reqId) + ' · ' + esc(q.actionName) + ' <span class="tag">' + esc(q.status) + '</span></h2>' +
      kv([['Needs', 'Level ' + esc(q.need) + ' · ' + esc(A.LEVEL[q.need])], ['Asked by', esc(q.byName) + ' at ' + esc(q.location)], ['When', esc(q.created)],
        ['Request', esc(q.summary)], ['Reason', esc(q.reason)], ['Decided', q.decidedAt ? esc(A.userName(q.decidedBy)) + ' · ' + esc(q.decidedAt) : ''],
        ['Note', esc(q.note)], ['Result', esc(q.result)]]) + (actions || '') + '</div>';
  }
  function loadInbox() {
    $('ib-out').innerHTML = '<div class="msg info">Loading…</div>';
    TRApi.call('inbox', {}).then(function (r) {
      if (!r.ok) return msg('ib-out', 'bad', esc(r.error));
      var h = '<h2>' + r.pending.length + ' waiting for you</h2>';
      if (!r.pending.length) h += '<p class="muted">Nothing to approve.</p>';
      h += r.pending.map(function (q) {
        return reqCard(q, '<label for="ib-note-' + esc(q.reqId) + '">Note (optional)</label><input id="ib-note-' + esc(q.reqId) + '" autocomplete="off">' +
          '<div style="height:8px"></div><div class="row"><button class="ok" data-decide="' + esc(q.reqId) + '" data-ok="1">Approve</button>' +
          '<button class="danger" data-decide="' + esc(q.reqId) + '">Reject</button></div>');
      }).join('');
      if (r.waitingHigher) h += '<p class="muted">' + r.waitingHigher + ' more request(s) need a manager.</p>';
      if (r.decided.length) h += '<h2 style="margin-top:16px">Recently decided by you</h2>' + r.decided.map(function (q) { return reqCard(q); }).join('');
      $('ib-out').innerHTML = h;
    }).catch(function (e) { msg('ib-out', 'bad', esc(e.message)); });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-decide]');
    if (!b) return;
    var id = b.getAttribute('data-decide'), ok = !!b.getAttribute('data-ok');
    if (!confirm((ok ? 'Approve ' : 'Reject ') + id + '?' + (ok ? ' The action is saved now, after checking the current data.' : ''))) return;
    b.disabled = true; msg('ib-msg', 'info', 'Saving…');
    TRApi.call('authDecide', { reqId: id, approve: ok, note: ($('ib-note-' + id) || {}).value || '' }, 60000).then(function (r) {
      if (r.ok) { TRBeep('ok'); msg('ib-msg', 'ok', '<b>' + esc(id) + ' ' + esc(r.status) + '.</b>' + (r.evtIds ? ' Saved as EVT ' + esc(r.evtIds.join(', ')) + '.' : '')); }
      else { TRBeep('bad'); msg('ib-msg', 'bad', esc(r.error).replace(/\n/g, '<br>')); }
      loadInbox();
    }).catch(function (e) { b.disabled = false; bad('ib-msg', esc(e.message)); });
  });
  $('ib-refresh').onclick = function () { $('ib-msg').innerHTML = ''; loadInbox(); };

  // =========================================================== My requests
  function loadMine() {
    $('mr-out').innerHTML = '<div class="msg info">Loading…</div>';
    TRApi.call('myRequests', {}).then(function (r) {
      if (!r.ok) return msg('mr-out', 'bad', esc(r.error));
      $('mr-out').innerHTML = r.requests.length ? r.requests.map(function (q) {
        return reqCard(q, q.status === 'Pending' ? '<div style="height:8px"></div><button class="sec" data-cancelreq="' + esc(q.reqId) + '">Cancel request</button>' : '');
      }).join('') : '<p class="muted">You have not sent any requests.</p>';
    }).catch(function (e) { msg('mr-out', 'bad', esc(e.message)); });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-cancelreq]');
    if (!b) return;
    var id = b.getAttribute('data-cancelreq');
    if (!confirm('Cancel ' + id + '?')) return;
    TRApi.call('authCancel', { reqId: id }).then(function (r) {
      msg('mr-msg', r.ok ? 'ok' : 'bad', r.ok ? esc(id) + ' cancelled.' : esc(r.error)); loadMine();
    }).catch(function (e) { bad('mr-msg', esc(e.message)); });
  });
  $('mr-refresh').onclick = function () { $('mr-msg').innerHTML = ''; loadMine(); };

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
      var h = '<div class="big"><div><b>' + d.pipes.total + '</b><span class="muted">pipes tracked</span></div><div><b>' + d.pipes.inPackages + '</b><span class="muted">in packages</span></div><div><b>' + d.pipes.loose + '</b><span class="muted">loose</span></div></div><div style="height:10px"></div>';
      h += '<div class="big"><div><b>' + d.pendingRequests + '</b><span class="muted">approvals pending</span></div><div><b>' + d.authorisedEvents + '</b><span class="muted">authorised events</span></div><div><b>' + d.corrections.length + '</b><span class="muted">location corrections</span></div></div><div style="height:12px"></div>';
      h += '<div class="card"><h2>Packages by status</h2>' + table(['Status', 'Packages', 'Pieces'], d.status.map(function (s) { return [s.key, s.packages, s.pieces]; })) + '</div>';
      h += '<div class="card"><h2>Stock by location</h2>' + table(['Location', 'SKU', 'Packages', 'Pieces'], d.stock.map(function (s) {
        var k = s.key.split('|'); return [pn(k[0]) + (k[2] === 'Awaiting inspection' ? ' (returns)' : ''), sn(k[1]), s.packages, s.pieces]; })) + '</div>';
      h += '<div class="card"><h2>Production today (' + esc(d.today) + ')</h2>' + table(['Machine', 'SKU', 'Packages', 'Pieces'], d.productionToday.map(function (s) {
        var k = s.key.split('|'); return [k[0], sn(k[1]), s.packages, s.pieces]; })) + '</div>';
      h += '<div class="card"><h2>Transfers</h2>' + table(['From → To', 'Packages', 'Pieces'], d.transfers.map(function (s) { return [s.key, s.packages, s.pieces]; })) + '</div>';
      h += '<div class="card"><h2>Sales by customer</h2>' + table(['Customer', 'Packages', 'Pieces'], d.sales.map(function (s) { return [pn(s.key), s.packages, s.pieces]; })) + '</div>';
      h += '<div class="card"><h2>Location corrections (not transfers)</h2>' + (d.corrections.length ? A.timeline(d.corrections.slice(), true) : '<p class="muted">None.</p>') + '</div>';
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
    if (v === 'loc') startCorrection();
    if (v === 'inbox') { $('ib-msg').innerHTML = ''; loadInbox(); }
    if (v === 'myreq') { $('mr-msg').innerHTML = ''; loadMine(); }
    if (v === 'dash') loadDash();
  });
})();
