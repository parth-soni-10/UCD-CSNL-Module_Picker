/* Orbit — selected modules orbit the term plan.
 *
 * The figure is fed the selection the picker already holds, so it can never
 * disagree with the list beside it. Pointing at an orbiter reads its code and
 * credits; when nothing is selected the plate is empty and the read-out says so.
 *
 * Wrapped in an IIFE: the engine's figures are written at top level, and two of
 * them on one page would collide on their destructured names.
 */
(function () {
const {
  Cam, facing, fit, hull, open, poly, proj, rrect, ringAt, run, seg, circ,
  disposer, mk, pointer,
} = HL;

const ORBIT_R = 38;            // radius of the ring the modules sit on
const ORBIT_N = 8;             // no more than eight orbiters: the plan stays legible
const PLAN_R = 18;             // the term-plan plate
const PLAN_H = 2.4;
const MOD_HW = 6.4, MOD_HD = 4.8, MOD_H = 5;

/** A circle ring offset to (cx, cy), keeping its outward normals. */
function offsetRing(ring, cx, cy) {
  return ring.map((q) => ({ u: q.u + cx, v: q.v + cy, nu: q.nu, nv: q.nv }));
}

/** A cylinder, drawn as the hull of its foot and top rings plus a top crease. */
function discAt(parent, P, front, cx, cy, R, z0, z1) {
  const foot = offsetRing(circ(R, 72), cx, cy);
  const top = offsetRing(circ(R * 0.84, 72), cx, cy);
  const g = mk('g', {}, parent);
  const sil = mk('path', { d: poly(hull(ringAt(P, foot, z0).concat(ringAt(P, top, z1)))), class: 'sil' }, g);
  const cr = mk('path', { d: open(ringAt(P, run(top, front), z1)), class: 'nf lo' }, g);
  return { g, sil, cr };
}

/** A rounded box, drawn the same way. */
function blockAt(parent, P, front, cx, cy, hw, hd, z0, z1, r) {
  const foot = rrect(cx - hw, cy - hd, cx + hw, cy + hd, r, 6);
  const top = rrect(cx - hw + 0.9, cy - hd + 0.9, cx + hw - 0.9, cy + hd - 0.9, Math.max(0.6, r - 0.9), 6);
  const g = mk('g', {}, parent);
  const sil = mk('path', { d: poly(hull(ringAt(P, foot, z0).concat(ringAt(P, top, z1)))), class: 'sil' }, g);
  const cr = mk('path', { d: open(ringAt(P, run(top, front), z1)), class: 'nf lo' }, g);
  return { g, sil, cr };
}

function mount({ stage, svg, read }, value) {
  const bag = disposer();

  // Fitted to the widest pose (a module at the far edge of the ring) so the
  // drawing stays inside the 400 × 320 frame at every selection size.
  const C = Cam(45, 0.5, 2.55);
  fit(C, [[-52, -52, 0], [52, 52, 0], [-52, -52, 12], [52, 52, 12]], 200, 164);
  const P = proj(C), front = facing(C);
  const root = mk('g', {}, svg);

  let items = [];
  let nodes = [];
  let selected = -1;
  // Null, not '', so the first set() builds even when the selection is empty.
  let signature = null;

  function readDefault() {
    const n = items.length;
    const credits = items.reduce((sum, m) => sum + (Number(m.credits) || 0), 0);
    read.textContent = n ? `${n} selected · ${credits} credits` : 'No modules selected';
    stage.setAttribute(
      'aria-label',
      n
        ? `${n} selected module${n === 1 ? '' : 's'} orbiting a term plan; ${credits} credits in total. Point at a module to read its code.`
        : 'No modules selected. The term plan is empty.',
    );
  }

  function build() {
    root.replaceChildren();
    selected = -1;

    const plan = discAt(root, P, front, 0, 0, PLAN_R, 0, PLAN_H);

    // The orbit is a guide, not a solid: a dashed ring at plate height.
    mk('path', {
      d: open(circ(ORBIT_R, 96).map((q) => P(q.u, q.v, PLAN_H + 0.1))),
      class: 'nf dash',
    }, root);

    nodes = items.slice(0, ORBIT_N).map((item, i) => {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / ORBIT_N;
      const cx = Math.cos(a) * ORBIT_R, cy = Math.sin(a) * ORBIT_R;
      const g = mk('g', {}, root);
      // A short spoke ties the module to the plan without crossing the ring.
      mk('path', {
        d: seg(P(cx * 0.56, cy * 0.56, PLAN_H + 0.2), P(cx, cy, PLAN_H + 0.2)),
        class: 'nf lo',
      }, g);
      const box = blockAt(g, P, front, cx, cy, MOD_HW, MOD_HD, PLAN_H, PLAN_H + MOD_H, 1.6);
      return { i, cx, cy, g, box, item };
    });

    // Painter's order: the plan sits at the centre of the ring, so a module
    // behind it (smaller x + y) is drawn first and one in front is drawn last.
    const order = [{ key: 0, g: plan.g }, ...nodes.map((n) => ({ key: n.cx + n.cy, g: n.g }))];
    order.sort((a, b) => a.key - b.key).forEach((o) => root.appendChild(o.g));

    readDefault();
  }

  function highlight(i) {
    if (i === selected) return;
    selected = i;
    nodes.forEach((n, k) => n.box.sil.setAttribute('class', k === i ? 'sil hi' : 'sil'));
    if (i < 0) {
      readDefault();
      return;
    }
    const item = nodes[i].item;
    read.textContent = `${item.code} · ${Number(item.credits) || 0} credits`;
  }

  function pick(pt) {
    const [u, v] = HL.unproj(C, pt[0], pt[1], PLAN_H + MOD_H);
    let best = -1, distance = Infinity;
    nodes.forEach((n, i) => {
      const d = Math.hypot(u - n.cx, v - n.cy);
      if (d < distance && d <= MOD_HW + 3.5) {
        distance = d;
        best = i;
      }
    });
    return best;
  }

  function set(next) {
    const list = next && Array.isArray(next.modules) ? next.modules : [];
    const sig = list.map((m) => `${m.code}:${Number(m.credits) || 0}`).join('|');
    if (sig === signature) return;
    signature = sig;
    items = list;
    build();
  }

  bag.add(pointer(stage, {
    move: (p) => highlight(pick(p)),
    down: (p) => highlight(pick(p)),
    leave: () => highlight(-1),
  }));
  bag.add(() => svg.replaceChildren());

  set(value);
  return { set, destroy: bag.dispose };
}

hairline({
  name: 'orbit',
  means: 'Selected modules orbit a term plan; point at a module to read its code and credits.',
  rules: [1, 4, 6, 8],
  range: [0, 8, 1],
  tour: [[200, 96], [266, 158], [304, 208], null],
  mount,
});
})();
