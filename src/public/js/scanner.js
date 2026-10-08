// Phone-camera code scanner for any <input data-scan>.
//
//   data-scan                       fill the input with the scanned code (default)
//   data-scan="submit"              fill, then submit the input's form
//   data-scan="enter"               fill, then fire an Enter keydown (for pages whose JS listens for Enter)
//   data-scan-continuous            keep the camera open after each scan (use with "enter")
//
// Decoding: native BarcodeDetector when the browser supports Code 128 + Data Matrix + QR
// (Chrome on Android), otherwise ZXing (/vendor/zxing/index.min.js, loaded only on first use).
(function () {
  'use strict';

  var ZXING_SRC = '/vendor/zxing/index.min.js';
  var NATIVE_FORMATS = ['code_128', 'data_matrix', 'qr_code'];
  var zxingPromise = null;
  var state = null; // the open scanner session, if any

  function loadZXing() {
    if (window.ZXing) return Promise.resolve();
    if (!zxingPromise) {
      zxingPromise = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = ZXING_SRC;
        s.onload = resolve;
        s.onerror = function () { zxingPromise = null; reject(new Error('Scanner library not found. Run "npm install" on the server.')); };
        document.head.appendChild(s);
      });
    }
    return zxingPromise;
  }

  async function makeDecoder(video) {
    if ('BarcodeDetector' in window) {
      try {
        var supported = await window.BarcodeDetector.getSupportedFormats();
        if (NATIVE_FORMATS.every(function (f) { return supported.indexOf(f) !== -1; })) {
          var detector = new window.BarcodeDetector({ formats: NATIVE_FORMATS });
          return async function () {
            var found = await detector.detect(video);
            return found.length ? found[0].rawValue : null;
          };
        }
      } catch (e) { /* fall through to ZXing */ }
    }

    await loadZXing();
    var Z = window.ZXing;
    var hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.DATA_MATRIX, Z.BarcodeFormat.QR_CODE]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    var reader = new Z.MultiFormatReader();
    reader.setHints(hints);
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d', { willReadFrequently: true });

    return async function () {
      var vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return null;
      var scale = Math.min(1, 1280 / vw);
      canvas.width = Math.round(vw * scale);
      canvas.height = Math.round(vh * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        var bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
        return reader.decode(bitmap).getText();
      } catch (e) { return null; } // NotFoundException = no code in this frame
    };
  }

  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text) n.textContent = text;
    return n;
  }

  function buildOverlay() {
    var root = el('div', 'position:fixed;inset:0;z-index:3000;background:#000;display:flex;flex-direction:column;');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Scan code with camera');

    var bar = el('div', 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;color:#fff;');
    bar.appendChild(el('strong', '', 'Point the camera at the barcode'));
    var btns = el('div', 'display:flex;gap:8px;');
    var torch = el('button', 'display:none;padding:6px 12px;border:1px solid #fff;background:transparent;color:#fff;border-radius:6px;', 'Light');
    torch.type = 'button';
    var close = el('button', 'padding:6px 14px;border:0;background:#fff;color:#000;border-radius:6px;font-weight:600;', 'Close');
    close.type = 'button';
    btns.appendChild(torch); btns.appendChild(close); bar.appendChild(btns);

    var stage = el('div', 'position:relative;flex:1;min-height:0;');
    var video = el('video', 'width:100%;height:100%;object-fit:cover;');
    video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); video.muted = true;
    var box = el('div', 'position:absolute;left:8%;right:8%;top:50%;height:34%;transform:translateY(-50%);border:2px solid rgba(255,255,255,.85);border-radius:10px;box-shadow:0 0 0 9999px rgba(0,0,0,.35);pointer-events:none;');
    stage.appendChild(video); stage.appendChild(box);

    var status = el('div', 'padding:12px;color:#fff;text-align:center;min-height:48px;', 'Starting camera…');
    root.appendChild(bar); root.appendChild(stage); root.appendChild(status);
    document.body.appendChild(root);
    return { root: root, video: video, status: status, torch: torch, close: close };
  }

  function feedback(s) {
    try { if (navigator.vibrate) navigator.vibrate(80); } catch (e) {}
    try {
      if (!s.audio) return;
      var o = s.audio.createOscillator(), g = s.audio.createGain();
      o.frequency.value = 880; g.gain.value = 0.1;
      o.connect(g); g.connect(s.audio.destination);
      o.start(); o.stop(s.audio.currentTime + 0.12);
    } catch (e) {}
  }

  function closeScanner() {
    if (!state) return;
    var s = state; state = null;
    s.closed = true;
    clearTimeout(s.timer);
    if (s.stream) s.stream.getTracks().forEach(function (t) { t.stop(); });
    if (s.audio && s.audio.close) { try { s.audio.close(); } catch (e) {} }
    document.removeEventListener('keydown', s.onKey);
    if (s.ui.root.parentNode) s.ui.root.parentNode.removeChild(s.ui.root);
  }

  function applyCode(input, code, mode) {
    input.value = code;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (mode === 'submit') {
      var form = input.form;
      if (form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
    } else if (mode === 'enter') {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    }
  }

  function errorMessage(e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) return 'Camera permission was denied. Allow camera access for this site in your browser settings, then try again.';
    if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) return 'No camera was found on this device.';
    if (e && e.name === 'NotReadableError') return 'The camera is in use by another app.';
    return (e && e.message) || 'Could not start the camera.';
  }

  async function openScanner(input) {
    closeScanner();
    var mode = input.dataset.scan || 'fill';
    if (mode !== 'submit' && mode !== 'enter') mode = 'fill';
    var continuous = input.dataset.scanContinuous !== undefined;

    var ui = buildOverlay();
    var s = state = { ui: ui, closed: false, stream: null, timer: null, busy: false, last: '', lastAt: 0, audio: null };
    try { var AC = window.AudioContext || window.webkitAudioContext; if (AC) s.audio = new AC(); } catch (e) {}
    s.onKey = function (e) { if (e.key === 'Escape') closeScanner(); };
    document.addEventListener('keydown', s.onKey);
    ui.close.addEventListener('click', closeScanner);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      ui.status.textContent = window.isSecureContext === false
        ? 'Camera access needs a secure (HTTPS) connection.'
        : 'This browser does not support camera access.';
      return;
    }

    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      if (s.closed) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      s.stream = stream;
      ui.video.srcObject = stream;
      await ui.video.play();

      var track = stream.getVideoTracks()[0];
      var caps = (track && track.getCapabilities) ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.indexOf('continuous') !== -1) {
        track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
      }
      if (caps.torch) {
        var on = false;
        ui.torch.style.display = '';
        ui.torch.addEventListener('click', function () {
          on = !on;
          track.applyConstraints({ advanced: [{ torch: on }] }).catch(function () {});
        });
      }

      var decode = await makeDecoder(ui.video);
      if (s.closed) return;
      ui.status.textContent = 'Looking for a code…';

      var tick = async function () {
        if (s.closed) return;
        if (!s.busy) {
          s.busy = true;
          try {
            var raw = await decode();
            var code = raw && String(raw).trim();
            if (code && !s.closed && !(code === s.last && Date.now() - s.lastAt < 2500)) {
              s.last = code; s.lastAt = Date.now();
              feedback(s);
              if (continuous) {
                ui.status.textContent = 'Scanned: ' + code;
                applyCode(input, code, mode);
              } else {
                closeScanner();
                applyCode(input, code, mode);
                return;
              }
            }
          } catch (e) { /* ignore a bad frame */ }
          s.busy = false;
        }
        if (!s.closed) s.timer = setTimeout(tick, 120);
      };
      tick();
    } catch (e) {
      if (!s.closed) ui.status.textContent = errorMessage(e);
    }
  }

  var CAMERA_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';

  function enhance(input) {
    if (input.dataset.scanReady) return;
    input.dataset.scanReady = '1';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Scan with phone camera';
    btn.setAttribute('aria-label', 'Scan with phone camera');
    btn.innerHTML = CAMERA_ICON + '<span style="margin-left:6px">Scan</span>';
    btn.addEventListener('click', function () { openScanner(input); });

    if (input.classList.contains('form-control')) {
      // Bootstrap pages: put the button inside an input-group next to the field.
      var hadFocus = document.activeElement === input;
      var wrap = document.createElement('div');
      wrap.className = 'input-group' + (input.classList.contains('form-control-lg') ? ' input-group-lg' : '');
      btn.className = 'btn btn-outline-secondary';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      wrap.appendChild(btn);
      var pd = window.getComputedStyle(wrap.parentNode).display;
      if (pd === 'flex' || pd === 'inline-flex') { wrap.style.flex = '1 1 auto'; wrap.style.minWidth = '0'; }
      if (hadFocus) input.focus();
    } else {
      // Standalone pages (no Bootstrap): just add a button after the field.
      btn.className = input.dataset.scanBtnClass || 'btn';
      input.parentNode.insertBefore(btn, input.nextSibling);
    }
  }

  function init() { document.querySelectorAll('input[data-scan]').forEach(enhance); }
  if (document.readyState !== 'loading') init(); else document.addEventListener('DOMContentLoaded', init);
  window.addEventListener('pagehide', closeScanner);
  document.addEventListener('visibilitychange', function () { if (document.hidden) closeScanner(); });
})();