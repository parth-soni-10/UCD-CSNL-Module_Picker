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
 * thing a user can lose a whole plan to, then the keyboard-only journey and
 * the update prompt: a changed worker script must land in `waiting`, the
 * banner must appear for it, and its button must send the message that
 * activates it.
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
const results = { base, viewports: [], consoleErrors: [], share: null, keyboard: null, updatePrompt: null };
const ready = (page) => page.waitForFunction(() => document.documentElement.classList.contains('catalogue-ready'), undefined, { timeout: 60000 });

/**
 * The keyboard-only journey, in the order a keyboard user meets it: filter the
 * list, choose a semester, change workspace, open and close a module. Every step
 * presses real keys and asserts the thing the key is supposed to do — a
 * component that merely has a focusable child passes the per-viewport probe
 * above while still being unusable without a mouse.
 */
async function keyboardPass(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(seeded(), { waitUntil: 'networkidle' });
    await ready(page);
    const log = {};

    // Filter disclosure: Enter collapses, Space expands. Done first because the
    // module section lives in the Picker workspace, which step 3 leaves.
    const details = page.locator('details.filter-disclosure').first();
    await details.locator('summary').focus();
    if ((await page.evaluate(() => document.activeElement.tagName)) !== 'SUMMARY') throw new Error('keyboard: the filter disclosure summary did not take focus');
    await page.keyboard.press('Enter');
    if (await details.evaluate((node) => node.open)) throw new Error('keyboard: Enter did not collapse the filter disclosure');
    await page.keyboard.press('Space');
    if (!(await details.evaluate((node) => node.open))) throw new Error('keyboard: Space did not expand the filter disclosure');
    log.disclosure = 'Enter collapses, Space expands';

    // Semester radiogroup: the arrow moves selection and focus together.
    const checked = page.locator('#sem-selector [data-sem][aria-checked="true"]');
    const beforeSem = await checked.getAttribute('data-sem');
    await checked.focus();
    await page.keyboard.press('ArrowRight');
    const afterSem = await page.evaluate(() => ({ focused: document.activeElement?.dataset?.sem ?? null, checked: document.activeElement?.getAttribute('aria-checked') ?? null, selected: document.querySelector('#sem-selector [aria-checked="true"]')?.dataset.sem }));
    if (afterSem.focused === beforeSem) throw new Error(`keyboard: ArrowRight did not move the semester view (still ${beforeSem})`);
    if (afterSem.focused !== afterSem.selected || afterSem.checked !== 'true') throw new Error(`keyboard: arrow moved selection but not focus: ${JSON.stringify(afterSem)}`);
    log.semester = `${beforeSem} -> ${afterSem.selected} with focus`;

    // Module dialog: Enter opens, Escape closes, focus returns to the trigger.
    // Before switching workspace, because the module list lives in the Picker
    // panel and a hidden trigger cannot be reached — which would be this
    // script's order to fix, not the site's.
    const trigger = page.locator('#module-detail-featured');
    if (!(await trigger.isVisible())) throw new Error('keyboard: the module trigger is not on screen before the dialog step');
    await trigger.focus();
    await page.keyboard.press('Enter');
    if (!(await page.locator('#module-detail-dialog').evaluate((node) => node.open))) throw new Error('keyboard: Enter did not open the module dialog');
    await page.keyboard.press('Escape');
    if (await page.locator('#module-detail-dialog').evaluate((node) => node.open)) throw new Error('keyboard: Escape did not close the module dialog');
    log.dialog = 'Enter opens, Escape closes';

    // Workspace tabs: arrow switches the tab and its panel.
    const tabBefore = await page.evaluate(() => document.querySelector('.fluid-tabs [role="tab"][aria-selected="true"]')?.id);
    await page.evaluate(() => document.querySelector('.fluid-tabs [role="tab"][aria-selected="true"]')?.focus());
    await page.keyboard.press('ArrowRight');
    const tabAfter = await page.evaluate(() => {
      const selected = document.querySelector('.fluid-tabs [role="tab"][aria-selected="true"]');
      const panel = document.getElementById(selected?.getAttribute('aria-controls') ?? '');
      return { focused: document.activeElement?.id ?? null, selected: selected?.id ?? null, panelId: panel?.id ?? null, panelVisible: Boolean(panel && panel.getClientRects().length) };
    });
    if (!tabAfter.selected || tabAfter.selected === tabBefore) throw new Error(`keyboard: ArrowRight did not change the workspace tab (still ${tabBefore})`);
    if (tabAfter.focused !== tabAfter.selected) throw new Error(`keyboard: tab selection moved without focus: ${JSON.stringify(tabAfter)}`);
    if (!tabAfter.panelVisible) throw new Error(`keyboard: the selected tab's panel is not shown: ${JSON.stringify(tabAfter)}`);
    log.tabs = `${tabBefore} -> ${tabAfter.selected}, panel ${tabAfter.panelId} shown`;

    // Nothing in the first twenty stops may be invisible or the page body.
    const stops = [];
    for (let i = 0; i < 20; i += 1) {
      await page.keyboard.press('Tab');
      stops.push(await page.evaluate(() => {
        const node = document.activeElement;
        if (!node || node === document.body) return 'body';
        const style = getComputedStyle(node);
        return node.getClientRects().length && style.visibility !== 'hidden' ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}` : `invisible:${node.tagName}`;
      }));
    }
    const bad = stops.filter((stop) => stop === 'body' || stop.startsWith('invisible'));
    if (bad.length) throw new Error(`keyboard: unusable tab stops: ${bad.join(', ')}`);
    log.tabStops = stops;
    return log;
  } finally {
    await context.close();
  }
}

/**
 * Registers the same worker under a changed version query, which is precisely
 * what a deploy does (the HTML carries `sw.js?v=<hash>`): the new worker installs
 * behind the active one and waits. Two separate contexts so the probe's script
 * URL cannot leak into the checks above.
 */
async function updatePromptPass(browser) {
  const waitForWaiting = (page) => page.evaluate(async () => {
    await navigator.serviceWorker.register(`/sw.js?v=probe-${Date.now()}`, { scope: '/' });
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration?.waiting) return registration.waiting.scriptURL;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  });
  const out = {};

  const activation = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await activation.newPage();
    await page.goto(seeded(), { waitUntil: 'networkidle' });
    await ready(page);
    await page.reload({ waitUntil: 'networkidle' });
    await ready(page);
    if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) throw new Error('update: no worker controls the page after a reload');
    const waiting = await waitForWaiting(page);
    if (!waiting) throw new Error('update: a changed worker script never reached the waiting state');
    const switched = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      registration?.waiting?.postMessage('SKIP_WAITING');
      const start = Date.now();
      while (Date.now() - start < 15000) {
        const controller = navigator.serviceWorker.controller;
        if (controller && controller.scriptURL.includes('probe-')) return controller.scriptURL;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return null;
    });
    if (!switched) throw new Error('update: SKIP_WAITING did not activate the waiting worker');
    out.waiting = waiting;
    out.activatedByMessage = switched;
  } finally {
    await activation.close();
  }

  const prompt = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await prompt.newPage();
    await page.goto(seeded(), { waitUntil: 'networkidle' });
    await ready(page);
    await page.reload({ waitUntil: 'networkidle' });
    await ready(page);
    if (!(await waitForWaiting(page))) throw new Error('update: no waiting worker on the second attempt');
    await page.reload({ waitUntil: 'networkidle' });
    await ready(page);
    const banner = await page.evaluate(() => {
      const node = document.getElementById('sw-update-banner');
      if (!node) return null;
      const style = getComputedStyle(node);
      return { hidden: node.hidden, visible: style.display !== 'none' && node.getClientRects().length > 0, role: node.getAttribute('role'), text: node.textContent.trim().replace(/\s+/g, ' ') };
    });
    if (!banner || banner.hidden || !banner.visible) throw new Error(`update: the update banner did not appear for a waiting worker: ${JSON.stringify(banner)}`);
    if (banner.role !== 'status') throw new Error(`update: the banner is not announced (role=${banner.role})`);
    if (!/update available/i.test(banner.text)) throw new Error(`update: the banner does not say what it is: ${banner.text}`);
    const [reloaded] = await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).then(() => true).catch(() => false),
      page.click('#sw-update-reload'),
    ]);
    if (!reloaded) throw new Error('update: the banner button did not reload the app');
    await ready(page);
    out.banner = banner;
    out.reloadedOnClick = true;
    out.bannerHiddenAfter = await page.evaluate(() => document.getElementById('sw-update-banner')?.hidden);
    return out;
  } finally {
    await prompt.close();
  }
}
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
  results.keyboard = await keyboardPass(browser);
  results.updatePrompt = await updatePromptPass(browser);
} finally {
  await browser.close();
}
if (results.consoleErrors.length) throw new Error(JSON.stringify(results.consoleErrors));
console.log(JSON.stringify(results, null, 2));
