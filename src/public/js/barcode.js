// Dependency-free Code 128-B barcode renderer (SVG). Codes here (A-Z, 0-9, '-')
// are all within Code 128-B, so scanners read the exact label string back.
(function () {
  // Module-width patterns for symbols 0..106 (index 106 = stop, 13 modules).
  var W = ["212222","222122","222221","121223","121322","131222","122213","122312","132212","221213",
  "221312","231212","112232","122132","122231","113222","123122","123221","223211","221132",
  "221231","213212","223112","312131","311222","321122","321221","312212","322112","322211",
  "212123","212321","232121","111323","131123","131321","112313","132113","132311","211313",
  "231113","231311","112133","112331","132131","113123","113321","133121","313121","211331",
  "231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
  "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214",
  "112412","122114","122411","142112","142211","241211","221114","413111","241112","134111",
  "111242","121142","121241","114212","124112","124211","411212","421112","421211","212141",
  "214121","412121","111143","111341","131141","114113","114311","411113","411311","113141",
  "114131","311141","411131","211412","211214","211232","2331112"];

  function encode(text) {
    var codes = [104], sum = 104; // Start B
    for (var i = 0; i < text.length; i++) {
      var v = text.charCodeAt(i) - 32;
      if (v < 0 || v > 94) v = 0;
      codes.push(v); sum += (i + 1) * v;
    }
    codes.push(sum % 103); // checksum
    codes.push(106);       // stop
    return codes;
  }

  window.barcodeSVG = function (text, opt) {
    opt = opt || {};
    var mw = opt.moduleWidth || 2, h = opt.height || 44, showText = opt.showText !== false, fs = opt.fontSize || 11, pad = 10;
    var codes = encode(text), x = pad, bars = "";
    for (var c = 0; c < codes.length; c++) {
      var w = W[codes[c]], isBar = true;
      for (var k = 0; k < w.length; k++) {
        var width = parseInt(w[k], 10) * mw;
        if (isBar) bars += '<rect x="' + x + '" y="0" width="' + width + '" height="' + h + '"/>';
        x += width; isBar = !isBar;
      }
    }
    var totalW = x + pad, svgH = h + (showText ? fs + 6 : 0);
    var txt = showText ? '<text x="' + (totalW / 2) + '" y="' + (h + fs + 2) + '" text-anchor="middle" font-family="monospace" font-size="' + fs + '" fill="black">' + text + '</text>' : "";
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + totalW + '" height="' + svgH + '" viewBox="0 0 ' + totalW + ' ' + svgH + '">' +
           '<rect width="' + totalW + '" height="' + svgH + '" fill="white"/><g fill="black">' + bars + '</g>' + txt + '</svg>';
  };

  window.renderBarcodes = function () {
    document.querySelectorAll('[data-barcode]').forEach(function (el) {
      el.innerHTML = window.barcodeSVG(el.getAttribute('data-barcode'), {
        moduleWidth: +(el.getAttribute('data-mw') || 2), height: +(el.getAttribute('data-h') || 40)
      });
    });
  };
  if (document.readyState !== 'loading') window.renderBarcodes();
  else document.addEventListener('DOMContentLoaded', window.renderBarcodes);
})();
