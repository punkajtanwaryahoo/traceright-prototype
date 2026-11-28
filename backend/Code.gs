/**
 * TraceRight prototype backend (Google Apps Script web app)
 * Database: Google Sheet "PPSPL Database on Sheets"
 *
 * Deploy: Extensions > Apps Script > paste this file > Deploy > Manage deployments >
 *         Edit (pencil) > Version: New version > Deploy.  (First time: New deployment,
 *         Web app, Execute as: Me, Who has access: Anyone.)
 *
 * The phone app calls this with POST (Content-Type text/plain) and a JSON body:
 *   { "action": "...", "token": "...", ...payload }
 * Every reply is JSON: { ok: true, ... } or { ok: false, error: "message" }.
 *
 * v0.3: location declared at login (signed into the token), From/To events,
 *       production goes to the factory's WIP Store, Location Corrected (Level 3),
 *       one authorisation method for every check: on-device approver PIN or a
 *       remote request approved from the Inbox.
 */

var SHEET_ID = '16xXpgZybYOijfmOCCjbF-inQQyziryx1XGNzEWbSUF8';
var TZ = 'Asia/Kolkata';
var VERSION = '0.3.0';
var TOKEN_HOURS = 12;
var PIN_TRIES = 5, PIN_LOCK_MIN = 15;

// Column positions (1-based) for the transaction tabs
var COL = {
  PIP_Identity:   ['PIP_QR24','Prod_Date','FTY_Code','MAC_Code','ERP_Part','SKU_Code','Side','Serial_No','Created_At','Created_By'],
  PIP_Membership: ['MEM_ID','PIP_QR24','BUN_QR24','From_Event','From_When','To_Event','To_When','Status','USR_Code'],
  BUN_Package:    ['BUN_QR24','BUN_QR15','PKG_Type','Origin_Event','Origin_Date','FTY_Code','MAC_or_Loc','SKU_Code','Packed_Qty','Current_Status','Current_Where','Current_Qty','Last_Event_When'],
  BUN_Event:      ['EVT_ID','Client_UUID','BUN_QR24','Event','From_Where','To_Where','When','Item_Qty','Doc_Ref','USR_Code','Auth_By','Auth_Ref','Reason','Corrects_EVT'],
  QR_Labels:      ['Label_Code','Label_Type','Print_Batch','Printed_At','Printed_By','SKU_Code','MAC_or_Loc','Sheet_Row','Status','Used_At'],
  AUTH_Requests:  ['REQ_ID','Created_At','Requested_By','Location','Action','Need_Level','Summary','Reason','Payload','Status','Decided_By','Decided_At','Decision_Note','Result']
};
var PKG_NAMES = { '1': 'Pipe Bundle', '2': 'Fittings Box', '3': 'Agri Pipe' };
var LEVEL_NAMES = { 1: 'Operator', 2: 'Supervisor', 3: 'Manager' };
var ACTION_NAMES = { closePackage: 'Primary Pack', transfer: 'Transfer', sell: 'Sales', returnReceive: 'Return Received',
  unpack: 'Unpack', repack: 'Repack', locationCorrect: 'Location Correction' };

// ---------------------------------------------------------------- entry points

function doGet(e) {
  return json_({ ok: true, app: 'TraceRight backend', version: VERSION, serverTime: now_() });
}

/** Actions that write stock events. Each can be authorised on the device or remotely. */
var PROTECTED = {
  closePackage: function (r, c) { return apiClosePackage_(r, c); },
  transfer: function (r, c) { return apiTransfer_(r, c); },
  sell: function (r, c) { return apiSell_(r, c); },
  returnReceive: function (r, c) { return apiReturnReceive_(r, c); },
  unpack: function (r, c) { return apiUnpack_(r, c); },
  repack: function (r, c) { return apiRepack_(r, c); },
  locationCorrect: function (r, c) { return apiLocationCorrect_(r, c); }
};

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Request is not valid JSON' });
  }
  try {
    var handlers = {
      ping: apiPing_, masters: apiMasters_, login: apiLogin_,
      checkCode: apiCheckCode_, lookup: apiLookup_, reserveLabels: apiReserveLabels_, info: apiInfo_, dashboard: apiDashboard_,
      authRequest: apiAuthRequest_, inbox: apiInbox_, myRequests: apiMyRequests_, authDecide: apiAuthDecide_, authCancel: apiAuthCancel_
    };
    var fn = handlers[req.action] || PROTECTED[req.action];
    if (!fn) return json_({ ok: false, error: 'Unknown action: ' + req.action });
    var publicActions = { ping: 1, masters: 1, login: 1 };
    if (publicActions[req.action]) return json_(fn(req, null));
    var user = verifyToken_(req.token);
    if (!user) return json_({ ok: false, error: 'Please log in again', code: 'AUTH' });
    var ctx = { user: user, loc: user.loc, level: Number(user.access), authBy: '', authRef: '' };
    if (PROTECTED[req.action] && req.auth) {
      var ap = approverCheck_(req.auth, user);
      if (!ap.ok) return json_({ ok: false, needAuth: true, authError: ap.error, error: ap.error });
      ctx.level = Number(ap.user.access);
      ctx.authBy = ap.user.code;
    }
    return json_(fn(req, ctx));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/** Run once from the editor (Run > setup) to authorise and check the tabs. */
function setup() {
  var ss = ss_();
  var need = ['SKU_Master','MAC_Master','WHS_Master','CST_Master','USR_Master','PIP_Identity','PIP_Membership','BUN_Package','BUN_Event','QR_Labels','AUTH_Requests','CONFIG'];
  var missing = need.filter(function (n) { return !ss.getSheetByName(n); });
  secret_();
  Logger.log(missing.length ? 'Missing tabs: ' + missing.join(', ') : 'All tabs found. Backend ready, version ' + VERSION);
}

// ---------------------------------------------------------------- authorisation framework

/**
 * Every rule that needs a higher level adds a need: { level, why, exception }.
 * exception = true means the action is out of the ordinary (stock recorded elsewhere,
 * wrong machine, short bundle...) and a reason is always required.
 * Returns null when the action may go ahead, otherwise the reply to send.
 */
function need_(needs, level, why, exception) { needs.push({ level: level, why: why, exception: !!exception }); }

function gate_(ctx, req, needs, warnings) {
  var lvl = 1, exc = false, why = [];
  needs.forEach(function (n) { lvl = Math.max(lvl, n.level); exc = exc || n.exception; why.push(n.why); });
  var base = { need: lvl, needName: LEVEL_NAMES[lvl], why: why, warnings: warnings || [] };
  if (lvl > ctx.level) {
    return merge_(base, { ok: false, needAuth: true,
      error: 'Needs Level ' + lvl + ' (' + LEVEL_NAMES[lvl] + ') authorisation:\n' + why.join('\n') });
  }
  if (ctx.dry) return merge_(base, { ok: true, dry: true });
  if ((exc || ctx.authBy) && !String(req.reason || '').trim()) {
    return merge_(base, { ok: false, needReason: true, error: 'A reason is required:\n' + why.join('\n') });
  }
  return null;
}

/** Checks an approver's name and PIN for on-device authorisation. The PIN is used once and never stored. */
function approverCheck_(auth, requester) {
  var u = userByCode_(String(auth.usr || ''));
  if (!u || String(u.USR_Active).toUpperCase() !== 'YES') return { ok: false, error: 'Approver not found' };
  if (u.USR_Code === requester.code) return { ok: false, error: 'You cannot authorise your own action. Ask a supervisor or manager.' };
  if (Number(u.USR_Access) <= Number(requester.access)) return { ok: false, error: u.USR_Name + ' does not have a higher access level than you' };
  var p = pinCheck_(u, String(auth.pin || ''));
  if (!p.ok) return p;
  return { ok: true, user: { code: u.USR_Code, name: u.USR_Name, role: u.USR_Role, access: u.USR_Access } };
}

/** PIN check with lock-out: PIN_TRIES wrong PINs in a row lock the user for PIN_LOCK_MIN minutes. */
function pinCheck_(u, pin) {
  var props = PropertiesService.getScriptProperties();
  var key = 'PINFAIL|' + u.USR_Code;
  var st = {};
  try { st = JSON.parse(props.getProperty(key) || '{}'); } catch (e) { st = {}; }
  if (st.until && Date.now() < st.until) {
    return { ok: false, error: u.USR_Name + ' is locked for ' + Math.ceil((st.until - Date.now()) / 60000) + ' more minute(s) after ' + PIN_TRIES + ' wrong PINs' };
  }
  if (String(u.USR_PIN) === pin) { props.setProperty(key, '{}'); return { ok: true }; }
  var n = (st.n || 0) + 1;
  if (n >= PIN_TRIES) { props.setProperty(key, JSON.stringify({ n: 0, until: Date.now() + PIN_LOCK_MIN * 60000 })); return { ok: false, error: 'Wrong PIN. ' + u.USR_Name + ' is now locked for ' + PIN_LOCK_MIN + ' minutes' }; }
  props.setProperty(key, JSON.stringify({ n: n }));
  return { ok: false, error: 'Wrong PIN (' + (PIN_TRIES - n) + ' tries left)' };
}

/** Remote route, step 1: save the action as a request for a supervisor or manager. */
function apiAuthRequest_(req, ctx) {
  var action = String(req.forAction || '');
  if (!PROTECTED[action]) return { ok: false, error: 'This action cannot be sent for approval' };
  var reason = String(req.reason || '').trim();
  if (!reason) return { ok: false, error: 'Enter the reason for the request' };
  var payload = cleanPayload_(req.payload || {});
  payload.reason = reason;
  var dry = PROTECTED[action](payload, { user: ctx.user, loc: ctx.loc, level: Number(ctx.user.access), authBy: '', authRef: '', dry: true });
  if (dry.ok && dry.dry) return { ok: false, error: 'No approval is needed. You can save this yourself.' };
  if (!dry.needAuth) return dry;
  return withLock_(function () {
    var n = nextCounter_('Next_AUTH_ID', 1);
    var id = 'REQ-' + pad_(n, 4);
    var summary = ACTION_NAMES[action] + ': ' + summary_(action, payload, ctx.loc) + ' — ' + dry.why.join('; ');
    appendRows_('AUTH_Requests', [[id, now_(), ctx.user.code, ctx.loc.type + '|' + ctx.loc.code, action, String(dry.need), summary, reason,
      JSON.stringify(payload), 'Pending', '', '', '', '']]);
    return { ok: true, requested: true, reqId: id, need: dry.need, needName: LEVEL_NAMES[dry.need], summary: summary };
  });
}

/** Pending requests a supervisor or manager may decide, plus their recent decisions. */
function apiInbox_(req, ctx) {
  var lvl = Number(ctx.user.access);
  if (lvl < 2) return { ok: false, error: 'The Inbox is for supervisors and managers' };
  var rows = authRows_();
  var pending = rows.filter(function (r) { return r.Status === 'Pending' && Number(r.Need_Level) <= lvl && r.Requested_By !== ctx.user.code; });
  var decided = rows.filter(function (r) { return r.Decided_By === ctx.user.code; }).slice(-10).reverse();
  var waitingHigher = rows.filter(function (r) { return r.Status === 'Pending' && Number(r.Need_Level) > lvl; }).length;
  return { ok: true, pending: pending.map(reqOut_), decided: decided.map(reqOut_), waitingHigher: waitingHigher };
}

function apiMyRequests_(req, ctx) {
  var rows = authRows_().filter(function (r) { return r.Requested_By === ctx.user.code; }).slice(-20).reverse();
  return { ok: true, requests: rows.map(reqOut_) };
}

function apiAuthCancel_(req, ctx) {
  return withLock_(function () {
    var r = findRow_('AUTH_Requests', 1, String(req.reqId || ''));
    if (!r) return { ok: false, error: 'Request not found' };
    if (r.obj.Requested_By !== ctx.user.code) return { ok: false, error: 'Only the person who asked can cancel a request' };
    if (r.obj.Status !== 'Pending') return { ok: false, error: 'Request is already ' + r.obj.Status };
    sh_('AUTH_Requests').getRange(r.row, 10, 1, 5).setValues([['Cancelled', ctx.user.code, now_(), 'Cancelled by requester', '']]);
    return { ok: true, reqId: r.obj.REQ_ID, status: 'Cancelled' };
  });
}

/** Remote route, step 2: approve (runs the action again with today's data) or reject. */
function apiAuthDecide_(req, ctx) {
  var approver = ctx.user, lvl = Number(approver.access);
  if (lvl < 2) return { ok: false, error: 'Only a supervisor or manager can decide requests' };
  var r = findRow_('AUTH_Requests', 1, String(req.reqId || ''));
  if (!r) return { ok: false, error: 'Request not found' };
  expireOld_([r.obj], [r.row]);
  var o = r.obj;
  if (o.Status !== 'Pending') return { ok: false, error: o.REQ_ID + ' is ' + o.Status };
  if (o.Requested_By === approver.code) return { ok: false, error: 'You cannot decide your own request' };
  if (Number(o.Need_Level) > lvl) return { ok: false, error: o.REQ_ID + ' needs Level ' + o.Need_Level + ' (' + LEVEL_NAMES[o.Need_Level] + ')' };
  var note = String(req.note || '').trim();
  var sh = sh_('AUTH_Requests');
  if (!req.approve) {
    sh.getRange(r.row, 10, 1, 5).setValues([['Rejected', approver.code, now_(), note, '']]);
    return { ok: true, reqId: o.REQ_ID, status: 'Rejected' };
  }
  var requester = userByCode_(o.Requested_By);
  var lp = String(o.Location).split('|');
  var loc = resolveLoc_(lp[0], lp[1]);
  if (!requester || !loc) return { ok: false, error: 'Requester or location no longer exists' };
  var payload = JSON.parse(o.Payload || '{}');
  payload.clientUUID = o.REQ_ID;
  payload.reason = o.Reason + (note ? ' · Approver: ' + note : '');
  var res = PROTECTED[o.Action](payload, {
    user: { code: requester.USR_Code, name: requester.USR_Name, role: requester.USR_Role, access: requester.USR_Access },
    loc: loc, level: lvl, authBy: approver.code, authRef: o.REQ_ID
  });
  if (res.ok) {
    var ids = res.evtIds || (res.evtId ? [res.evtId] : []);
    sh.getRange(r.row, 10, 1, 5).setValues([['Approved', approver.code, now_(), note, 'Saved · EVT ' + ids.join(', ')]]);
    return merge_(res, { reqId: o.REQ_ID, status: 'Approved' });
  }
  sh.getRange(r.row, 10, 1, 5).setValues([['Failed', approver.code, now_(), note, String(res.error || '').slice(0, 400)]]);
  return { ok: false, reqId: o.REQ_ID, status: 'Failed', error: 'Approved, but the action could not be saved because things have changed:\n' + res.error };
}

function authRows_() {
  var sh = sh_('AUTH_Requests'), last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, COL.AUTH_Requests.length).getDisplayValues();
  var rows = [], nums = [];
  vals.forEach(function (v, i) {
    if (!v[0]) return;
    var o = {}; COL.AUTH_Requests.forEach(function (k, j) { o[k] = v[j]; });
    rows.push(o); nums.push(i + 2);
  });
  expireOld_(rows, nums);
  return rows;
}
function expireOld_(rows, nums) {
  var hrs = Number(config_('Auth_Expiry_Hours')) || 24;
  var limit = Utilities.formatDate(new Date(Date.now() - hrs * 3600000), TZ, 'yyyy-MM-dd HH:mm:ss');
  rows.forEach(function (o, i) {
    if (o.Status === 'Pending' && o.Created_At < limit) {
      o.Status = 'Expired';
      sh_('AUTH_Requests').getRange(nums[i], 10, 1, 3).setValues([['Expired', '', now_()]]);
    }
  });
}
function reqOut_(o) {
  return { reqId: o.REQ_ID, created: o.Created_At, by: o.Requested_By, byName: (userByCode_(o.Requested_By) || {}).USR_Name || o.Requested_By,
    location: String(o.Location).split('|')[1] || '', action: o.Action, actionName: ACTION_NAMES[o.Action] || o.Action,
    need: Number(o.Need_Level), summary: o.Summary, reason: o.Reason, status: o.Status, decidedBy: o.Decided_By,
    decidedAt: o.Decided_At, note: o.Decision_Note, result: o.Result };
}
function cleanPayload_(p) {
  var out = {};
  Object.keys(p).forEach(function (k) { if (['action', 'token', 'auth', 'clientUUID', 'reason', 'forAction'].indexOf(k) < 0) out[k] = p[k]; });
  return out;
}
function summary_(action, p, loc) {
  var n = (p.codes || []).length;
  switch (action) {
    case 'transfer': return n + ' package(s) from ' + loc.code + ' to ' + p.dest;
    case 'sell': return n + ' package(s) from ' + loc.code + ' to ' + p.customer;
    case 'returnReceive': return p.code + ' at ' + loc.code + ' (qty ' + p.qty + ')';
    case 'unpack': return p.code + ' at ' + loc.code;
    case 'repack': return p.bun24 + ' at ' + loc.code + ((p.pipes || []).length ? ' (' + p.pipes.length + ' pipes)' : '');
    case 'locationCorrect': return p.code + ' found at ' + loc.code;
    case 'closePackage': return p.bun24 + ' at ' + loc.code;
  }
  return '';
}

// ---------------------------------------------------------------- locations

/** Resolve a login location. type 'M' = machine (code MAC-f-mm), 'S' = storage location (WHS_Code). */
function resolveLoc_(type, code) {
  if (type === 'M') {
    var m = /^MAC-(\d)-(\d\d)$/.exec(String(code));
    if (!m) return null;
    var mac = readTable_('MAC_Master').filter(function (x) { return x.FTY_Code === m[1] && x.MAC_Code === m[2] && String(x.MAC_Active).toUpperCase() === 'YES'; })[0];
    if (!mac) return null;
    return { type: 'M', code: code, name: mac.MAC_Name + ' · ' + mac.MAC_Type, fty: m[1], mac: m[2], category: mac.SKU_Category };
  }
  if (type === 'S') {
    var w = whsByCode_(code);
    if (!w) return null;
    return { type: 'S', code: w.WHS_Code, name: w.WHS_Code + ' · ' + w.WHS_Name, locNo: pad_(w.Loc_No, 2), whsType: w.WHS_Type, fty: w.FTY_Code || '' };
  }
  return null;
}

/** Location QR: PPSPL:LOCATION:S-<Loc_No> or PPSPL:LOCATION:M-<factory>-<machine> */
function locFromQR_(s) {
  s = String(s || '').trim();
  var m = /^PPSPL:LOCATION:M-(\d)-(\d\d)$/.exec(s);
  if (m) return { type: 'M', code: 'MAC-' + m[1] + '-' + m[2] };
  m = /^PPSPL:LOCATION:S-(\d\d)$/.exec(s);
  if (m) {
    var w = readTable_('WHS_Master').filter(function (x) { return pad_(x.Loc_No, 2) === m[1]; })[0];
    return w ? { type: 'S', code: w.WHS_Code } : null;
  }
  return null;
}

function wipStore_(fty) {
  return readTable_('WHS_Master').filter(function (w) {
    return String(w.FTY_Code) === String(fty) && w.WHS_Type === 'WIP Store' && String(w.WHS_Active).toUpperCase() === 'YES';
  })[0] || null;
}

function needStorage_(ctx, what) {
  if (ctx.loc && ctx.loc.type === 'S') return null;
  return fail_([what + ' is done at a storage location (yard, warehouse or WIP Store). You are logged in at ' + (ctx.loc ? ctx.loc.code : '?') +
    '. Log out and log in at the storage location.']);
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
    serverDate: today_(),
    version: VERSION
  };
}

/** Log in with name, PIN and location. The location is signed into the token and fixed until logout. */
function apiLogin_(req) {
  var code = String(req.usr || '').trim();
  var pin = String(req.pin || '').trim();
  var u = userByCode_(code);
  if (!u || String(u.USR_Active).toUpperCase() !== 'YES') return { ok: false, error: 'User not found or inactive' };
  var p = pinCheck_(u, pin);
  if (!p.ok) return p;
  var l = req.locQR ? locFromQR_(req.locQR) : req.loc || null;
  if (req.locQR && !l) return { ok: false, error: 'That is not a valid location QR' };
  if (!l) return { ok: false, error: 'Choose where you are' };
  var loc = resolveLoc_(l.type, l.code);
  if (!loc) return { ok: false, error: 'Location ' + (l.code || '') + ' is not in the masters' };
  var exp = Date.now() + TOKEN_HOURS * 3600 * 1000;
  var payload = u.USR_Code + '|' + u.USR_Access + '|' + exp + '|' + loc.type + '|' + loc.code;
  var token = payload + '|' + sign_(payload);
  return { ok: true, token: token, user: { code: u.USR_Code, name: u.USR_Name, role: u.USR_Role, access: u.USR_Access, loc: loc }, expires: exp };
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
 * MOD002 Primary Pack (event = Produced). Logged in at a machine.
 * One event: From = the label's machine, To = that factory's WIP Store.
 * req: { clientUUID, bun24, bun15 (optional for check 2/3), pipes: [PIP_QR24 x N] (check 1 only) }
 */
function apiClosePackage_(req, ctx) {
  if (!ctx.loc || ctx.loc.type !== 'M') return fail_(['Primary Pack is done at a machine. You are logged in at ' + (ctx.loc ? ctx.loc.code : '?') + '. Log out and log in at the machine.']);
  return withLock_(function () {
    var dup = alreadySaved_(req.clientUUID);
    if (dup) return dup;

    var errors = [], warnings = [], needs = [];
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
    var mac = 'MAC-' + b.factory + '-' + b.machine;
    if (!resolveLoc_('M', mac)) errors.push('Machine ' + mac + ' on the label is not in MAC_Master');
    var wip = wipStore_(b.factory);
    if (!wip) errors.push('Factory ' + b.factory + ' has no WIP Store in WHS_Master');
    if (mac !== ctx.loc.code) need_(needs, 2, 'Label is for ' + mac + ' but you are logged in at ' + ctx.loc.code, true);

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
    var g = gate_(ctx, req, needs, warnings);
    if (g) return g;

    // ---- write
    var when = now_();
    var usr = ctx.user.code;
    if (chk === '1') {
      appendRows_('PIP_Identity', pipes.map(function (pc) {
        var pp = parseQR_(pc);
        return [pc, pp.date, pp.factory, pp.machine, pp.erpPart, sku.SKU_Code, pp.side, pp.serial, when, usr];
      }));
      var memId = nextCounter_('Next_MEM_ID', pipes.length);
      appendRows_('PIP_Membership', pipes.map(function (pc, i) { return [memId + i, pc, bun24, 'Produced', when, '', '', 'Active', usr]; }));
    }
    appendRows_('BUN_Package', [[bun24, bun15, chk + ' = ' + PKG_NAMES[chk], 'Produced', b.date, b.factory, b.machine,
      sku.SKU_Code, qty, 'Produced', wip.WHS_Code, qty, when]]);
    var evtId = nextCounter_('Next_EVT_ID', 1);
    var sys = warnings.concat(needs.map(function (n) { return n.why; })).join(' | ');
    appendRows_('BUN_Event', [evRow_(evtId, req.clientUUID, 1, bun24, 'Produced', mac, wip.WHS_Code, when, qty, ctx, req, sys)]);
    markLabelsUsed_([bun24, bun15].concat(pipes).filter(String), when);

    return { ok: true, event: 'Produced', evtId: evtId, evtIds: [evtId], bun24: bun24, bun15: bun15, pkgType: PKG_NAMES[chk], sku: sku.SKU_Code,
             skuName: sku.SKU_Description, qty: qty, from: mac, where: wip.WHS_Code, whereName: wip.WHS_Name, when: when,
             warnings: warnings, authBy: ctx.authBy };
  });
}

/**
 * Reserve today's demo labels and record them in QR_Labels.
 * req.kind: 'pipes'   -> 10 pipe bundles: 60 pipe QRs + 10 bundle QR-24 + 10 QR-15
 *           'fittings'-> 5 fittings boxes: QR-24 + QR-15
 *           'agri'    -> 3 agri pipes:     QR-24 + QR-15
 *           'repack'  -> repack labels for a storage location
 */
function apiReserveLabels_(req, ctx) {
  var user = ctx.user;
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

  return withLock_(function () {
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
  });
}

// ---------------------------------------------------------------- stock modules (MOD003-MOD008)

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

/** MOD003 Transfer: move intact packages from here to another company location. */
function apiTransfer_(req, ctx) {
  var ns = needStorage_(ctx, 'Transfer'); if (ns) return ns;
  return withLock_(function () {
    var dup = alreadySaved_(req.clientUUID);
    if (dup) return dup;
    var here = ctx.loc.code;
    var dest = whsByCode_(req.dest);
    if (!dest) return fail_(['Choose a destination location']);
    if (dest.WHS_Code === here) return fail_(['The destination is where you are logged in (' + here + ')']);
    var codes = uniqueCodes_(req.codes);
    if (!codes.length) return fail_(['No packages scanned']);
    var errors = [], needs = [], pk = [];
    codes.forEach(function (c, i) {
      var k = pkgByCode_(c);
      var label = 'Package ' + (i + 1) + ' (' + c + ')';
      if (!k) return errors.push(label + ' is not in the system');
      var st = k.obj.Current_Status;
      if (st === 'Sold') return errors.push(label + ' is already sold');
      if (st === 'Unpacked') return errors.push(label + ' is no longer active (unpacked)');
      if (!IN_STOCK[st] && st !== 'Return Received') return errors.push(label + ' has status ' + st);
      if (k.obj.Current_Where === dest.WHS_Code) return errors.push(label + ' is already at ' + dest.WHS_Code);
      if (pk.some(function (x) { return x.obj.BUN_QR24 === k.obj.BUN_QR24; })) return errors.push(label + ' was scanned twice (QR-24 and QR-15)');
      if (st === 'Return Received') need_(needs, 2, label + ' is a return awaiting inspection', false);
      if (k.obj.Current_Where !== here) need_(needs, 2, label + ' is recorded at ' + k.obj.Current_Where + ', not ' + here, true);
      pk.push(k);
    });
    if (errors.length) return fail_(errors);
    var g = gate_(ctx, req, needs); if (g) return g;
    var when = now_();
    var res = writeEvents_(pk, { event: 'Transferred', to: dest.WHS_Code, when: when, ctx: ctx, req: req,
      sys: function (k) { return k.obj.Current_Where !== here ? 'Scanned at ' + here + ', recorded at ' + k.obj.Current_Where : ''; } });
    return { ok: true, event: 'Transferred', from: here, where: dest.WHS_Code, whereName: dest.WHS_Name, count: pk.length, pieces: res.pieces, evtIds: res.ids, when: when, authBy: ctx.authBy };
  });
}

/** MOD004 Sales: packages leave here for a customer. */
function apiSell_(req, ctx) {
  var ns = needStorage_(ctx, 'Sales'); if (ns) return ns;
  return withLock_(function () {
    var dup = alreadySaved_(req.clientUUID);
    if (dup) return dup;
    var here = ctx.loc.code;
    var cst = readTable_('CST_Master').filter(function (c) { return c.CST_Code === req.customer; })[0];
    if (!cst) return fail_(['Choose the customer']);
    var codes = uniqueCodes_(req.codes);
    if (!codes.length) return fail_(['No packages scanned']);
    var errors = [], needs = [], pk = [];
    codes.forEach(function (c, i) {
      var k = pkgByCode_(c);
      var label = 'Package ' + (i + 1) + ' (' + c + ')';
      if (!k) return errors.push(label + ' is not in the system');
      var st = k.obj.Current_Status;
      if (st === 'Sold') return errors.push(label + ' is already sold');
      if (st === 'Unpacked') return errors.push(label + ' is no longer active (unpacked)');
      if (st === 'Return Received') return errors.push(label + ' is a return awaiting inspection. Transfer it back into stock first');
      if (!IN_STOCK[st]) return errors.push(label + ' has status ' + st);
      if (pk.some(function (x) { return x.obj.BUN_QR24 === k.obj.BUN_QR24; })) return errors.push(label + ' was scanned twice (QR-24 and QR-15)');
      if (k.obj.Current_Where !== here) need_(needs, 2, label + ' is recorded at ' + k.obj.Current_Where + ', not ' + here, true);
      pk.push(k);
    });
    if (errors.length) return fail_(errors);
    var g = gate_(ctx, req, needs); if (g) return g;
    var when = now_();
    var res = writeEvents_(pk, { event: 'Sold', to: cst.CST_Code, when: when, ctx: ctx, req: req, sys: function (k) {
      var r = req.vehicle ? 'Vehicle ' + req.vehicle : '';
      if (k.obj.Current_Where !== here) r += (r ? ' · ' : '') + 'Dispatched from ' + here + ', recorded at ' + k.obj.Current_Where;
      return r;
    } });
    return { ok: true, event: 'Sold', from: here, where: cst.CST_Code, whereName: cst.CST_Name, count: pk.length, pieces: res.pieces, evtIds: res.ids, when: when, authBy: ctx.authBy };
  });
}

/** MOD005 Returns: a sold package comes back here. Level 2, or Level 1 with authorisation. */
function apiReturnReceive_(req, ctx) {
  var ns = needStorage_(ctx, 'Returns'); if (ns) return ns;
  return withLock_(function () {
    var dup = alreadySaved_(req.clientUUID);
    if (dup) return dup;
    var here = ctx.loc.code;
    var k = pkgByCode_(String(req.code || '').trim());
    if (!k) return fail_(['Package is not in the system']);
    if (k.obj.Current_Status !== 'Sold') return fail_(['Only a sold package can be returned. Current status: ' + k.obj.Current_Status]);
    var sold = Number(k.obj.Current_Qty);
    var qty = Number(req.qty);
    if (!(qty >= 1 && qty <= sold)) return fail_(['Quantity received must be between 1 and ' + sold]);
    var needs = [];
    need_(needs, 2, 'Receiving a return needs a supervisor', false);
    var g = gate_(ctx, req, needs); if (g) return g;
    var cond = String(req.condition || 'Intact');
    var when = now_();
    var sys = 'Condition: ' + cond + (qty < sold ? ' · short ' + (sold - qty) : '') + (req.remark ? ' · ' + req.remark : '');
    var cust = k.obj.Current_Where;
    var res = writeEvents_([k], { event: 'Return Received', to: here, when: when, ctx: ctx, req: req, sys: function () { return sys; }, qty: qty });
    return { ok: true, event: 'Return Received', from: cust, where: here, whereName: ctx.loc.name, count: 1, pieces: qty, evtIds: res.ids, when: when,
             bun24: k.obj.BUN_QR24, customer: cust, condition: cond, authBy: ctx.authBy };
  });
}

/** MOD006 Unpacked: open a package here; its pipes become loose stock. Level 2, or Level 1 with authorisation. */
function apiUnpack_(req, ctx) {
  var ns = needStorage_(ctx, 'Unpack'); if (ns) return ns;
  return withLock_(function () {
    var dup = alreadySaved_(req.clientUUID);
    if (dup) return dup;
    var here = ctx.loc.code;
    var k = pkgByCode_(String(req.code || '').trim());
    if (!k) return fail_(['Package is not in the system']);
    var st = k.obj.Current_Status;
    if (st === 'Unpacked') return fail_(['Package is already unpacked']);
    if (st === 'Sold') return fail_(['Package is with the customer. Receive it first using Returns.']);
    var needs = [];
    need_(needs, 2, 'Unpacking needs a supervisor', false);
    if (k.obj.Current_Where !== here) need_(needs, 2, 'Package is recorded at ' + k.obj.Current_Where + ', not ' + here, true);
    var g = gate_(ctx, req, needs); if (g) return g;
    var when = now_();
    var members = filterRows_('PIP_Membership', 3, k.obj.BUN_QR24).filter(function (m) { return m.Status === 'Active'; });
    var sh = sh_('PIP_Membership');
    members.forEach(function (m) { sh.getRange(m._row, 6, 1, 3).setValues([['Unpacked', when, 'Closed']]); });
    var was = k.obj.Current_Where;
    var res = writeEvents_([k], { event: 'Unpacked', to: here, when: when, ctx: ctx, req: req, qty: 0, sys: function () {
      return (req.cause || 'Unpacked') + (req.remark ? ' · ' + req.remark : '') + ' · was ' + st + ' at ' + was;
    } });
    return { ok: true, event: 'Unpacked', from: was, where: here, whereName: ctx.loc.name, count: 1, pieces: Number(k.obj.Current_Qty),
             released: members.length, evtIds: res.ids, when: when, bun24: k.obj.BUN_QR24, pkgType: k.obj.PKG_Type, authBy: ctx.authBy };
  });
}

/** MOD007 Packed: build a new package here from loose stock using a repack label (factory digit 0). */
function apiRepack_(req, ctx) {
  var ns = needStorage_(ctx, 'Repack'); if (ns) return ns;
  return withLock_(function () {
    var dup = alreadySaved_(req.clientUUID);
    if (dup) return dup;
    var here = ctx.loc.code, locNo = ctx.loc.locNo;
    var bun24 = String(req.bun24 || '').trim(), bun15 = String(req.bun15 || '').trim();
    var pipes = uniqueCodes_(req.pipes);
    var b = parseQR_(bun24), errors = [], needs = [];
    if (b.kind !== 'BUNDLE_QR24' || !b.ok) return fail_(['New package label QR-24 is not valid']);
    if (b.factory !== '0') errors.push('This is a production label. Repack needs a repack label (factory digit 0)');
    if (b.machine !== locNo) errors.push('Label is for location ' + b.machine + '; you are logged in at ' + here + ' (location ' + locNo + ')');
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
      if (pipes.length && pipes.length < full) need_(needs, 2, 'Short bundle (' + pipes.length + ' of ' + full + ' pipes)', true);
      qty = pipes.length;
    } else {
      if (pipes.length) errors.push('Fittings Boxes and Agri Pipes take no pipe scans');
      if (chk === '3') need_(needs, 2, 'Agri Pipe repack', true);
      if (chk === '3' && b.qty !== 1) errors.push('Agri Pipe quantity must be 01');
      if (req.count != null && Number(req.count) !== b.qty) errors.push('Counted ' + req.count + ' pieces but the label says ' + pad_(b.qty, 2));
      qty = b.qty;
    }
    if (errors.length) return fail_(errors);
    var g = gate_(ctx, req, needs); if (g) return g;
    var when = now_();
    if (pipes.length) {
      var memId = nextCounter_('Next_MEM_ID', pipes.length);
      appendRows_('PIP_Membership', pipes.map(function (pc, i) { return [memId + i, pc, bun24, 'Packed', when, '', '', 'Active', ctx.user.code]; }));
    }
    appendRows_('BUN_Package', [[bun24, bun15, chk + ' = ' + PKG_NAMES[chk], 'Packed', b.date, '0', b.machine, sku.SKU_Code, qty, 'Packed', here, qty, when]]);
    var evtId = nextCounter_('Next_EVT_ID', 1);
    appendRows_('BUN_Event', [evRow_(evtId, req.clientUUID, 1, bun24, 'Packed', here, here, when, qty, ctx, req,
      'Repacked from loose stock' + (pipes.length && pipes.length < full ? ' · short bundle' : ''))]);
    markLabelsUsed_([bun24, bun15].filter(String), when);
    return { ok: true, event: 'Packed', evtId: evtId, evtIds: [evtId], bun24: bun24, bun15: bun15, pkgType: PKG_NAMES[chk], sku: sku.SKU_Code, skuName: sku.SKU_Description,
             qty: qty, where: here, when: when, authBy: ctx.authBy };
  });
}

/**
 * MOD008 Location Corrected (Level 3). The package was found here but is recorded elsewhere.
 * Not a transfer: From = expected (recorded) location, To = here. Status is unchanged.
 */
function apiLocationCorrect_(req, ctx) {
  var ns = needStorage_(ctx, 'Location Correction'); if (ns) return ns;
  return withLock_(function () {
    var dup = alreadySaved_(req.clientUUID);
    if (dup) return dup;
    var here = ctx.loc.code;
    var k = pkgByCode_(String(req.code || '').trim());
    if (!k) return fail_(['Package is not in the system']);
    var st = k.obj.Current_Status;
    if (st === 'Sold') return fail_(['Package is recorded as sold to ' + k.obj.Current_Where + '. Use Returns, not Location Correction.']);
    if (st === 'Unpacked') return fail_(['Package was unpacked. It cannot be corrected.']);
    if (!IN_STOCK[st] && st !== 'Return Received') return fail_(['Package has status ' + st]);
    if (k.obj.Current_Where === here) return fail_(['Package is already recorded at ' + here + '. No correction needed.']);
    var needs = [];
    need_(needs, 3, 'Correct location of ' + k.obj.BUN_QR24 + ' from ' + k.obj.Current_Where + ' (recorded) to ' + here + ' (found)', true);
    var g = gate_(ctx, req, needs); if (g) return g;
    var when = now_(), was = k.obj.Current_Where;
    var res = writeEvents_([k], { event: 'Location Corrected', to: here, when: when, ctx: ctx, req: req, keepStatus: true,
      sys: function () { return 'Expected at ' + was + ', found at ' + here; } });
    return { ok: true, event: 'Location Corrected', from: was, where: here, whereName: ctx.loc.name, count: 1, pieces: Number(k.obj.Current_Qty),
             evtIds: res.ids, when: when, bun24: k.obj.BUN_QR24, status: st, authBy: ctx.authBy };
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

/** Simple dashboard figures. Location Corrected is listed separately and never counted as a transfer. */
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
  var pkgSku = {}; pk.forEach(function (p) { pkgSku[p.BUN_QR24] = p.SKU_Code; });
  var status = group(pk, function (r) { return r.Current_Status; }, function (r) { return r.Current_Qty; });
  var stockRows = pk.filter(function (r) { return IN_STOCK[r.Current_Status] || r.Current_Status === 'Return Received'; });
  var stock = group(stockRows, function (r) { return r.Current_Where + '|' + r.SKU_Code + '|' + (r.Current_Status === 'Return Received' ? 'Awaiting inspection' : 'Saleable'); }, function (r) { return r.Current_Qty; });
  var prodToday = group(ev.filter(function (e) { return e.Event === 'Produced' && e.When.slice(0, 10) === today; }), function (e) {
    return e.From_Where + '|' + (pkgSku[e.BUN_QR24] || '');
  }, function (e) { return e.Item_Qty; });
  var transfers = group(ev.filter(function (e) { return e.Event === 'Transferred'; }), function (e) { return e.From_Where + ' → ' + e.To_Where; }, function (e) { return e.Item_Qty; });
  var sales = group(ev.filter(function (e) { return e.Event === 'Sold'; }), function (e) { return e.To_Where; }, function (e) { return e.Item_Qty; });
  var corrections = ev.filter(function (e) { return e.Event === 'Location Corrected'; }).slice(-10).reverse();
  var authorised = ev.filter(function (e) { return e.Auth_By; }).length;
  var pendingReq = authRows_().filter(function (r) { return r.Status === 'Pending'; }).length;
  var active = {}, seen = {};
  mem.forEach(function (m) { seen[m.PIP_QR24] = 1; if (m.Status === 'Active') active[m.PIP_QR24] = 1; });
  var loose = Object.keys(seen).filter(function (p) { return !active[p]; }).length;
  var recent = ev.slice(-15).reverse();
  return { ok: true, today: today, status: status, stock: stock, productionToday: prodToday, transfers: transfers, sales: sales,
           corrections: corrections, authorisedEvents: authorised, pendingRequests: pendingReq,
           pipes: { total: Object.keys(seen).length, inPackages: Object.keys(active).length, loose: loose },
           recent: recent, skuName: skuName, placeName: placeName };
}

// ---- helpers for stock modules

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function alreadySaved_(uuid) {
  if (!uuid) return null;
  var prev = findRow_('BUN_Event', 2, String(uuid) + '#1');
  if (!prev) return null;
  var o = prev.obj;
  return { ok: true, duplicate: true, message: 'Already saved earlier', event: o.Event, evtId: Number(o.EVT_ID), evtIds: [Number(o.EVT_ID)],
           bun24: o.BUN_QR24, from: o.From_Where, where: o.To_Where, when: o.When, qty: Number(o.Item_Qty) };
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
function userByCode_(code) {
  return readTable_('USR_Master').filter(function (r) { return r.USR_Code === code; })[0] || null;
}
/** One BUN_Event row. sys = system note; the user's reason (when given) is added after it. */
function evRow_(id, uuid, n, bun, event, from, to, when, qty, ctx, req, sys) {
  var reason = String(req.reason || '').trim();
  var text = [sys || '', reason ? 'Reason: ' + reason : ''].filter(String).join(' · ');
  return [id, uuid ? String(uuid) + '#' + n : '', bun, event, from, to, when, qty, String(req.docRef || ''), ctx.user.code,
          ctx.authBy || '', ctx.authRef || '', text, ''];
}
/** One event per package + package status update. From = where the package is recorded now. */
function writeEvents_(pkgs, o) {
  var first = nextCounter_('Next_EVT_ID', pkgs.length);
  var sh = sh_('BUN_Package'), pieces = 0, ids = [];
  var rows = pkgs.map(function (k, i) {
    var qty = o.qty != null ? o.qty : Number(k.obj.Current_Qty);
    var itemQty = o.event === 'Unpacked' ? Number(k.obj.Current_Qty) : qty;
    pieces += itemQty;
    ids.push(first + i);
    var row = evRow_(first + i, o.req.clientUUID, i + 1, k.obj.BUN_QR24, o.event, k.obj.Current_Where, o.to, o.when, itemQty, o.ctx, o.req, o.sys ? o.sys(k) : '');
    sh.getRange(k.row, 10, 1, 4).setValues([[o.keepStatus ? k.obj.Current_Status : o.event, o.to, qty, o.when]]);
    return row;
  });
  appendRows_('BUN_Event', rows);
  return { pieces: pieces, ids: ids };
}
function merge_(a, b) { var o = {}; Object.keys(a).forEach(function (k) { o[k] = a[k]; }); Object.keys(b).forEach(function (k) { o[k] = b[k]; }); return o; }

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

// ---------------------------------------------------------------- login token

function secret_() {
  var p = PropertiesService.getScriptProperties();
  var s = p.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('TOKEN_SECRET', s); }
  return s;
}
function sign_(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, secret_()));
}
/** Token = USR|access|expiry|locType|locCode|signature. The location cannot change without logging in again. */
function verifyToken_(token) {
  if (!token) return null;
  var parts = String(token).split('|');
  if (parts.length !== 6) return null;
  var payload = parts.slice(0, 5).join('|');
  if (sign_(payload) !== parts[5]) return null;
  if (Date.now() > Number(parts[2])) return null;
  var u = userByCode_(parts[0]);
  if (!u || String(u.USR_Active).toUpperCase() !== 'YES') return null;
  var loc = resolveLoc_(parts[3], parts[4]);
  if (!loc) return null;
  return { code: u.USR_Code, name: u.USR_Name, role: u.USR_Role, access: u.USR_Access, loc: loc };
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
