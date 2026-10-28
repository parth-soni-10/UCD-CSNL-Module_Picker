/* Animated Counter - a number that rolls into place like an odometer.
 *
 *   <span data-animated-counter>€1,732.93</span>
 *   <span data-animated-counter data-ac-style="plain">1,24,568</span>
 *
 * The host keeps writing its number where it always wrote it. The kit reads the
 * text once, takes the number, the prefix, the suffix and the grouping apart,
 * and draws each digit as its own reel; the original string is kept for screen
 * readers, so assistive technology still hears one number and not eleven glyphs.
 *
 * It rolls the first time the number is seen on screen - a counter below the
 * fold should not finish before anyone looks at it - and any later write through
 * AnimatedCounter.set() rolls from the digit that is showing to the new one
 * instead of restarting from zero.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var REVEAL_AT = 0.35;      // share of the counter that must be on screen
  var ROLL_MS = 820;         // one digit column, start to rest
  var STAGGER_MS = 45;       // each column leaves a little after the one before
  var counters = [];

  function reduced() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* ---- reading the host's number ---------------------------------------- */

  // "€1,732.93" -> prefix "€", value 1732.93, decimals 2, intl grouping.
  function read(text) {
    var raw = String(text).replace(/\u00a0/g, ' ').trim();
    var firstDigit = raw.search(/\d/);
    if (firstDigit < 0) return null;
    var prefix = raw.slice(0, firstDigit);
    var rest = raw.slice(firstDigit);
    // Trailing run of anything that is not a digit, comma or dot is the suffix
    // ("%", " hrs", " credits"), and it keeps its leading space.
    var m = rest.match(/^([\d.,' ]+)(.*)$/);
    if (!m) return null;
    // The body class allows spaces, which is how "0 credits" keeps its gap
    // before the unit; that gap belongs to the suffix, or the unit would be
    // printed against the last digit.
    var body = m[1].replace(/\s+$/, '');
    var gap = m[1].slice(body.length);
    var suffix = gap + (m[2] || '');
    var dot = body.lastIndexOf('.');
    var decimals = dot >= 0 ? body.length - dot - 1 : 0;
    var value = parseFloat(body.replace(/[^\d.]/g, ''));
    if (!isFinite(value)) return null;
    // "1,24,568" groups in twos after the first comma: that is the Indian
    // system, and the same number must be re-grouped the same way on re-roll.
    var indian = /,\d{2},/.test(body);
    return { prefix: prefix, suffix: suffix, value: value, decimals: decimals, indian: indian, text: raw };
  }

  function groupInt(intStr, indian) {
    if (!indian) return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    var last3 = intStr.slice(-3);
    var head = intStr.slice(0, -3);
    if (head) head = head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',';
    return head + last3;
  }

  function format(value, spec) {
    var fixed = Math.abs(value).toFixed(spec.decimals);
    var parts = fixed.split('.');
    var out = groupInt(parts[0], spec.indian);
    if (parts.length > 1) out += '.' + parts[1];
    return (value < 0 ? '-' : '') + out;
  }

  /* ---- drawing ---------------------------------------------------------- */

  function reel(digit) {
    var reelEl = doc.createElement('span');
    reelEl.className = 'ac-reel';
    var col = doc.createElement('span');
    col.className = 'ac-col';
    for (var i = 0; i <= 10; i++) {
      var cell = doc.createElement('span');
      // The eleventh cell is a second 0, so 9 -> 0 rolls forward through the
      // bottom of the column instead of jumping back up over nine digits.
      cell.textContent = String(i % 10);
      col.appendChild(cell);
    }
    reelEl.appendChild(col);
    return { el: reelEl, col: col, digit: digit, pos: 0 };
  }

  function paint(reel, index, animate, delay) {
    var col = reel.col;
    if (!animate || reduced()) {
      col.style.transition = 'none';
      col.style.transform = 'translateY(' + -(index % 10) + 'em)';
      reel.pos = index % 10;
      return;
    }
    col.style.transition = 'transform ' + ROLL_MS + 'ms cubic-bezier(0.16, 1, 0.3, 1) ' + (delay || 0) + 'ms';
    col.style.transform = 'translateY(' + -index + 'em)';
    reel.pos = index;
    if (index > 9) {
      // Indices past nine are a roll that travelled through the bottom of the
      // column (9 -> 0, or the first spin-up). It rests on that digit's own
      // cell, so put the column there with no transition - the two cells look
      // alike, so nobody sees the swap.
      var rest = index % 10;
      setTimeout(function () {
        col.style.transition = 'none';
        col.style.transform = 'translateY(' + -rest + 'em)';
        reel.pos = rest;
      }, ROLL_MS + (delay || 0) + 40);
    }
  }

  function build(state, spec, animate) {
    var host = state.el;
    var label = host.getAttribute('data-ac-label') || spec.prefix + format(spec.value, spec) + spec.suffix;
    while (host.firstChild) host.removeChild(host.firstChild);
    host.classList.add('ac');
    host.setAttribute('aria-label', label);

    var sr = doc.createElement('span');
    sr.className = 'ac-sr';
    sr.setAttribute('aria-hidden', 'true');
    host.appendChild(sr);

    var stage = doc.createElement('span');
    stage.className = 'ac-stage';
    stage.setAttribute('aria-hidden', 'true');
    host.appendChild(stage);

    var shown = format(spec.value, spec);
    // Prefix and suffix are drawn once, outside the stage, so a currency symbol
    // never rides up and down with the digits.
    if (spec.prefix) {
      var pre = doc.createElement('span');
      pre.className = 'ac-fix ac-pre';
      pre.textContent = spec.prefix;
      host.insertBefore(pre, sr);
    }

    state.reels = [];
    var digitsSeen = 0;
    for (var i = 0; i < shown.length; i++) {
      var ch = shown.charAt(i);
      if (ch >= '0' && ch <= '9') {
        var r = reel(Number(ch));
        stage.appendChild(r.el);
        if (animate) paint(r, 10 + Number(ch), true, Math.min(digitsSeen, 6) * STAGGER_MS);
        else paint(r, Number(ch), false);
        state.reels.push(r);
        digitsSeen++;
      } else {
        var fix = doc.createElement('span');
        fix.className = 'ac-fix';
        fix.textContent = ch;
        stage.appendChild(fix);
      }
    }

    if (spec.suffix) {
      var post = doc.createElement('span');
      post.className = 'ac-fix ac-post';
      post.textContent = spec.suffix;
      host.appendChild(post);
    }
    state.spec = spec;
    state.label = label;
  }

  function roll(state) {
    var spec = state.spec;
    var host = state.el;
    var animate = !reduced();
    // Rebuild only when the shape changed (a digit more, a decimal more):
    // otherwise the existing reels roll from where they are.
    var shown = format(spec.value, spec);
    var digits = shown.replace(/\D/g, '').length;
    var label = (state.el.getAttribute('data-ac-label-prefix') || spec.prefix) + shown + spec.suffix;
    host.setAttribute('aria-label', label);

    if (digits !== state.reels.length) {
      build(state, spec, animate);
      return;
    }
    var k = 0;
    for (var i = 0; i < shown.length; i++) {
      var ch = shown.charAt(i);
      if (ch < '0' || ch > '9') continue;
      var target = Number(ch);
      var r = state.reels[k++];
      var from = r.pos % 10;
      var steps = (target - from + 10) % 10;
      var next = r.pos + steps;
      // 9 -> 0 takes the spare cell at the bottom; every other change rolls
      // straight down the column to the digit it wants.
      if (target === 0 && from === 9) next = r.pos + 1;
      paint(r, next, animate, k * STAGGER_MS);
    }
  }

  /* ---- lifecycle -------------------------------------------------------- */

  var observer = null;

  function reveal(state) {
    if (state.shown) return;
    state.shown = true;
    build(state, state.spec, true);
    counters.forEach(function (s) { if (!s.shown && s.el === state.el) s.shown = true; });
  }

  function attach(el) {
    if (!el || el.dataset.acReady) return null;
    var spec = read(el.textContent);
    if (!spec) return null;
    el.dataset.acReady = '1';
    var state = { el: el, spec: spec, reels: [], shown: false };
    counters.push(state);

    if (!global.IntersectionObserver || reduced()) {
      reveal(state);
      return state;
    }
    observer = observer || new global.IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var found = counters.filter(function (s) { return s.el === entry.target; })[0];
        if (found) reveal(found);
        observer.unobserve(entry.target);
      });
    }, { threshold: REVEAL_AT });
    observer.observe(el);
    return state;
  }

  function scan(root) {
    for (var i = counters.length - 1; i >= 0; i--) {
      if (doc.contains(counters[i].el)) continue;
      counters.splice(i, 1);
    }
    var list = root.matches && root.matches('[data-animated-counter]') ? [root] : [];
    if (root.querySelectorAll) list = list.concat(Array.prototype.slice.call(root.querySelectorAll('[data-animated-counter]')));
    list.forEach(function (el) { if (!el.dataset.acReady) attach(el); });
  }

  function boot() {
    scan(doc.body);
    if (!global.MutationObserver) return;
    var pending = 0;
    var queued = [];
    new global.MutationObserver(function (records) {
      Array.prototype.forEach.call(records, function (r) {
        Array.prototype.forEach.call(r.addedNodes, function (n) {
          if (n.nodeType === 1) queued.push(n);
        });
      });
      if (!queued.length || pending) return;
      pending = global.requestAnimationFrame(function () {
        pending = 0;
        var batch = queued;
        queued = [];
        batch.forEach(scan);
      });
    }).observe(doc.body, { childList: true, subtree: true });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.AnimatedCounter = {
    attach: attach,
    refresh: function () { scan(doc.body); },
    // A host that owns the number calls this instead of writing text: the value
    // is kept as a number so the roll has something to travel from.
    set: function (el, value, style) {
      var state = counters.filter(function (s) { return s.el === el; })[0];
      if (!state) return false;
      if (style) state.spec.indian = style === 'indian';
      state.spec.value = Number(value);
      // A host that writes `textContent` first has thrown the reels away; build
      // them again rather than rolling columns that are no longer in the page.
      if (!state.shown || !state.reels.length || !el.contains(state.reels[0].el)) {
        state.shown = true;
        build(state, state.spec, !reduced());
        return true;
      }
      roll(state);
      return true;
    },
    valueOf: function (el) {
      var state = counters.filter(function (s) { return s.el === el; })[0];
      return state ? state.spec.value : null;
    },
    format: format,
  };
})(window);
