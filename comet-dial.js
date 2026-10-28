/* Comet Dial - a stepped number you set by flicking a ring.
 *
 *   <div data-comet-dial data-dial-unit="credits">
 *     <input type="number" min="5" max="120" step="5" aria-label="Target credit total">
 *   </div>
 *
 * The input stays the value: the dial writes into it and dispatches a real
 * `input` event, so every listener the host already has keeps working and the
 * number can still be typed. The ring itself is aria-hidden - the input is the
 * accessible control, and the keyboard path is the input's own arrows.
 *
 * A drag sets the value; a flick coasts and settles on the nearest step. The
 * tail behind the head is the trail the value just travelled, so the gesture
 * reads as motion rather than a knob turning.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var NS = 'http://www.w3.org/2000/svg';
  var SIZE = 148;        // viewBox, and the CSS size the ring is drawn at
  var CX = SIZE / 2;
  var CY = SIZE / 2;
  var R = 62;            // tick radius
  var HEAD_R = 56;       // the head rides just inside the ticks
  var START = 135;       // screen degrees at the minimum (y grows downwards)
  var SWEEP = 270;       // travel from minimum to maximum
  var TRAIL = 74;        // degrees of tail behind the head
  var TRAIL_STEPS = 12;
  var COAST_FRICTION = 0.93;   // per 16ms
  var COAST_STOP = 0.02;       // deg/ms
  var FLICK_MIN = 0.12;        // deg/ms before a release coasts
  var SETTLE_MS = 260;

  var sessions = [];

  function reduced() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }

  function node(name, attrs) {
    var el = doc.createElementNS(NS, name);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) el.setAttribute(k, attrs[k]);
    return el;
  }

  function point(deg, radius) {
    var a = (deg * Math.PI) / 180;
    return { x: CX + radius * Math.cos(a), y: CY + radius * Math.sin(a) };
  }

  function arcPath(from, to, radius) {
    var a = point(from, radius);
    var b = point(to, radius);
    var large = Math.abs(to - from) > 180 ? 1 : 0;
    var dir = to >= from ? 1 : 0;
    return 'M' + a.x.toFixed(2) + ' ' + a.y.toFixed(2) +
      'A' + radius + ' ' + radius + ' 0 ' + large + ' ' + dir + ' ' + b.x.toFixed(2) + ' ' + b.y.toFixed(2);
  }

  function normalise(deg) {
    var d = (deg - START) % 360;
    if (d < 0) d += 360;
    return d;
  }

  function stepsOf(s) { return Math.max(1, Math.round((s.max - s.min) / s.step)); }

  function angleOf(s, value) {
    return START + (SWEEP * clamp(value - s.min, 0, s.max - s.min)) / (s.max - s.min);
  }

  function valueOf(s, deg) {
    var span = normalise(deg);
    // The gap at the bottom belongs to whichever end of the dial is closer.
    if (span > SWEEP) span = span - SWEEP < 45 ? SWEEP : 0;
    var raw = s.min + (span / SWEEP) * (s.max - s.min);
    var snapped = s.min + Math.round((raw - s.min) / s.step) * s.step;
    return clamp(snapped, s.min, s.max);
  }

  function paint(s, deg, value) {
    var headAngle = deg;
    s.head.setAttribute('cx', point(headAngle, HEAD_R).x.toFixed(2));
    s.head.setAttribute('cy', point(headAngle, HEAD_R).y.toFixed(2));
    s.glow.setAttribute('cx', point(headAngle, HEAD_R).x.toFixed(2));
    s.glow.setAttribute('cy', point(headAngle, HEAD_R).y.toFixed(2));

    // Each tail segment is its own arc so the fade needs no gradient along a
    // path (which SVG cannot do): the newest segment is the most opaque.
    for (var i = 0; i < TRAIL_STEPS; i++) {
      var from = headAngle - TRAIL * ((i + 1) / TRAIL_STEPS);
      var to = headAngle - TRAIL * (i / TRAIL_STEPS);
      var seg = s.trail[i];
      seg.setAttribute('d', arcPath(from, to, HEAD_R));
      seg.setAttribute('stroke-opacity', (0.06 + 0.68 * Math.pow(1 - i / TRAIL_STEPS, 1.6)).toFixed(3));
    }

    var passed = value == null ? -1 : value;
    s.ticks.forEach(function (tick) {
      tick.el.setAttribute('stroke-opacity', tick.value <= passed ? '0.85' : '0.22');
    });
  }

  function emit(s, value) {
    s.value = value;
    s.input.value = String(value);
    s.wrap.classList.remove('is-empty');
    s.empty = false;
    var ev;
    try { ev = new global.Event('input', { bubbles: true }); }
    catch (err) { ev = doc.createEvent('Event'); ev.initEvent('input', true, false); }
    // The dial's own write is not the host typing: the input listener below
    // must not read it back as a manual edit and stop the animation that is
    // producing it, or a coast would kill itself on its first frame.
    s.writing = true;
    s.input.dispatchEvent(ev);
    s.writing = false;
  }

  function setValue(s, value, opts) {
    var v = clamp(value, s.min, s.max);
    var changed = v !== s.value;
    s.target = angleOf(s, v);
    if (changed) emit(s, v);
    if (!opts || !opts.silentPaint) paint(s, s.target, s.value);
    return changed;
  }

  function stop(s) {
    if (s.frame) { global.cancelAnimationFrame(s.frame); s.frame = 0; }
    s.coasting = false;
    s.wrap.classList.remove('is-settling');
  }

  function settle(s, deg, velocity) {
    if (reduced()) {
      s.target = angleOf(s, valueOf(s, deg));
      setValue(s, valueOf(s, deg));
      return;
    }
    // Coast first, then ease the last few degrees onto the step: the coast is
    // what the flick earned, the ease is what makes it land instead of stop.
    if (Math.abs(velocity) > FLICK_MIN) { coast(s, deg, velocity); return; }
    snap(s, deg);
  }

  function coast(s, deg, velocity) {
    s.coasting = true;
    var last = global.performance ? global.performance.now() : Date.now();
    function frame(now) {
      var dt = Math.min(48, now - last);
      last = now;
      deg += velocity * dt;
      velocity *= Math.pow(COAST_FRICTION, dt / 16);
      var next = valueOf(s, deg);
      if (next !== s.value) emit(s, next);
      paint(s, deg, s.value);
      if (Math.abs(velocity) > COAST_STOP) {
        s.frame = global.requestAnimationFrame(frame);
      } else {
        s.frame = 0;
        snap(s, deg);
      }
    }
    s.frame = global.requestAnimationFrame(frame);
  }

  function snap(s, deg) {
    var value = valueOf(s, deg);
    emit(s, value);
    var to = angleOf(s, value);
    var from = normalise(deg);
    var toNorm = normalise(to);
    // Take the short way round the gap rather than spinning back through it.
    var delta = toNorm - from;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    var started = global.performance ? global.performance.now() : Date.now();
    s.wrap.classList.add('is-settling');
    function frame(now) {
      var t = clamp((now - started) / SETTLE_MS, 0, 1);
      var eased = 1 - Math.pow(1 - t, 3);
      paint(s, from + delta * eased, value);
      if (t < 1) { s.frame = global.requestAnimationFrame(frame); return; }
      s.frame = 0;
      s.wrap.classList.remove('is-settling');
      paint(s, angleOf(s, value), value);
    }
    s.frame = global.requestAnimationFrame(frame);
  }

  function angleFromEvent(s, ev) {
    var box = s.dial.getBoundingClientRect();
    var cx = box.left + box.width / 2;
    var cy = box.top + box.height / 2;
    var deg = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI;
    return deg < 0 ? deg + 360 : deg;
  }

  function attach(wrap) {
    if (!wrap || wrap.dataset.cdReady) return null;
    var input = wrap.querySelector('input[type="number"], input[type="range"]');
    if (!input) return null;
    wrap.dataset.cdReady = '1';

    var min = parseFloat(input.getAttribute('min'));
    var max = parseFloat(input.getAttribute('max'));
    var step = parseFloat(input.getAttribute('step')) || 1;
    if (!isFinite(min)) min = 0;
    if (!isFinite(max)) max = 100;
    if (max <= min) max = min + step * 10;

    var unit = wrap.getAttribute('data-dial-unit') || '';
    var svg = node('svg', { viewBox: '0 0 ' + SIZE + ' ' + SIZE, focusable: 'false' });
    var dial = doc.createElement('div');
    dial.className = 'cd-dial';
    dial.setAttribute('aria-hidden', 'true');
    dial.appendChild(svg);

    var s = {
      wrap: wrap, input: input, dial: dial, svg: svg,
      min: min, max: max, step: step, value: null, target: START,
      trail: [], ticks: [], frame: 0, dragging: false, coasting: false,
      samples: [], angle: START, empty: true,
    };

    // Track, ticks, trail, head.
    svg.appendChild(node('path', {
      class: 'cd-track',
      d: arcPath(START, START + SWEEP, R),
      fill: 'none',
    }));

    var steps = stepsOf(s);
    var tickCount = steps <= 32 ? steps : 32;
    for (var i = 0; i <= tickCount; i++) {
      var v = min + (steps * i) / tickCount * step;
      var deg = START + (SWEEP * i) / tickCount;
      var outer = point(deg, R + 3);
      var inner = point(deg, R - 5);
      var tick = node('line', {
        class: 'cd-tick',
        x1: outer.x.toFixed(2), y1: outer.y.toFixed(2),
        x2: inner.x.toFixed(2), y2: inner.y.toFixed(2),
        'stroke-opacity': '0.22',
      });
      svg.appendChild(tick);
      s.ticks.push({ el: tick, value: v });
    }

    for (var t = 0; t < TRAIL_STEPS; t++) {
      var seg = node('path', { class: 'cd-trail', fill: 'none', 'stroke-opacity': '0' });
      s.trail.push(seg);
      svg.appendChild(seg);
    }
    var glow = node('circle', { class: 'cd-glow', cx: CX, cy: CY, r: 12, 'fill-opacity': '0.18' });
    var head = node('circle', { class: 'cd-head', cx: CX, cy: CY, r: 5 });
    svg.appendChild(glow);
    svg.appendChild(head);
    s.glow = glow;
    s.head = head;

    wrap.insertBefore(dial, input);
    wrap.classList.add('cd-field');
    input.classList.add('cd-input');
    if (unit) {
      var label = doc.createElement('span');
      label.className = 'cd-unit';
      label.textContent = unit;
      wrap.appendChild(label);
    }

    var initial = parseFloat(input.value);
    if (isFinite(initial)) {
      s.empty = false;
      s.value = clamp(initial, min, max);
      s.target = angleOf(s, s.value);
    } else {
      // Nothing chosen yet: the head rests at the minimum, faded, and the field
      // keeps its placeholder. Touching the dial is what writes a value.
      wrap.classList.add('is-empty');
      s.target = START;
    }
    paint(s, s.target, s.value);

    dial.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      ev.preventDefault();
      stop(s);
      s.dragging = true;
      s.samples = [{ t: ev.timeStamp || 0, deg: angleFromEvent(s, ev) }];
      wrap.classList.add('is-dragging');
      try { dial.setPointerCapture(ev.pointerId); } catch (err) { /* fine without */ }
      var angle = angleFromEvent(s, ev);
      setValue(s, valueOf(s, angle));
    });

    dial.addEventListener('pointermove', function (ev) {
      if (!s.dragging) return;
      var angle = angleFromEvent(s, ev);
      s.samples.push({ t: ev.timeStamp || 0, deg: angle });
      if (s.samples.length > 8) s.samples.shift();
      setValue(s, valueOf(s, angle));
      paint(s, angle, s.value);
    });

    function release(ev) {
      if (!s.dragging) return;
      s.dragging = false;
      wrap.classList.remove('is-dragging');
      var deg = angleFromEvent(s, ev);
      var samples = s.samples;
      var velocity = 0;
      if (samples.length >= 2) {
        var last = samples[samples.length - 1];
        var first = samples[0];
        var dt = last.t - first.t;
        if (dt > 0 && dt < 220) {
          var delta = last.deg - first.deg;
          if (delta > 180) delta -= 360;
          if (delta < -180) delta += 360;
          velocity = delta / dt;
        }
      }
      settle(s, deg, velocity);
    }
    dial.addEventListener('pointerup', release);
    dial.addEventListener('pointercancel', release);

    // Typing (or a host writing the value) moves the dial, not the other way.
    // A manual edit also wins over a coast still running: the number someone
    // just typed must not be overwritten by the flick they gave up on.
    input.addEventListener('input', function () {
      if (s.writing) return;
      stop(s);
      s.dragging = false;
      var v = parseFloat(input.value);
      if (!isFinite(v)) {
        wrap.classList.add('is-empty');
        s.empty = true;
        s.value = null;
        return;
      }
      var snapped = clamp(v, min, max);
      s.value = snapped;
      wrap.classList.remove('is-empty');
      s.target = angleOf(s, snapped);
      if (!s.dragging && !s.coasting) paint(s, s.target, s.value);
    });

    sessions.push(s);
    return s;
  }

  function scan(root) {
    for (var i = sessions.length - 1; i >= 0; i--) {
      if (doc.contains(sessions[i].wrap)) continue;
      stop(sessions[i]);
      sessions.splice(i, 1);
    }
    var list = root.matches && root.matches('[data-comet-dial]') ? [root] : [];
    if (root.querySelectorAll) list = list.concat(Array.prototype.slice.call(root.querySelectorAll('[data-comet-dial]')));
    list.forEach(attach);
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

  global.CometDial = {
    attach: attach,
    refresh: function () { scan(doc.body); },
    valueOf: function (wrap) {
      var s = sessions.filter(function (x) { return x.wrap === wrap; })[0];
      return s ? s.value : null;
    },
  };
})(window);
