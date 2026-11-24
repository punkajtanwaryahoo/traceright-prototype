// Decodes TraceRight QR codes as per PPSPL QR CODING SCHEME effective 16-Nov-2026.
// Shared by the camera test now, and by the app screens later.
(function (global) {
  function validDate(yy, mm, dd) {
    var y = 2000 + yy;
    if (yy < 26 || yy > 99 || mm < 1 || mm > 12 || dd < 1) return false;
    var last = new Date(y, mm, 0).getDate();
    return dd <= last;
  }

  function parse(raw) {
    var s = String(raw || '').trim();
    var out = { raw: s, kind: 'UNKNOWN', ok: false, fields: {}, errors: [] };

    if (/^\d{24}$/.test(s)) {
      var yy = +s.slice(0, 2), mm = +s.slice(2, 4), dd = +s.slice(4, 6);
      var chk = s[23];
      var common = {
        Date: '20' + s.slice(0, 2) + '-' + s.slice(2, 4) + '-' + s.slice(4, 6),
        Factory: s[6],
        'Machine / Location': s.slice(7, 9),
        'ERP SKU / Part': s.slice(9, 17)
      };
      if (!validDate(yy, mm, dd)) out.errors.push('Invalid date in digits 1-6');

      if (chk === '0') {
        out.kind = 'PIPE_QR24';
        out.fields = Object.assign(common, {
          Side: s[17] === '1' ? '1 (Right)' : s[17] === '0' ? '0 (Left)' : s[17],
          'Pipe Serial': s.slice(18, 23),
          Check: '0 = Pipe'
        });
        if (s[17] !== '0' && s[17] !== '1') out.errors.push('Side digit 18 must be 0 or 1');
        if (+s.slice(18, 23) < 1) out.errors.push('Pipe serial must be 00001-99999');
        if (s[6] === '0') out.errors.push('Pipe must be produced in a factory (digit 7 = 1-9)');
      } else if (chk === '1' || chk === '2' || chk === '3') {
        var types = { '1': 'Pipe Bundle', '2': 'Fittings Box', '3': 'Agri Pipe' };
        out.kind = 'BUNDLE_QR24';
        out.pkgType = +chk;
        out.fields = Object.assign(common, {
          'Bundle Serial': s.slice(17, 21),
          Quantity: s.slice(21, 23),
          Check: chk + ' = ' + types[chk]
        });
        if (s[6] === '0') out.fields.Factory = '0 (Repacked – not produced in factory)';
        if (chk === '3' && s.slice(21, 23) !== '01') out.errors.push('Agri Pipe quantity must be 01');
        if (+s.slice(17, 21) < 1) out.errors.push('Bundle serial must be 0001-9999');
      } else {
        out.errors.push('Check digit 24 must be 0 (pipe) or 1/2/3 (package)');
      }
    } else if (/^[A-Z]\d{14}$/.test(s)) {
      var yr = +s.slice(1, 5);
      out.kind = 'BUNDLE_QR15';
      out.fields = { Prefix: s[0], Year: String(yr), 'Running Serial': s.slice(5) };
      if (yr <= 2025 || yr >= 2099) out.errors.push('Year must be 2026-2098');
    } else {
      out.errors.push(s.length + ' characters – not a TraceRight QR (expects 24 digits or 15-char QR-15)');
    }
    out.ok = out.kind !== 'UNKNOWN' && out.errors.length === 0;
    return out;
  }

  var LABEL = { PIPE_QR24: 'Pipe QR-24', BUNDLE_QR24: 'Package QR-24', BUNDLE_QR15: 'Bundle QR-15', UNKNOWN: 'Not recognised' };
  global.TR = global.TR || {};
  global.TR.parseQR = parse;
  global.TR.kindLabel = function (k) { return LABEL[k] || k; };
})(window);
