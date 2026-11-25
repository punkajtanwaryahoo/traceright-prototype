// Talks to the Apps Script backend. POST with text/plain avoids a CORS preflight.
(function (global) {
  var TOKEN_KEY = 'tr_token', USER_KEY = 'tr_user';

  function store() { try { return global.localStorage; } catch (e) { return null; } }
  function get(k) { var s = store(); try { return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function set(k, v) { var s = store(); try { if (s) { v == null ? s.removeItem(k) : s.setItem(k, v); } } catch (e) {} }

  function call(action, payload, timeoutMs) {
    var url = (global.TR_CONFIG || {}).API_URL;
    if (!url) return Promise.reject(new Error('Backend not connected yet (API_URL is empty in config.js).'));
    var body = Object.assign({ action: action, token: get(TOKEN_KEY) || '' }, payload || {});
    var ctrl = global.AbortController ? new AbortController() : null;
    var t = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 30000);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) { return r.json(); })
      .then(function (res) {
        clearTimeout(t);
        if (res && res.code === 'AUTH') { set(TOKEN_KEY, null); set(USER_KEY, null); global.dispatchEvent(new Event('tr-auth-expired')); }
        return res;
      })
      .catch(function (e) {
        clearTimeout(t);
        throw new Error(e.name === 'AbortError' ? 'The server took too long to answer. Check the connection and try again.' : 'Could not reach the server: ' + e.message);
      });
  }

  global.TRApi = {
    call: call,
    saveLogin: function (res) { set(TOKEN_KEY, res.token); set(USER_KEY, JSON.stringify(res.user)); },
    user: function () { try { return JSON.parse(get(USER_KEY) || 'null'); } catch (e) { return null; } },
    logout: function () { set(TOKEN_KEY, null); set(USER_KEY, null); },
    uuid: function () {
      if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }
  };
})(window);
