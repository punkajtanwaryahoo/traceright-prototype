// Camera QR scanner wrapper (html5-qrcode), with beep/vibrate feedback and repeat suppression.
(function (global) {
  var audio = null;

  function beep(kind) {
    try {
      audio = audio || new (global.AudioContext || global.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      var o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = kind === 'ok' ? 1200 : kind === 'warn' ? 700 : 300;
      o.connect(g); g.connect(audio.destination); g.gain.value = 0.15;
      o.start(); o.stop(audio.currentTime + (kind === 'ok' ? 0.12 : 0.35));
    } catch (e) {}
    if (navigator.vibrate) navigator.vibrate(kind === 'ok' ? 80 : [80, 60, 80]);
  }

  function Scanner(elementId, onCode) {
    this.elementId = elementId;
    this.onCode = onCode;
    this.inst = null;
    this.running = false;
    this.last = ''; this.lastAt = 0;
  }
  Scanner.prototype.start = function () {
    var self = this;
    try { audio = audio || new (global.AudioContext || global.webkitAudioContext)(); audio.resume(); } catch (e) {}
    if (self.running) return Promise.resolve();
    self.inst = self.inst || new Html5Qrcode(self.elementId, {
      formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      verbose: false
    });
    return self.inst.start({ facingMode: 'environment' },
      { fps: 12, qrbox: function (w, h) { var s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; } },
      function (text) {
        var now = Date.now();
        if (text === self.last && now - self.lastAt < 3000) return;   // same code still in view
        self.last = text; self.lastAt = now;
        self.onCode(text);
      }, function () {}).then(function () { self.running = true; });
  };
  Scanner.prototype.stop = function () {
    var self = this;
    if (!self.inst || !self.running) return Promise.resolve();
    return self.inst.stop().then(function () { self.running = false; }).catch(function () { self.running = false; });
  };
  Scanner.prototype.forget = function () { this.last = ''; this.lastAt = 0; };

  global.TRScanner = Scanner;
  global.TRBeep = beep;
})(window);
