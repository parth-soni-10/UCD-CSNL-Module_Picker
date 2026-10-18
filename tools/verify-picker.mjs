/**
 * Verify the built picker the way a browser sees it.
 *
 *   PORT=4310 node server.js &
 *   PICKER_BASE_URL=http://127.0.0.1:4310/ node tools/verify-picker.mjs
 *
 * Checks, per viewport: catalogue ready, screenshots in both themes, axe
 * serious/critical in both themes, CSP-violation console, reduced-motion
 * collapse, every mapped component present with a keyboard path, and the
 * service worker being active with a precached app asset. At 1280 it also
 * drives the `?q=&tm=` share round-trip, because that contract is the one
 * thing a user can lose a whole plan to.
 *
 * Exits non-zero with the failing check named. Playwright and axe come from the
 * design system's install so this repository needs no dependency of its own.
 */
import { readFile } from 'node:fs/promises';
import { chromium } from '../../design-system/node_modules/@playwright/test/index.mjs';
import AxeBuilder from '../../design-system/node_modules/@axe-core/playwright/dist/index.mjs';

const base = process.env.PICKER_BASE_URL || 'http://127.0.0.1:4310/';
/**
 * A real selection, encoded the way the share link encodes it. Several
 * components only exist once a plan does (the swipe rows, the semester funds,
 * the saved-selection table), so verifying an empty picker would quietly check
 * nothing. This is the exact string the site wrote after "Add 6 core modules".
 */
const SEED = 'COMP41760:Thu.11:00.LEC.1,COMP41740:Thu.16:00.LEC.1,COMP41400:Mon.16:00.LEC.1,COMP47980:Tue.16:00.LEC.1,COMP47700:Fri.14:00.LEC.1';
const seeded = (params = {}) => {
  const url = new URL(base);
  url.searchParams.set('s', SEED);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
};
const manifest = JSON.parse(await readFile(new URL('../../design-system/coverage.manifest.json', import.meta.url), 'utf8'));
const components = manifest.components.filter((component) => component.sites.includes('module-picker'));
const results = { base, viewports: [], consoleErrors: [], share: null };
const serious = (report) => report.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id);

const browser = await chromium.launch({ headless: true });
try {
  for (const width of [375, 768, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && /refused to|content security policy/i.test(message.text())) errors.push(message.text());
    });

    await page.goto(seeded(), { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.documentElement.classList.contains('catalogue-ready'), undefined, { timeout: 60000 });
    await page.screenshot({ path: `../docs/screenshots/module-picker/${width}.png`, fullPage: true });
    const axeDark = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();

    await page.locator('#theme-toggle').first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `../docs/screenshots/module-picker/${width}-light.png`, fullPage: true });
    const axeLight = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await page.locator('#share-btn').evaluate((node) => getComputedStyle(node).transitionDuration);
    if (Number.parseFloat(reduced) > 0.0001) throw new Error(`reduced motion not collapsed at ${width}px: ${reduced}`);

    const counts = {};
    for (const component of components) {
      const instances = page.locator(`[data-component="${component.id}"]`);
      const count = await instances.count();
      counts[component.id] = count;
      // Presence and reachability per breakpoint are this script's job. The
      // manifest's minInstances are enforced by the shared verify:components run
      // (which drives the reference viewport and the interaction probes), so
      // duplicating that bound here would only couple two independent checks.
      if (count < 1) throw new Error(`${component.id}: not rendered at ${width}px`);
      // Display-only instrumentation (counters, the sticky date header) has no
      // control to focus by design; the manifest says which ones those are.
      if (component.displayOnly) continue;
      const focusable = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],summary,[tabindex="0"]';
      const control = await instances.first().evaluate((node, selector) => node.matches(selector), focusable)
        ? instances.first()
        : instances.first().locator(focusable).first();
      if (!(await control.count())) throw new Error(`${component.id}: no keyboard path at ${width}px`);
      await control.focus();
    }

    const sw = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const registration = await navigator.serviceWorker.ready;
      const keys = await caches.keys();
      return Boolean(registration.active) && keys.length > 0;
    });
    if (!sw) throw new Error(`service worker is not active at ${width}px`);

    if (width === 1280) {
      const shared = seeded({ q: 'COMP', tm: '1' });
      await page.goto(shared, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.documentElement.classList.contains('catalogue-ready'), undefined, { timeout: 60000 });
      const search = await page.locator('#search').inputValue();
      if (!search.toLowerCase().includes('comp')) throw new Error(`share link did not restore the search: got "${search}"`);
      // `tm` is the timetable view term, shown by the semester segment control.
      const sem = await page.locator('#sem-selector [data-sem="1"]').getAttribute('aria-checked');
      if (sem !== 'true') throw new Error(`share link did not restore the Autumn view (tm=1): aria-checked=${sem}`);
      results.share = { search, semesterView: 'autumn', url: page.url() };

      // Share button must produce a URL that keeps the same state, including the plan.
      await page.locator('#share-btn').click();
      const shared2 = page.url();
      if (!/[?&]q=COMP/.test(shared2)) throw new Error(`share button dropped the search: ${shared2}`);
      if (!/[?&]s=/.test(shared2)) throw new Error(`share button dropped the plan: ${shared2}`);
      results.share.sharedUrl = shared2;
    }

    const axeDarkSerious = serious(axeDark);
    const axeLightSerious = serious(axeLight);
    if (axeDarkSerious.length || axeLightSerious.length) throw new Error(`axe serious/critical at ${width}px: dark=${axeDarkSerious.join(',')} light=${axeLightSerious.join(',')}`);
    results.viewports.push({ width, axeSeriousDark: axeDarkSerious, axeSeriousLight: axeLightSerious, reducedMotionTransition: reduced, components: counts, serviceWorker: sw });
    results.consoleErrors.push(...errors.map((message) => `${width}px: ${message}`));
    await context.close();
  }
} finally {
  await browser.close();
}
if (results.consoleErrors.length) throw new Error(JSON.stringify(results.consoleErrors));
console.log(JSON.stringify(results, null, 2));
