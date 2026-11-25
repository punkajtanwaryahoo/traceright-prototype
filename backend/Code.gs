/**
 * TraceRight prototype backend (Google Apps Script web app)
 * Database: Google Sheet "PPSPL Database on Sheets"
 *
 * Deploy: Extensions > Apps Script > paste this file > Deploy > New deployment >
 *         Web app, Execute as: Me, Who has access: Anyone.
 *
 * The phone app calls this with POST (Content-Type text/plain) and a JSON body:
 *   { "action": "...", "token": "...", ...payload }
 * Every reply is JSON: { ok: true, ... } or { ok: false, error: "message" }.
 */

var SHEET_ID = '16xXpgZybYOijfmOCCjbF-inQQyziryx1XGNzEWbSUF8';
var TZ = 'Asia/Kolkata';
var VERSION = '0.2.0';
var TOKEN_HOURS = 12;

// Column positions (1-based) for the transaction tabs
var COL = {
  PIP_Identity:   ['PIP_QR24','Prod_Date','FTY_Code','MAC_Code','ERP_Part','SKU_Code','Side','Serial_No','Created_At','Created_By'],
  PIP_Membership: ['MEM_ID','PIP_QR24','BUN_QR24','From_Event','From_When','To_Event','To_When','Status','USR_Code'],
  BUN_Package:    ['BUN_QR24','BUN_QR15','PKG_Type','Origin_Event','Origin_Date','FTY_Code','MAC_or_Loc','SKU_Code','Packed_Qty','Current_Status','Current_Where','Current_Qty','Last_Event_When'],
  BUN_Event:      ['EVT_ID','Client_UUID','BUN_QR24','Event','Where','When','Item_Qty','Doc_Ref','USR_Code','Reason','Corrects_EVT'],
  QR_Labels:      ['Label_Code','Label_Type','Print_Batch','Printed_At','Printed_By','SKU_Code','MAC_or_Loc','Sheet_Row','Status','Used_At']
};
var PKG_NAMES = { '1': 'Pipe Bundle', '2': 'Fittings Box', '3': 'Agri Pipe' };

// ---------------------------------------------------------------- entry points

function doGet(e) {
  return json_({ ok: true, app: 'TraceRight backend', version: VERSION, serverTime: now_() });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Request is not valid JSON' });
  }
  try {
    var handlers = {
      ping: apiPing_,
      masters: apiMasters_,
      login: apiLogin_,
      checkCode: apiCheckCode_,
      lookup: apiLookup_,
      closePackage: apiClosePackage_,
      reserveLabels: apiReserveLabels_,
      info: apiInfo_,
      transfer: apiTransfer_,
      sell: apiSell_,
      returnReceive: apiReturnReceive_,
      unpack: apiUnpack_,
      repack: apiRepack_,
      dashboard: apiDashboard_
    };
    var fn = handlers[req.action];
    if (!fn) return json_({ ok: false, error: 'Unknown action: ' + req.action });
    var publicActions = { ping: 1, masters: 1, login: 1 };
    var user = null;
    if (!publicActions[req.action]) {
      user = verifyToken_(req.token);
      if (!user) return json_({ ok: false, error: 'Please log in again', code: 'AUTH' });
    }
    return json_(fn(req, user));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/** Run once from the editor (Run > setup) to authorise and check the tabs. */
function setup() {
  var ss = ss_();
  var need = ['SKU_Master','MAC_Master','WHS_Master','CST_Master','USR_Master','PIP_Identity','PIP_Membership','BUN_Package','BUN_Event','QR_Labels','CONFIG'];
  var missing = need.filter(function (n) { return !ss.getSheetByName(n); });
  secret_();
  Logger.log(missing.length ? 'Missing tabs: ' + missing.join(', ') : 'All tabs found. Backend ready, version ' + VERSION);
}

// ---------------------------------------------------------------- API

function apiPing_() {
  return { ok: true, version: VERSION, serverTime: now_() };
}

function apiMasters_() {
  var users = readTable_('USR_Master').filter(isActive_('USR_Active')).map(function (u) {
    return { code: u.USR_Code, name: u.USR_Name, role: u.USR_Role, access: u.USR_Access };   // never send PINs
  });
  return {
    ok: true,
    users: users,
    skus: readTable_('SKU_Master').filter(isActive_('SKU_Active')),
    machines: readTable_('MAC_Master').filter(isActive_('MAC_Active')),
    warehouses: readTable_('WHS_Master').filter(isActive_('WHS_Active')),
    customers: readTable_('CST_Master').filter(isActive_('CST_Active')).map(function (c) {
      return { code: c.CST_Code, name: c.CST_Name, city: c.City, state: c.State };
    }),
    pipeBundleQty: Number(config_('Pipe_Bundle_Qty')) || 6,
    serverDate: today_()
  };
}

function apiLogin_(req) {
  var code = String(req.usr || '').trim();
  var pin = String(req.pin || '').trim();
  var u = readTable_('USR_Master').filter(function (r) { return r.USR_Code === code; })[0];
  if (!u || String(u.USR_Active).toUpperCase() !== 'YES') return { ok: false, error: 'User not found or inactive' };
  if (String(u.USR_PIN) !== pin) return { ok: false, error: 'Wrong PIN' };
  var exp = Date.now() + TOKEN_HOURS * 3600 * 1000;
  var payload = u.USR_Code + '|' + u.USR_Access + '|' + exp;
  var token = payload + '|' + sign_(payload);
  return { ok: true, token: token, user: { code: u.USR_Code, name: u.USR_Name, role: u.USR_Role, access: u.USR_Access }, expires: exp };
}

/** Is this code already used? role: 'pipe' | 'bun24' | 'bun15' */
function apiCheckCode_(req) {
  var code = String(req.code || '').trim();
  var res = { ok: true, code: code, used: false };
  if (req.role === 'pipe') res.used = existsIn_('PIP_Identity', 1, code);
  else if (req.role === 'bun24') res.used = existsIn_('BUN_Package', 1, code);
  else if (req.role === 'bun15') res.used = existsIn_('BUN_Package', 2, code);
  else return { ok: false, error: 'Unknown role' };
  return res;
}

/** Scan anything, get its story. */
function apiLookup_(req) {
  var code = String(req.code || '').trim();
  var p = parseQR_(code);
  var out = { ok: true, code: code, kind: p.kind, decoded: p, found: false };

  if (p.kind === 'PIPE_QR24') {
    var pip = findRow_('PIP_Identity', 1, code);
    if (pip) {
      out.found = true;
      out.pipe = pip.obj;
      out.memberships = filterRows_('PIP_Membership', 2, code);
      var active = out.memberships.filter(function (m) { return m.Status === 'Active'; })[0];
      if (active) {
        out.currentPackage = (findRow_('BUN_Package', 1, active.BUN_QR24) || {}).obj || null;
        out.events = filterRows_('BUN_Event', 3, active.BUN_QR24);
      }
    }
  } else if (p.kind === 'BUNDLE_QR24' || p.kind === 'BUNDLE_QR15') {
    var pk = findRow_('BUN_Package', p.kind === 'BUNDLE_QR24' ? 1 : 2, code);
    if (pk) {
      out.found = true;
      out.package = pk.obj;
      out.events = filterRows_('BUN_Event', 3, pk.obj.BUN_QR24);
      out.pipes = filterRows_('PIP_Membership', 3, pk.obj.BUN_QR24);
    }
  }
  if (!out.found) {
    var lab = findRow_('QR_Labels', 1, code);
    if (lab) out.label = lab.obj;
  }
  var skuCode = (out.package && out.package.SKU_Code) || (out.pipe && out.pipe.SKU_Code) || '';
  var skus = readTable_('SKU_Master');
  out.sku = skus.filter(function (s) { return skuCode ? s.SKU_Code === skuCode : s.ERP_Part === p.erpPart; })[0] || null;
  return out;
}

/**
 * Close a package (Primary Pack, event = Produced).
 * req: { clientUUID, bun24, bun15 (optional for check 2/3), pipes: [PIP_QR24 x N] (check 1 only) }
 */
function apiClosePackage_(req, user) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    // Idempotency: same clientUUID already saved -> return the earlier result
    if (req.clientUUID) {
      var prev = findRow_('BUN_Event', 2, String(req.clientUUID));
      if (prev) return { ok: true, duplicate: true, evtId: Number(prev.obj.EVT_ID), bun24: prev.obj.BUN_QR24, message: 'Already saved earlier' };
    }

    var errors = [], warnings = [];
    var bun24 = String(req.bun24 || '').trim();
    var bun15 = String(req.bun15 || '').trim();
    var pipes = (req.pipes || []).map(function (s) { return String(s).trim(); });

    var b = parseQR_(bun24);
    if (b.kind !== 'BUNDLE_QR24' || !b.ok) return fail_(['Package label QR-24 is not valid: ' + (b.errors.join('; ') || b.kind)]);
    var chk = b.check;
    if (b.factory === '0') return fail_(['This is a repack label (factory digit 0). Use Repack, not Primary Pack.']);
    var sku = skuByPart_()[b.erpPart];
    if (!sku) errors.push('SKU part ' + b.erpPart + ' is not in SKU_Master');
    else if (String(sku.PKG_Check) !== chk) errors.push('Label check digit ' + chk + ' does not match SKU ' + sku.SKU_Code + ' (' + sku.SKU_Category + ', expects ' + sku.PKG_Check + ')');
    if (existsIn_('BUN_Package', 1, bun24)) errors.push('Package label QR-24 has already been used');

    // QR-15
    if (bun15) {
      var q = parseQR_(bun15);
      if (q.kind !== 'BUNDLE_QR15' || !q.ok) errors.push('QR-15 is not valid: ' + (q.errors.join('; ') || q.kind));
      else if (existsIn_('BUN_Package', 2, bun15)) errors.push('QR-15 has already been used');
    } else if (chk === '1') {
      errors.push('QR-15 is mandatory for a Pipe Bundle');
    }

    // Pipes
    var qty;
    var bundleQty = Number(config_('Pipe_Bundle_Qty')) || 6;
    if (chk === '1') {
      if (pipes.length !== bundleQty) errors.push('A Pipe Bundle needs ' + bundleQty + ' pipes; ' + pipes.length + ' scanned');
      if (b.qty !== bundleQty) errors.push('Bundle label quantity is ' + pad_(b.qty, 2) + ' but should be ' + pad_(bundleQty, 2));
      var seen = {};
      pipes.forEach(function (pc, i) {
        var pp = parseQR_(pc);
        if (pp.kind !== 'PIPE_QR24' || !pp.ok) { errors.push('Pipe ' + (i + 1) + ' is not a valid pipe QR'); return; }
        if (seen[pc]) errors.push('Pipe ' + (i + 1) + ' was scanned twice');
        seen[pc] = 1;
        if (pp.erpPart !== b.erpPart) errors.push('Pipe ' + (i + 1) + ' is SKU part ' + pp.erpPart + ', bundle label is ' + b.erpPart);
        if (pp.machine !== b.machine) warnings.push('Pipe ' + (i + 1) + ' is from machine ' + pp.machine + ', bundle label says ' + b.machine);
        if (existsIn_('PIP_Identity', 1, pc)) errors.push('Pipe ' + (i + 1) + ' (' + pc + ') is already in another bundle');
        if (pp.yymmdd !== today_('yyMMdd')) warnings.push('Pipe ' + (i + 1) + ' label is dated ' + pp.date + ', not today');
      });
      qty = pipes.length;
    } else {
      if (pipes.length) errors.push('Fittings Boxes and Agri Pipes do not take pipe scans');
      if (chk === '3' && b.qty !== 1) errors.push('Agri Pipe quantity must be 01');
      if (b.qty < 1) errors.push('Quantity on the label must be at least 01');
      qty = b.qty;
    }
    if (b.yymmdd !== today_('yyMMdd')) warnings.push('Package label is dated ' + b.date + ', not today');
    if (errors.length) return fail_(errors, warnings);

    // ---- write
    var when = now_();
    var mac = 'MAC-' + b.factory + '-' + b.machine;
    var usr = user.code;

    if (chk === '1') {
      var pipRows = pipes.map(function (pc) {
        var pp = parseQR_(pc);
        return [pc, pp.date, pp.factory, pp.machine, pp.erpPart, sku.SKU_Code, pp.side, pp.serial, when, usr];
      });
      appendRows_('PIP_Identity', pipRows);
      var memId = nextCounter_('Next_MEM_ID', pipes.length);
      var memRows = pipes.map(function (pc, i) {
        return [memId + i, pc, bun24, 'Produced', when, '', '', 'Active', usr];
      });
      appendRows_('PIP_Membership', memRows);
    }

    appendRows_('BUN_Package', [[bun24, bun15, chk + ' = ' + PKG_NAMES[chk], 'Produced', b.date, b.factory, b.machine,
      sku.SKU_Code, qty, 'Produced', mac, qty, when]]);

    var evtId = nextCounter_('Next_EVT_ID', 1);
    appendRows_('BUN_Event', [[evtId, String(req.clientUUID || ''), bun24, 'Produced', mac, when, qty, '', usr,
      warnings.join(' | '), '']]);

    markLabelsUsed_([bun24, bun15].concat(pipes).filter(String), when);

    return { ok: true, evtId: evtId, bun24: bun24, bun15: bun15, pkgType: PKG_NAMES[chk], sku: sku.SKU_Code,
             skuName: sku.SKU_Description, qty: qty, where: mac, when: when, warnings: warnings };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Reserve today's demo labels and record them in QR_Labels.
 * req.kind: 'pipes'   -> 10 pipe bundles: 60 pipe QRs + 10 bundle QR-24 + 10 QR-15
 *           'fittings'-> 5 fittings boxes: QR-24 + QR-15
 *           'agri'    -> 3 agri pipes:     QR-24 + QR-15
 */
function apiReserveLabels_(req, user) {
  var plans = {
    pipes: [
      ['SKU0001', '01'], ['SKU0001', '01'], ['SKU0002', '01'], ['SKU0002', '01'],
      ['SKU0003', '02'], ['SKU0003', '02'], ['SKU0004', '02'], ['SKU0004', '02'],
      ['SKU0005', '02'], ['SKU0005', '02']
    ],
    fittings: [['SKU0021', '10'], ['SKU0022', '10'], ['SKU0023', '10'], ['SKU0024', '10'], ['SKU0025', '10']],
    agri: [['SKU0031', '20'], ['SKU0032', '20'], ['SKU0033', '20']]
  };
  if (req.kind === 'repack') return reserveRepackLabels_(req, user);
  var plan = plans[req.kind];
  if (!plan) return { ok: false, error: 'Unknown label set: ' + req.kind };

  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var skus = {};
    readTable_('SKU_Master').forEach(function (s) { skus[s.SKU_Code] = s; });
    var fty = String(config_('FTY_Code') || '1');
    var ymd = today_('yyMMdd');
    var bundleQty = Number(config_('Pipe_Bundle_Qty')) || 6;
    var batch = req.kind.toUpperCase() + '-' + today_('yyyyMMdd-HHmmss');
    var when = now_();
    var rows = [], labelRows = [];

    plan.forEach(function (p, i) {
      var s = skus[p[0]];
      var mac = p[1];
      var chk = String(s.PKG_Check);
      var qty = chk === '1' ? bundleQty : Number(s.STD_Qty);
      var row = { row: i + 1, sku: s.SKU_Code, skuName: s.SKU_Description, machine: mac, pkgType: PKG_NAMES[chk], pipes: [] };

      if (chk === '1') {
        var first = nextDaily_('PIPE', ymd, mac, bundleQty);
        for (var k = 0; k < bundleQty; k++) {
          var pc = ymd + fty + mac + s.ERP_Part + '1' + pad_(first + k, 5) + '0';
          row.pipes.push(pc);
          labelRows.push([pc, 'PIPE_QR24', batch, when, user.code, s.SKU_Code, mac, 'Bundle ' + (i + 1) + ' pipe ' + (k + 1), 'Printed', '']);
        }
      }
      var bs = nextDaily_('BUN', ymd, mac, 1);
      row.bun24 = ymd + fty + mac + s.ERP_Part + pad_(bs, 4) + pad_(qty, 2) + chk;
      row.bun15 = String(config_('QR15_Prefix') || 'T') + String(config_('QR15_Year') || '2026') + pad_(nextCounter_('Next_QR15_Serial', 1), 10);
      labelRows.push([row.bun24, 'BUNDLE_QR24', batch, when, user.code, s.SKU_Code, mac, 'Row ' + (i + 1), 'Printed', '']);
      labelRows.push([row.bun15, 'BUNDLE_QR15', batch, when, user.code, s.SKU_Code, mac, 'Row ' + (i + 1), 'Printed', '']);
      rows.push(row);
    });
    appendRows_('QR_Labels', labelRows);
    return { ok: true, kind: req.kind, batch: batch, date: today_('dd-MMM-yyyy'), printedBy: user.name || user.code, rows: rows };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- Phase 2 modules (MOD003-MOD007)

var IN_STOCK = { 'Produced': 1, 'Packed': 1, 'Transferred': 1 };

/** Package or pipe summary for a scanned code (used while building a scan session). */
function apiInfo_(req) {
  var code = String(req.code || '').trim();
  var p = parseQR_(code);
  var out = { ok: true, code: code, kind: p.kind, valid: p.ok, errors: p.errors };
  if (p.kind === 'PIPE_QR24') {
    var pip = findRow_('PIP_Identity', 1, code);
    out.found = !!pip;
    if (pip) {
      out.pipe = pip.obj;
      var act = filterRows_('PIP_Membership', 2, code).filter(function (m) { return m.Status === 'Active'; })[0];
      out.activeBundle = act ? act.BUN_QR24 : '';
      out.loose = !act;
    }
  } else if (p.kind === 'BUNDLE_QR24' || p.kind === 'BUNDLE_QR15') {
    var pk = pkgByCode_(code);
    out.found = !!pk;
    if (pk) out.package = pk.obj;
  }
  return out;
}

/** MOD003 Transfer: move intact packages to another company location. */
function apiTransfer_(req, user) {
  return withLock_(function () {
    var dup = alreadySaved_(req.clientUUID);
    if (dup) return dup;
    var dest = whsByCode_(req.dest);
    if (!dest) return fail_(['Choose a destination location']);
    var codes = uniqueCodes_(req.codes);
    if (!codes.length) return fail_(['No packages scanned']);
    var errors = [], pk = [];
    codes.forEach(function (c, i) {
      var k = pkgByCode_(c);
      var label = 'Package ' + (i + 1) + ' (' + c + ')';
      if (!k) return errors.push(label + ' is not in the system');
      var st = k.obj.Current_Status;
      if (st === 'Sold') return errors.push(label + ' is already sold');
      if (st === 'Unpacked') return errors.push(label + ' is no longer active (unpacked)');
      if (st === 'Return Received' && Number(user.access) < 2) return errors.push(label + ' is a return awaiting inspection; a supervisor must transfer it');
      if (!IN_STOCK[st] && st !== 'Return Received') return errors.push(label + ' has status ' + st);
      if (k.obj.Current_Where === dest.WHS_Code) return errors.push(label + ' is already at ' + dest.WHS_Code);
      if (pk.some(function (x) { return x.obj.BUN_QR24 === k.obj.BUN_QR24; })) return errors.push(label + ' was scanned twice (QR-24 and QR-15)');
      pk.push(k);
    });
    if (errors.length) return fail_(errors);
    var when = now_();
    var res = writeEvents_(pk, 'Transferred', dest.WHS_Code, when, user, req, function (k) {
      return 'From ' + k.obj.Current_Where;
    });
    return { ok: true, event: 'Transferred', where: dest.WHS_Code, whereName: dest.WHS_Name, count: pk.length, pieces: res.pieces, evtIds: res.ids, when: when };
  });
}

/** MOD004 Sales: packages leave a company location for a customer. */
function apiSell_(req, user) {
  return withLock_(function () {
    var dup = alreadySaved_(req.clientUUID);
    if (dup) return dup;
    var from = whsByCode_(req.from);
    var cst = readTable_('CST_Master').filter(function (c) { return c.CST_Code === req.customer; })[0];
    if (!from) return fail_(['Choose the dispatching location']);
    if (!cst) return fail_(['Choose the customer']);
    var override = !!req.override && Number(user.access) >= 2;
    var codes = uniqueCodes_(req.codes);
    if (!codes.length) return fail_(['No packages scanned']);
    var errors = [], warnings = [], pk = [];
    codes.forEach(function (c, i) {
      var k = pkgByCode_(c);
      var label = 'Package ' + (i + 1) + ' (' + c + ')';
      if (!k) return errors.push(label + ' is not in the system');
      var st = k.obj.Current_Status;
      if (st === 'Sold') return errors.push(label + ' is already sold');
      if (st === 'Unpacked') return errors.push(label + ' is no longer active (unpacked)');
      if (st === 'Return Received') return errors.push(label + ' is a return awaiting inspection');
      if (!IN_STOCK[st]) return errors.push(label + ' has status ' + st);
      if (k.obj.Current_Where !== from.WHS_Code) {
        if (override) warnings.push(label + ' was recorded at ' + k.obj.Current_Where + ' (supervisor override)');
        else return errors.push(label + ' is recorded at ' + k.obj.Current_Where + ', not ' + from.WHS_Code);
      }
      if (pk.some(function (x) { return x.obj.BUN_QR24 === k.obj.BUN_QR24; })) return errors.push(label + ' was scanned twice (QR-24 and QR-15)');
      pk.push(k);
    });
    if (errors.length) return fail_(errors, warnings);
    var when = now_();
    var res = writeEvents_(pk, 'Sold', cst.CST_Code, when, user, req, function (k) {
      var r = 'From ' + from.WHS_Code + (req.vehicle ? ' · vehicle ' + req.vehicle : '');
      return k.obj.Current_Where !== from.WHS_Code ? r + ' · override: was at ' + k.obj.Current_Where : r;
    });
    return { ok: true, event: 'Sold', where: cst.CST_Code, whereName: cst.CST_Name, count: pk.length, pieces: res.pieces, evtIds: res.ids, when: when, warnings: warnings };
  });
}

/** MOD005 Returns: a sold package comes back to a company location. Supervisor only. */
function apiReturnReceive_(req, user) {
  if (Number(user.access) < 2) return fail_(['Returns can be received only by a supervisor']);
  return withLock_(function () {
    var dup = alreadySaved_(req.clientUUID);
    if (dup) return dup;
    var at = whsByCode_(req.at);
    if (!at) return fail_(['Choose the receiving location']);
    var k = pkgByCode_(String(req.code || '').trim());
    if (!k) return fail_(['Package is not in the system']);
    if (k.obj.Current_Status !== 'Sold') return fail_(['Only a sold package can be returned. Current status: ' + k.obj.Current_Status]);
    var sold = Number(k.obj.Current_Qty);
    var qty = Number(req.qty);
    if (!(qty >= 1 && qty <= sold)) return fail_(['Quantity received must be between 1 and ' + sold]);
    var cond = String(req.condition || 'Intact');
    var when = now_();
    var reason = 'From customer ' + k.obj.Current_Where + ' · ' + cond + (qty < sold ? ' · short ' + (sold - qty) : '') + (req.reason ? ' · ' + req.reason : '');
    var res = writeEvents_([k], 'Return Received', at.WHS_Code, when, user, req, function () { return reason; }, qty);
    return { ok: true, event: 'Return Received', where: at.WHS_Code, whereName: at.WHS_Name, count: 1, pieces: qty, evtIds: res.ids, when: when,
             bun24: k.obj.BUN_QR24, customer: k.obj.Current_Where, condition: cond };
  });
}

/** MOD006 Unpacked: open a package; its pipes become loose stock. Supervisor only. */
function apiUnpack_(req, user) {
  if (Number(user.access) < 2) return fail_(['Only a supervisor can unpack']);
  return withLock_(function () {
    var dup = alreadySaved_(req.clientUUID);
    if (dup) return dup;
    var at = whsByCode_(req.at);
    if (!at) return fail_(['Choose the location where the package is opened']);
    var k = pkgByCode_(String(req.code || '').trim());
    if (!k) return fail_(['Package is not in the system']);
    var st = k.obj.Current_Status;
    if (st === 'Unpacked') return fail_(['Package is already unpacked']);
    if (st === 'Sold') return fail_(['Package is with the customer. Receive it first using Returns.']);
    var when = now_();
    var members = filterRows_('PIP_Membership', 3, k.obj.BUN_QR24).filter(function (m) { return m.Status === 'Active'; });
    var sh = sh_('PIP_Membership');
    members.forEach(function (m) { sh.getRange(m._row, 6, 1, 3).setValues([['Unpacked', when, 'Closed']]); });
    var res = writeEvents_([k], 'Unpacked', at.WHS_Code, when, user, req, function () {
      return (req.reason || 'Unpacked') + (req.remark ? ' · ' + req.remark : '') + ' · was ' + st + ' at ' + k.obj.Current_Where;
    }, 0);
    return { ok: true, event: 'Unpacked', where: at.WHS_Code, whereName: at.WHS_Name, count: 1, pieces: Number(k.obj.Current_Qty),
             released: members.length, evtIds: res.ids, when: when, bun24: k.obj.BUN_QR24, pkgType: k.obj.PKG_Type };
  });
}

/** MOD007 Packed: build a new package from loose stock using a repack label (factory digit 0). */
function apiRepack_(req, user) {
  return withLock_(function () {
    var dup = alreadySaved_(req.clientUUID);
    if (dup) return dup;
    var at = whsByCode_(req.at);
    if (!at) return fail_(['Choose the location where you are repacking']);
    var bun24 = String(req.bun24 || '').trim(), bun15 = String(req.bun15 || '').trim();
    var pipes = uniqueCodes_(req.pipes);
    var b = parseQR_(bun24), errors = [], warnings = [];
    if (b.kind !== 'BUNDLE_QR24' || !b.ok) return fail_(['New package label QR-24 is not valid']);
    if (b.factory !== '0') errors.push('This is a production label. Repack needs a repack label (factory digit 0)');
    if (b.machine !== String(at.Loc_No)) errors.push('Label is for location ' + b.machine + '; ' + at.WHS_Code + ' is location ' + at.Loc_No);
    var sku = skuByPart_()[b.erpPart];
    var chk = b.check;
    if (!sku) errors.push('SKU part ' + b.erpPart + ' is not in SKU_Master');
    else if (String(sku.PKG_Check) !== chk) errors.push('Label check digit does not match SKU ' + sku.SKU_Code);
    if (existsIn_('BUN_Package', 1, bun24)) errors.push('New QR-24 has already been used');
    if (bun15) {
      var q = parseQR_(bun15);
      if (q.kind !== 'BUNDLE_QR15' || !q.ok) errors.push('QR-15 is not valid');
      else if (existsIn_('BUN_Package', 2, bun15)) errors.push('QR-15 has already been used');
    } else if (chk === '1') errors.push('QR-15 is mandatory for a Pipe Bundle');
    var full = Number(config_('Pipe_Bundle_Qty')) || 6;
    var qty;
    if (chk === '1') {
      if (!pipes.length) errors.push('Scan the loose pipes first');
      pipes.forEach(function (pc, i) {
        var label = 'Pipe ' + (i + 1);
        var pp = parseQR_(pc);
        if (pp.kind !== 'PIPE_QR24') return errors.push(label + ' is not a pipe QR');
        if (!existsIn_('PIP_Identity', 1, pc)) return errors.push(label + ' is not in the system (never bundled)');
        if (filterRows_('PIP_Membership', 2, pc).some(function (m) { return m.Status === 'Active'; })) return errors.push(label + ' still belongs to an active package');
        if (pp.erpPart !== b.erpPart) errors.push(label + ' is SKU part ' + pp.erpPart + ', label is ' + b.erpPart);
      });
      if (pipes.length !== b.qty) errors.push('Label quantity is ' + pad_(b.qty, 2) + ' but ' + pipes.length + ' pipes scanned');
      if (pipes.length < full && Number(user.access) < 2) errors.push('A short bundle (' + pipes.length + ' of ' + full + ') needs a supervisor');
      qty = pipes.length;
    } else {
      if (pipes.length) errors.push('Fittings Boxes and Agri Pipes take no pipe scans');
      if (chk === '3' && Number(user.access) < 2) errors.push('Agri Pipe repack needs a supervisor');
      if (chk === '3' && b.qty !== 1) errors.push('Agri Pipe quantity must be 01');
      if (req.count != null && Number(req.count) !== b.qty) errors.push('Counted ' + req.count + ' pieces but the label says ' + pad_(b.qty, 2));
      qty = b.qty;
    }
    if (errors.length) return fail_(errors, warnings);
    var when = now_();
    if (pipes.length) {
      var memId = nextCounter_('Next_MEM_ID', pipes.length);
      appendRows_('PIP_Membership', pipes.map(function (pc, i) { return [memId + i, pc, bun24, 'Packed', when, '', '', 'Active', user.code]; }));
    }
    appendRows_('BUN_Package', [[bun24, bun15, chk + ' = ' + PKG_NAMES[chk], 'Packed', b.date, '0', b.machine, sku.SKU_Code, qty, 'Packed', at.WHS_Code, qty, when]]);
    var evtId = nextCounter_('Next_EVT_ID', 1);
    appendRows_('BUN_Event', [[evtId, req.clientUUID ? String(req.clientUUID) + '#1' : '', bun24, 'Packed', at.WHS_Code, when, qty, String(req.docRef || ''), user.code,
      'Repacked from loose stock' + (pipes.length && pipes.length < full ? ' · short bundle' : ''), '']]);
    markLabelsUsed_([bun24, bun15].filter(String), when);
    return { ok: true, event: 'Packed', evtId: evtId, bun24: bun24, bun15: bun15, pkgType: PKG_NAMES[chk], sku: sku.SKU_Code, skuName: sku.SKU_Description,
             qty: qty, where: at.WHS_Code, when: when };
  });
}

/** Repack labels: factory digit 0, digits 8-9 = location number. */
function reserveRepackLabels_(req, user) {
  var at = whsByCode_(req.at);
  if (!at) return { ok: false, error: 'Choose a location' };
  var s = readTable_('SKU_Master').filter(function (x) { return x.SKU_Code === req.sku; })[0];
  if (!s) return { ok: false, error: 'Choose an SKU' };
  var n = Math.max(1, Math.min(10, Number(req.rows) || 5));
  var chk = String(s.PKG_Check);
  var qty = chk === '3' ? 1 : Number(req.qty) || (chk === '1' ? Number(config_('Pipe_Bundle_Qty')) || 6 : Number(s.STD_Qty));
  if (qty < 1 || qty > 99) return { ok: false, error: 'Quantity must be 1-99' };
  return withLock_(function () {
    var ymd = today_('yyMMdd'), loc = pad_(at.Loc_No, 2), when = now_();
    var batch = 'REPACK-' + today_('yyyyMMdd-HHmmss');
    var rows = [], labelRows = [];
    for (var i = 0; i < n; i++) {
      var bs = nextDaily_('BUN', ymd, 'R' + loc, 1);
      var r = { row: i + 1, sku: s.SKU_Code, skuName: s.SKU_Description, machine: loc, location: at.WHS_Code, pkgType: PKG_NAMES[chk], pipes: [] };
      r.bun24 = ymd + '0' + loc + s.ERP_Part + pad_(bs, 4) + pad_(qty, 2) + chk;
      r.bun15 = String(config_('QR15_Prefix') || 'T') + String(config_('QR15_Year') || '2026') + pad_(nextCounter_('Next_QR15_Serial', 1), 10);
      labelRows.push([r.bun24, 'BUNDLE_QR24', batch, when, user.code, s.SKU_Code, at.WHS_Code, 'Repack row ' + (i + 1), 'Printed', '']);
      labelRows.push([r.bun15, 'BUNDLE_QR15', batch, when, user.code, s.SKU_Code, at.WHS_Code, 'Repack row ' + (i + 1), 'Printed', '']);
      rows.push(r);
    }
    appendRows_('QR_Labels', labelRows);
    return { ok: true, kind: 'repack', batch: batch, date: today_('dd-MMM-yyyy'), printedBy: user.name || user.code, location: at.WHS_Code + ' · ' + at.WHS_Name, rows: rows };
  });
}

/** Simple dashboard figures. */
function apiDashboard_() {
  var pk = readTable_('BUN_Package'), ev = readTable_('BUN_Event'), mem = readTable_('PIP_Membership');
  var skuName = {}; readTable_('SKU_Master').forEach(function (s) { skuName[s.SKU_Code] = s.SKU_Description; });
  var placeName = {};
  readTable_('WHS_Master').forEach(function (w) { placeName[w.WHS_Code] = w.WHS_Name; });
  readTable_('CST_Master').forEach(function (c) { placeName[c.CST_Code] = c.CST_Name; });
  var today = today_();
  function group(rows, keyFn, qtyFn) {
    var m = {};
    rows.forEach(function (r) { var k = keyFn(r); m[k] = m[k] || { key: k, packages: 0, pieces: 0 }; m[k].packages++; m[k].pieces += Number(qtyFn(r)) || 0; });
    return Object.keys(m).sort().map(function (k) { return m[k]; });
  }
  var status = group(pk, function (r) { return r.Current_Status; }, function (r) { return r.Current_Qty; });
  var stockRows = pk.filter(function (r) { return IN_STOCK[r.Current_Status] || r.Current_Status === 'Return Received'; });
  var stock = group(stockRows, function (r) { return r.Current_Where + '|' + r.SKU_Code + '|' + (r.Current_Status === 'Return Received' ? 'Awaiting inspection' : 'Saleable'); }, function (r) { return r.Current_Qty; });
  var prodToday = group(ev.filter(function (e) { return e.Event === 'Produced' && e.When.slice(0, 10) === today; }), function (e) {
    var p = pk.filter(function (x) { return x.BUN_QR24 === e.BUN_QR24; })[0] || {};
    return e.Where + '|' + (p.SKU_Code || '');
  }, function (e) { return e.Item_Qty; });
  var sales = group(ev.filter(function (e) { return e.Event === 'Sold'; }), function (e) { return e.Where; }, function (e) { return e.Item_Qty; });
  var active = {}, seen = {};
  mem.forEach(function (m) { seen[m.PIP_QR24] = 1; if (m.Status === 'Active') active[m.PIP_QR24] = 1; });
  var loose = Object.keys(seen).filter(function (p) { return !active[p]; }).length;
  var recent = ev.slice(-15).reverse();
  return { ok: true, today: today, status: status, stock: stock, productionToday: prodToday, sales: sales,
           pipes: { total: Object.keys(seen).length, inPackages: Object.keys(active).length, loose: loose },
           recent: recent, skuName: skuName, placeName: placeName };
}

// ---- helpers for phase 2

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function alreadySaved_(uuid) {
  if (!uuid) return null;
  var prev = findRow_('BUN_Event', 2, String(uuid) + '#1');
  return prev ? { ok: true, duplicate: true, message: 'Already saved earlier', event: prev.obj.Event, where: prev.obj.Where, when: prev.obj.When } : null;
}
function uniqueCodes_(list) {
  var seen = {}, out = [];
  (list || []).forEach(function (c) { c = String(c).trim(); if (c && !seen[c]) { seen[c] = 1; out.push(c); } });
  return out;
}
function pkgByCode_(code) {
  var p = parseQR_(code);
  if (p.kind === 'BUNDLE_QR24') return findRow_('BUN_Package', 1, code);
  if (p.kind === 'BUNDLE_QR15') return findRow_('BUN_Package', 2, code);
  return null;
}
function whsByCode_(code) {
  return readTable_('WHS_Master').filter(function (w) { return w.WHS_Code === code && String(w.WHS_Active).toUpperCase() === 'YES'; })[0] || null;
}
/** One event per package + package status update. qtyOverride sets the new current quantity. */
function writeEvents_(pkgs, event, where, when, user, req, reasonFn, qtyOverride) {
  var first = nextCounter_('Next_EVT_ID', pkgs.length);
  var sh = sh_('BUN_Package'), pieces = 0, ids = [];
  var rows = pkgs.map(function (k, i) {
    var qty = qtyOverride != null ? qtyOverride : Number(k.obj.Current_Qty);
    var itemQty = event === 'Unpacked' ? Number(k.obj.Current_Qty) : qty;
    pieces += itemQty;
    ids.push(first + i);
    var row = [first + i, String(req.clientUUID || '') + '#' + (i + 1), k.obj.BUN_QR24, event, where, when, itemQty,
      String(req.docRef || ''), user.code, reasonFn ? reasonFn(k) : '', ''];
    sh.getRange(k.row, 10, 1, 4).setValues([[event, where, qty, when]]);
    return row;
  });
  appendRows_('BUN_Event', rows);
  return { pieces: pieces, ids: ids };
}

// ---------------------------------------------------------------- QR decoding (16-Nov-2026 scheme)

function parseQR_(raw) {
  var s = String(raw || '').trim();
  var o = { raw: s, kind: 'UNKNOWN', ok: false, errors: [] };
  if (/^\d{24}$/.test(s)) {
    o.yymmdd = s.slice(0, 6);
    o.date = '20' + s.slice(0, 2) + '-' + s.slice(2, 4) + '-' + s.slice(4, 6);
    o.factory = s[6];
    o.machine = s.slice(7, 9);
    o.erpPart = s.slice(9, 17);
    o.check = s[23];
    var mm = +s.slice(2, 4), dd = +s.slice(4, 6), yy = +s.slice(0, 2);
    if (yy < 26 || mm < 1 || mm > 12 || dd < 1 || dd > new Date(2000 + yy, mm, 0).getDate()) o.errors.push('Invalid date');
    if (o.check === '0') {
      o.kind = 'PIPE_QR24';
      o.side = s[17];
      o.serial = s.slice(18, 23);
      if (o.side !== '0' && o.side !== '1') o.errors.push('Side digit must be 0 or 1');
      if (o.factory === '0') o.errors.push('Pipe factory digit cannot be 0');
    } else if (o.check === '1' || o.check === '2' || o.check === '3') {
      o.kind = 'BUNDLE_QR24';
      o.serial = s.slice(17, 21);
      o.qty = +s.slice(21, 23);
    } else {
      o.errors.push('Check digit must be 0, 1, 2 or 3');
    }
  } else if (/^[A-Z]\d{14}$/.test(s)) {
    o.kind = 'BUNDLE_QR15';
    o.year = +s.slice(1, 5);
    if (o.year <= 2025 || o.year >= 2099) o.errors.push('Year must be 2026-2098');
  } else {
    o.errors.push('Not a TraceRight code');
  }
  o.ok = o.kind !== 'UNKNOWN' && o.errors.length === 0;
  return o;
}

// ---------------------------------------------------------------- sheet helpers

function ss_() { return SpreadsheetApp.openById(SHEET_ID); }
function sh_(name) { return ss_().getSheetByName(name); }

function readTable_(name) {
  var v = sh_(name).getDataRange().getDisplayValues();
  var h = v.shift() || [];
  return v.filter(function (r) { return r.join('') !== ''; }).map(function (r) {
    var o = {}; h.forEach(function (k, i) { o[k] = r[i]; }); return o;
  });
}

function isActive_(col) { return function (r) { return String(r[col]).toUpperCase() === 'YES'; }; }

function existsIn_(name, col, value) {
  if (!value) return false;
  var sh = sh_(name), last = sh.getLastRow();
  if (last < 2) return false;
  return !!sh.getRange(2, col, last - 1, 1).createTextFinder(value).matchEntireCell(true).findNext();
}

function findRow_(name, col, value) {
  if (!value) return null;
  var sh = sh_(name), last = sh.getLastRow();
  if (last < 2) return null;
  var cell = sh.getRange(2, col, last - 1, 1).createTextFinder(value).matchEntireCell(true).findNext();
  if (!cell) return null;
  var r = cell.getRow();
  var vals = sh.getRange(r, 1, 1, COL[name].length).getDisplayValues()[0];
  var o = {}; COL[name].forEach(function (k, i) { o[k] = vals[i]; });
  return { row: r, obj: o };
}

function filterRows_(name, col, value) {
  var sh = sh_(name), last = sh.getLastRow();
  if (last < 2 || !value) return [];
  var cells = sh.getRange(2, col, last - 1, 1).createTextFinder(value).matchEntireCell(true).findAll();
  return cells.map(function (c) {
    var vals = sh.getRange(c.getRow(), 1, 1, COL[name].length).getDisplayValues()[0];
    var o = { _row: c.getRow() }; COL[name].forEach(function (k, i) { o[k] = vals[i]; }); return o;
  });
}

function appendRows_(name, rows) {
  if (!rows.length) return;
  var sh = sh_(name);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function markLabelsUsed_(codes, when) {
  var sh = sh_('QR_Labels'), last = sh.getLastRow();
  if (last < 2) return;
  codes.forEach(function (c) {
    var cell = sh.getRange(2, 1, last - 1, 1).createTextFinder(c).matchEntireCell(true).findNext();
    if (cell) sh.getRange(cell.getRow(), 9, 1, 2).setValues([['Used', when]]);
  });
}

// CONFIG: key in column A, value in column B
function configRow_(key) {
  var sh = sh_('CONFIG'), last = sh.getLastRow();
  var cell = sh.getRange(1, 1, last, 1).createTextFinder(key).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : 0;
}
function config_(key) {
  var r = configRow_(key);
  return r ? sh_('CONFIG').getRange(r, 2).getValue() : '';
}
/** Returns the current value and advances it by n (call only inside the lock). */
function nextCounter_(key, n) {
  var r = configRow_(key);
  if (!r) throw new Error('CONFIG key missing: ' + key);
  var c = sh_('CONFIG').getRange(r, 2);
  var v = Number(c.getValue()) || 1;
  c.setValue(v + n);
  return v;
}
/** Daily serial per type/date/machine; returns first serial of a block of n. */
function nextDaily_(type, ymd, mac, n) {
  var key = 'SER|' + type + '|' + ymd + '|' + mac;
  var sh = sh_('CONFIG');
  var r = configRow_(key);
  if (!r) {
    sh.appendRow([key, 0, 'Last ' + type.toLowerCase() + ' serial used on ' + ymd + ' for machine/location ' + mac]);
    r = sh.getLastRow();
  }
  var c = sh.getRange(r, 2);
  var last = Number(c.getValue()) || 0;
  c.setValue(last + n);
  return last + 1;
}

// ---------------------------------------------------------------- auth

function secret_() {
  var p = PropertiesService.getScriptProperties();
  var s = p.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('TOKEN_SECRET', s); }
  return s;
}
function sign_(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, secret_()));
}
function verifyToken_(token) {
  if (!token) return null;
  var parts = String(token).split('|');
  if (parts.length !== 4) return null;
  var payload = parts.slice(0, 3).join('|');
  if (sign_(payload) !== parts[3]) return null;
  if (Date.now() > Number(parts[2])) return null;
  var u = readTable_('USR_Master').filter(function (r) { return r.USR_Code === parts[0]; })[0];
  if (!u || String(u.USR_Active).toUpperCase() !== 'YES') return null;
  return { code: u.USR_Code, name: u.USR_Name, role: u.USR_Role, access: u.USR_Access };
}

// ---------------------------------------------------------------- misc

function skuByPart_() {
  var m = {};
  readTable_('SKU_Master').forEach(function (s) { m[s.ERP_Part] = s; });
  return m;
}
function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function today_(fmt) { return Utilities.formatDate(new Date(), TZ, fmt || 'yyyy-MM-dd'); }
function pad_(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
function fail_(errors, warnings) { return { ok: false, error: errors.join('\n'), errors: errors, warnings: warnings || [] }; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
