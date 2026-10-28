/* Switch Mode - the theme toggle's two glyphs, swapping like a wheel.
 *
 *   <button type="button" role="switch" aria-checked="false" data-switch-mode>
 *     <svg class="icon-sun">…</svg>
 *     <svg class="icon-moon">…</svg>
 *   </button>
 *
 *   SwitchMode.mount(btn)
 *
 * The host keeps everything that decides the theme: its button, its aria
 * state, its storage and its click handler. The kit draws one movement on top -
 * the outgoing glyph rolls out of the circle while the incoming one rolls in
 * from the other side - so a flip reads as a mode change rather than two icons
 * trading places.
 *
 * Which glyph belongs to which state is not assumed: at mount the kit reads the
 * host's own state and the host's own CSS, and whichever icon the host is
 * displaying is the icon for the state it is in. That covers both conventions
 * in the wild - a sun shown while light, and (the one this kit was built for) a
 * moon shown while light because it names the mode you would switch to.
 *
 * The state is read from the button, in the platforms' order: aria-checked,
 * aria-pressed, data-on / .on / .active, then the document's own data-theme. A
 * host whose button carries none of those can still be driven: change an
 * attribute it owns, or call SwitchMode.refresh().
 *
 * A button with fewer than two icons is left alone: there is nothing to swap,
 * and a decorative movement over a host that repaints one icon per flip would
 * be a fiction. Reduce-motion gets an instant swap.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var mounted = [];

  var SUN = ['icon-sun', 'sm-sun'];
  var MOON = ['icon-moon', 'sm-moon'];

  function hasClass(el, names) {
    for (var i = 0; i < names.length; i++) if (el.classList.contains(names[i])) return true;
    return false;
  }

  /* The two glyphs, fresh from the DOM every time: a host that rebuilds its
     button hands us new nodes, and stale references would animate nothing. */
  function glyphsOf(btn) {
    var found = { sun: null, moon: null };
    var icons = btn.querySelectorAll('svg, i');
    for (var i = 0; i < icons.length; i++) {
      var el = icons[i];
      if (!found.sun && hasClass(el, SUN)) found.sun = el;
      else if (!found.moon && hasClass(el, MOON)) found.moon = el;
    }
    // No useful class names: two icons in the order they are drawn.
    if (!found.sun && !found.moon && icons.length === 2) {
      found.sun = icons[0];
      found.moon = icons[1];
    }
    return found;
  }

  function isDark(btn) {
    var checked = btn.getAttribute('aria-checked');
    if (checked != null) return checked === 'true';
    var pressed = btn.getAttribute('aria-pressed');
    if (pressed != null) return pressed === 'true';
    var on = btn.getAttribute('data-on');
    if (on != null) return on === 'true';
    if (btn.classList.contains('on') || btn.classList.contains('active')) return true;
    return doc.documentElement.getAttribute('data-theme') === 'dark';
  }

  function shown(el) {
    if (!el || !el.getClientRects().length) return false;
    return global.getComputedStyle(el).display !== 'none';
  }

  function mount(btn) {
    if (!btn) return null;
    if (btn.__switchMode) return btn.__switchMode;

    var pair = glyphsOf(btn);
    if (!pair.sun || !pair.moon) return null;   // nothing to swap; leave the host alone

    btn.classList.add('switch-mode');
    pair.sun.setAttribute('data-sm-role', 'sun');
    pair.moon.setAttribute('data-sm-role', 'moon');
    var bootDisplay = { sun: pair.sun.style.display, moon: pair.moon.style.display };

    var current = null;      // the glyph the kit is showing; set by the first paint
    var lastDark = null;     // the host's state at the last paint

    // Both glyphs are laid out by the kit; the host's own rule would hide one.
    function layOut() {
      pair.sun.style.display = 'block';
      pair.moon.style.display = 'block';
    }

    /* Which glyph the host wants on screen *right now*, asked of the host's own
       CSS: with the kit's inline display off for an instant, exactly one of the
       two is displayed (or neither, or both - then there is no answer and the
       names decide). Read live rather than at mount, because a host that
       decides its theme in JS (CSNL's applyTheme runs after its data lands) is
       briefly in neither state, and a mapping locked in then would be a flip
       behind for the life of the page. Only display is touched, and display is
       not transitioned, so a swap in flight is not disturbed. */
    function hostGlyph() {
      var sunSaved = pair.sun.style.display;
      var moonSaved = pair.moon.style.display;
      pair.sun.style.display = '';
      pair.moon.style.display = '';
      var sunShown = shown(pair.sun);
      var moonShown = shown(pair.moon);
      pair.sun.style.display = sunSaved;
      pair.moon.style.display = moonSaved;
      if (sunShown && !moonShown) return 'sun';
      if (moonShown && !sunShown) return 'moon';
      return null;
    }

    function park(el, side) {
      if (side) el.setAttribute('data-sm-park', side);
      else el.removeAttribute('data-sm-park');
    }

    /* Placing without animating: a flip is the only thing that should move these
       glyphs. transform and opacity are composited, and a same-frame "set the
       value, then take transition:none off" lets the compositor interpolate from
       the old value anyway - the parked glyph visibly slides out on first paint.
       So the class comes off on the next frame, once the new values have been
       recorded. */
    var release = 0;
    function quietPlace(resting, parked) {
      resting.classList.add('is-instant');
      parked.classList.add('is-instant');
      void resting.offsetWidth;
      if (release) global.cancelAnimationFrame(release);
      release = global.requestAnimationFrame(function () {
        release = 0;
        resting.classList.remove('is-instant');
        parked.classList.remove('is-instant');
      });
    }

    /* Draw the state the host is in now. quiet = place without animating (first
       paint, a rebuild, a resize) - the state is the same, only the movement is
       withheld. */
    function paint(quiet) {
      if (settle) { global.cancelAnimationFrame(settle); settle = 0; }
      var now = glyphsOf(btn);
      if (!now.sun || !now.moon) return;
      if (now.sun !== pair.sun || now.moon !== pair.moon) {
        pair.sun.removeAttribute('data-sm-role');
        pair.moon.removeAttribute('data-sm-role');
        pair = now;
        pair.sun.setAttribute('data-sm-role', 'sun');
        pair.moon.setAttribute('data-sm-role', 'moon');
        layOut();
        quiet = true;                      // the host already swapped them itself
      }

      // For CSS hooks and for reading the page in a debugger - the kit's own
      // rules do not depend on it, because which glyph means "dark" is the
      // host's business and is read from the host.
      btn.setAttribute('data-sm-state', isDark(btn) ? 'dark' : 'light');
      var resting = current === 'sun' ? pair.sun : pair.moon;
      var parked = current === 'sun' ? pair.moon : pair.sun;
      park(resting, null);
      if (!parked.getAttribute('data-sm-park')) {
        // The sun leaves upward on the way to dark (it is setting) and the moon
        // leaves downward on the way back, so each glyph returns the way it
        // came and two flips read as one wheel turning.
        park(parked, parked === pair.sun ? 'up' : 'down');
      }
      if (quiet) quietPlace(resting, parked);
    }

    /* A flip animates; everything else is a re-measure. The distinction is the
       host's state, not the glyph: a host whose CSS settles late (a theme set
       after its data arrives) must be corrected quietly, not made to dance. */
    function refresh() {
      var dark = isDark(btn);
      var stateChanged = lastDark != null && dark !== lastDark;
      lastDark = dark;
      var next = hostGlyph() || (dark ? 'moon' : 'sun');
      var flipped = next !== current;
      current = next;
      if (stateChanged && flipped) {
        /* The read above may have switched a glyph's display off and on inside
           this frame, and an element that changed display is a new box to the
           compositor: a transition started in that same frame is dropped, which
           is exactly the glyph the host hides in the state it just moved to -
           the one that should be leaving. One frame of patience and both of
           them animate. */
        if (settle) global.cancelAnimationFrame(settle);
        settle = global.requestAnimationFrame(function () { settle = 0; paint(false); });
        return;
      }
      paint(true);
    }

    var raf = 0;
    var settle = 0;                        // a flip's paint, one frame after its read
    function schedule() {
      if (raf) return;
      raf = global.requestAnimationFrame(function () { raf = 0; refresh(); });
    }

    /* Watch the button's own state and its children. The attribute list is what
       keeps this a two-way door: the kit's own writes to the button (the
       data-sm-state flag) are not in it, so a paint cannot schedule the next
       paint - a renderer that never goes idle. */
    var mo = global.MutationObserver ? new global.MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].target === btn) { schedule(); return; }
      }
    }) : null;
    if (mo) mo.observe(btn, {
      childList: true,
      attributes: true,
      attributeFilter: ['aria-checked', 'aria-pressed', 'class', 'data-on', 'data-theme'],
    });

    // A host that flips the document's theme without touching its button still
    // moves the toggle it owns.
    var rootMo = global.MutationObserver ? new global.MutationObserver(schedule) : null;
    if (rootMo) rootMo.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    var onResize = function () { layOut(); paint(true); };
    global.addEventListener('resize', onResize, { passive: true });

    // The first paint is a refresh with no previous state: it derives which
    // glyph the host is showing from the host's own CSS, then places both
    // without animating.
    layOut();
    refresh();

    var api = {
      btn: btn,
      refresh: refresh,
      destroy: function () {
        if (mo) mo.disconnect();
        if (rootMo) rootMo.disconnect();
        if (raf) { global.cancelAnimationFrame(raf); raf = 0; }
        if (release) { global.cancelAnimationFrame(release); release = 0; }
        global.removeEventListener('resize', onResize);
        btn.classList.remove('switch-mode');
        btn.removeAttribute('data-sm-state');
        var refs = btn.querySelectorAll('[data-sm-role]');
        for (var i = 0; i < refs.length; i++) {
          refs[i].removeAttribute('data-sm-role');
          refs[i].removeAttribute('data-sm-park');
          refs[i].classList.remove('is-instant');
        }
        // Hand the host's own display back, as it was when the kit arrived.
        if (pair.sun.isConnected) pair.sun.style.display = bootDisplay.sun;
        if (pair.moon.isConnected) pair.moon.style.display = bootDisplay.moon;
        btn.__switchMode = null;
        mounted = mounted.filter(function (m) { return m !== api; });
      },
    };
    btn.__switchMode = api;
    mounted.push(api);
    return api;
  }

  function scan(root) {
    // A host that repaints its header leaves the old mount watching a detached
    // button, and its window resize listener registered for the life of the
    // page - one per render. Drop the dead mounts before adding the new one.
    mounted.slice().forEach(function (m) {
      if (!m.btn.isConnected) m.destroy();
    });

    var list = [];
    if (root.matches && root.matches('[data-switch-mode]')) list.push(root);
    if (root.querySelectorAll) {
      list = list.concat(Array.prototype.slice.call(root.querySelectorAll('[data-switch-mode]')));
    }
    list.forEach(function (btn) { mount(btn); });
  }

  function boot() {
    scan(doc.body);
    if (!global.MutationObserver) return;
    var queued = [];
    var raf = 0;
    new global.MutationObserver(function (records) {
      Array.prototype.forEach.call(records, function (r) {
        Array.prototype.forEach.call(r.addedNodes, function (node) {
          if (node.nodeType === 1) queued.push(node);
        });
      });
      if (!queued.length || raf) return;
      raf = global.requestAnimationFrame(function () {
        raf = 0;
        var batch = queued;
        queued = [];
        batch.forEach(scan);
      });
    }).observe(doc.body, { childList: true, subtree: true });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.SwitchMode = {
    mount: mount,
    refresh: function () { mounted.forEach(function (m) { m.refresh(); }); },
  };
})(window);
