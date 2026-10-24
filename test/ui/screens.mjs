// Screen tests: drive the real app in a phone-sized Chromium, the way a thumb would, and check what the screen does.
//   npm run test:ui          (needs Playwright: CI installs it; locally: npm install --no-save playwright && npx playwright install chromium)
// The app runs against the same stand-in servers as the other tests (LTA, OneMap, push), and a stand-in for the map
// library (fake-leaflet.js), so no network or keys are needed. The real map drawing is not tested here.
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createRequire } from 'node:module';
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch {} }   // also finds a copy installed elsewhere (NODE_PATH)
if (!chromium) { console.error('Playwright is not installed. Run: npm install --no-save playwright && npx playwright install chromium'); process.exit(1); }

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const out = path.join(root, '.tmp', 'worker.ui.js');
mkdirSync(path.dirname(out), { recursive: true });
const build = spawnSync(process.execPath, [path.join(root, 'build-worker.mjs')], { env: { ...process.env, STOPS_FILE: path.join(root, 'test', 'fixtures', 'stops.json'), OUT_FILE: out, GIT_SHA: 'uitest00' }, encoding: 'utf8' });
if (build.status !== 0) { console.error(build.stdout + build.stderr); process.exit(1); }

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => { if (cond) passed += 1; else failed += 1; console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : extra); };

// --- the app and its stand-in servers
const lta = spawn(process.execPath, [path.join(root, 'test', 'stubs', 'lta-stub.mjs')], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const { server: onemap } = await import(pathToFileURL(path.join(root, 'test', 'stubs', 'onemap-stub.mjs')).href); onemap.listen(3288);
const push = await import(pathToFileURL(path.join(root, 'test', 'stubs', 'push-stub.mjs')).href); push.server.listen(3299);
const worker = (await import(pathToFileURL(out).href)).default;
const store = new Map();
const env = { LTA_ACCOUNT_KEY: 'testkey', LTA_BASE: 'http://127.0.0.1:3222/ltaodataservice', ONEMAP_BASE: 'http://127.0.0.1:3288', ONEMAP_EMAIL: 'me@example.com', ONEMAP_PASSWORD: 'pw',
  VAPID_PUBLIC_KEY: push.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: push.VAPID_PRIVATE_KEY, PUSH_TEST_HOST: '127.0.0.1:3299', DEDUPE_OFF: '1',
  KV: { get: async (k, t) => (store.has(k) ? (t === 'json' ? JSON.parse(store.get(k)) : store.get(k)) : null), put: async (k, v) => store.set(k, v), delete: async (k) => store.delete(k) } };
const PORT = 3703, APP = `http://localhost:${PORT}`;
const app = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request(APP + req.url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT);
const fakeLeaflet = readFileSync(path.join(here, 'fake-leaflet.js'), 'utf8');

const browser = await chromium.launch();
const al = (id, days, from, to) => ({ id, days, dates: [], from, to, every: 5 });
const TWO_STOPS = { stops: [
  { code: '01012', name: 'Hotel Grand Pacific', followed: ['74'], threshold: 10, alarms: [al('a', [1, 2, 3, 4, 5], '07:30', '09:00'), al('b', [6, 0], '10:00', '11:00'), al('c', [1], '12:00', '13:00')] },
  { code: '83139', name: 'Bugis Stn', followed: ['74'], threshold: 10, alarms: [al('e', [2, 4], '17:30', '18:30')] }], alertsOn: true,
  places: [{ name: 'Office', address: '200 VICTORIA STREET', lat: 1.29911, lng: 103.8556 }] };

// A phone: 400 x 700, touch, Singapore time. `permission` is what the notification prompt answers; `seed` is the saved app data.
async function phone({ seed = TWO_STOPS, permission = 'granted', granted = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 700 }, hasTouch: true, isMobile: true, timezoneId: 'Asia/Singapore',
    geolocation: { latitude: 1.3521, longitude: 103.8198 }, permissions: ['geolocation'] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://unpkg.com/**', (r) => (r.request().url().endsWith('.js') ? r.fulfill({ body: fakeLeaflet, contentType: 'text/javascript' }) : r.fulfill({ body: '', contentType: 'text/css' })));
  await page.addInitScript(([keys, seed, permission, granted]) => {
    const sub = { endpoint: 'http://127.0.0.1:3299/push/ui', toJSON() { return { endpoint: this.endpoint, keys }; }, unsubscribe: async () => true };
    let subscribed = granted;
    Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', { get: () => ({ getSubscription: async () => (subscribed ? sub : null), subscribe: async () => { subscribed = true; return sub; } }) });
    let perm = sessionStorage.getItem('perm') || (granted ? 'granted' : 'default');
    window.__asked = 0;
    Object.defineProperty(Notification, 'permission', { get: () => perm });
    Notification.requestPermission = async () => { window.__asked += 1; perm = permission; sessionStorage.setItem('perm', perm); return perm; };
    if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.clear(); localStorage.setItem('mybuses.v1', JSON.stringify(seed)); }
  }, [push.keys, seed, permission, granted]);
  await page.goto(APP); await page.waitForTimeout(2500);
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const drag = async (x1, y1, x2, y2, steps = 12) => { await touch('touchStart', x1, y1); for (let i = 1; i <= steps; i += 1) { await touch('touchMove', x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps); await page.waitForTimeout(16); } await touch('touchEnd'); await page.waitForTimeout(700); };
  const scrollY = () => page.evaluate(() => Math.round(window.scrollY));
  const box = (sel) => page.locator(sel).first().boundingBox();
  const settle = async () => { let last = -1; for (let i = 0; i < 30; i += 1) { const y = await scrollY(); if (y === last) return; last = y; await page.waitForTimeout(150); } };
  // Tap where the element is on screen now, without the test tool scrolling it into view first. If something else is on top of
  // that spot (the floating button, say), fail loudly instead of tapping the wrong thing.
  const tapHere = async (sel) => {
    const b = await box(sel), x = b.x + b.width / 2, y = b.y + b.height / 2;
    const hit = await page.locator(sel).first().evaluate((t, [x, y]) => { const e = document.elementFromPoint(x, y); return !!(e && (t === e || t.contains(e))); }, [x, y]);
    if (!hit) throw new Error(`${sel} is covered at the spot a finger would tap`);
    await page.touchscreen.tap(x, y);
  };
  return { ctx, page, errors, drag, scrollY, box, tapHere, settle };
}
const onScreen = (b) => b && b.y >= 110 && b.y + Math.min(b.height, 480) <= 700;

// --- 1. Pages and tabs: tap a tab, swipe between pages; the highlight follows
{
  const { ctx, page, errors, drag } = await phone();
  const shown = () => page.evaluate(() => ({ bus: document.getElementById('page-bus').getBoundingClientRect().left, trip: document.getElementById('trip').getBoundingClientRect().left, on: document.querySelector('#tabs button.on').dataset.tab }));
  ok('opens on the Buses page', (await shown()).on === 'bus' && (await shown()).bus === 16, JSON.stringify(await shown()));
  await page.locator('#tabs button[data-tab=trip]').tap(); await page.waitForTimeout(900);
  ok('tapping the Trips tab slides to Trips', (await shown()).on === 'trip' && (await shown()).trip === 16, JSON.stringify(await shown()));
  await drag(70, 420, 330, 420);
  ok('swiping right goes back to Buses', (await shown()).on === 'bus' && (await shown()).bus === 16, JSON.stringify(await shown()));
  await drag(330, 420, 70, 420);
  ok('swiping left goes to Trips', (await shown()).on === 'trip', JSON.stringify(await shown()));
  // swipes that start outside the panels: the empty space under the short Trips page, and the top bar
  ok('the Trips page is short enough to leave empty space below it', await page.evaluate(() => document.getElementById('trip').getBoundingClientRect().bottom < 600));
  await drag(80, 650, 320, 650);
  ok('swiping on the empty space below the panel goes to Buses', (await shown()).on === 'bus' && (await shown()).bus === 16, JSON.stringify(await shown()));
  await drag(320, 35, 80, 35);
  ok('swiping on the top bar goes to Trips', (await shown()).on === 'trip' && (await shown()).trip === 16, JSON.stringify(await shown()));
  await drag(200, 650, 160, 652, 20);
  ok('a short, slow nudge outside the panels springs back', (await shown()).on === 'trip' && (await shown()).trip === 16, JSON.stringify(await shown()));
  await page.evaluate(() => { window.scrollTo(0, 0); }); const y0 = await page.evaluate(() => window.scrollY);
  ok('page snapping is back on after the swipe', await page.evaluate(() => document.getElementById('pager').style.scrollSnapType === ''), String(y0));
  await page.reload(); await page.waitForTimeout(2500);
  ok('reopening the app returns to the last page', (await shown()).on === 'trip', JSON.stringify(await shown()));
  ok('no script errors (pages)', !errors.length, errors.join(' | '));
  await ctx.close();
}

// --- 2. Buses page: adding and editing never throws the screen around
{
  const { ctx, page, errors, scrollY, box, tapHere, settle } = await phone();
  const s2 = '.stop[data-code="83139"]';
  await page.locator(`${s2} button.secondary.small`).evaluate((e) => e.scrollIntoView({ block: 'center' })); await page.waitForTimeout(300);
  const y0 = await scrollY();
  await tapHere(`${s2} button.secondary.small`); await page.waitForTimeout(900);
  ok('"Add an alert time" on a lower stop keeps the screen there', (await scrollY()) >= y0 - 5, `${y0} -> ${await scrollY()}`);
  ok('...and the new alert editor is fully on screen', onScreen(await box(`${s2} .alarm:not(.alarm-line)`)), JSON.stringify(await box(`${s2} .alarm:not(.alarm-line)`)));
  const y1 = await scrollY();
  await tapHere(`${s2} .alarm:not(.alarm-line) .chip`); await page.waitForTimeout(600);
  ok('tapping a day does not jump to the top', (await scrollY()) > 100 && Math.abs((await scrollY()) - y1) < 80, `${y1} -> ${await scrollY()}`);
  await tapHere(`${s2} .alarm-actions button:has-text("Done")`); await page.waitForTimeout(800);
  ok('"Done" folds it and keeps it in view', onScreen(await box(`${s2} .alarm-line >> nth=-1`)) && (await scrollY()) > 100, String(await scrollY()));
  await page.locator(`${s2} .icon-btn`).first().evaluate((e) => e.scrollIntoView({ block: 'center' })); await page.waitForTimeout(300);
  const yb = await scrollY();
  await tapHere(`${s2} .icon-btn`); await page.waitForTimeout(600);
  ok('the gear (choose buses) does not jump', Math.abs((await scrollY()) - yb) < 5, `${yb} -> ${await scrollY()}`);
  page.once('dialog', (d) => d.accept());
  await page.locator('.stop[data-code="01012"] .icon-btn[title="Remove stop"]').evaluate((b) => b.click()); await page.waitForTimeout(600);
  ok('removing a stop with alert times asks first', (await page.locator('.stop[data-code="01012"]').count()) === 0);
  await page.locator('#q').evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await page.locator('#q').fill('Hotel'); await page.waitForTimeout(900);
  await page.locator('#results button').first().tap(); await page.waitForTimeout(600); await settle();
  ok('adding a stop from search scrolls it into view', onScreen(await box('.stop[data-code="01012"]')), JSON.stringify(await box('.stop[data-code="01012"]')));
  ok('no script errors (editing)', !errors.length, errors.join(' | '));
  await ctx.close();
}

// --- 3. The floating "Find stops" button: reachable, draggable, remembered
{
  const { ctx, page, errors, drag, box } = await phone();
  const fab = () => box('#map-open');
  const f0 = await fab();
  ok('starts in the bottom-right corner', f0 && Math.round(400 - f0.x - f0.width) === 16 && Math.round(700 - f0.y - f0.height) === 20, JSON.stringify(f0));
  await page.evaluate(() => window.scrollTo(0, 10000)); await page.waitForTimeout(300);
  ok('stays put while scrolling', JSON.stringify(await fab()) === JSON.stringify(f0));
  ok('never covers the stop search at the end of the page', await page.evaluate(() => { const a = document.getElementById('q').getBoundingClientRect(), b = document.getElementById('map-open').getBoundingClientRect(); return a.bottom <= b.top || a.top >= b.bottom; }));
  await drag(f0.x + f0.width / 2, f0.y + f0.height / 2, 90, 330);
  const f1 = await fab();
  ok('dragging moves it, and it settles on the nearer side', Math.round(f1.x) === 16 && Math.abs(f1.y - 300) < 4, JSON.stringify(f1));
  ok('a drag does not open the map', !(await page.evaluate(() => document.getElementById('map-dialog').open)));
  await page.reload(); await page.waitForTimeout(2500);
  ok('its position is remembered', JSON.stringify(await fab()) === JSON.stringify(f1), `${JSON.stringify(f1)} vs ${JSON.stringify(await fab())}`);
  await page.locator('#q').focus(); await page.waitForTimeout(300);
  ok('it steps aside while typing', await page.locator('#map-open').evaluate((b) => b.classList.contains('away')));
  await page.locator('#q').blur(); await page.waitForTimeout(400);
  await page.locator('#tabs button[data-tab=trip]').tap(); await page.waitForTimeout(900);
  ok('it is hidden on the Trips page', await page.locator('#map-open').evaluate((b) => getComputedStyle(b).opacity === '0' && getComputedStyle(b).pointerEvents === 'none'));
  ok('no script errors (button)', !errors.length, errors.join(' | '));
  await ctx.close();
}

// --- 4. Finding a stop on the map: tap, live times, centred, add; search for stops and places
{
  const { ctx, page, errors } = await phone({ seed: { ...TWO_STOPS, stops: [TWO_STOPS.stops[1]] } });
  const st = () => page.evaluate(() => ({ open: document.getElementById('map-dialog').open, centre: window.__map && window.__map.c, zoom: window.__map && window.__map.z, colours: (window.__markers || []).map((m) => m.o.fillColor), panel: document.getElementById('map-pick').innerText }));
  await page.locator('#map-open').tap(); await page.waitForTimeout(900);
  ok('"Find stops" opens the map', (await st()).open && /Zoom in/.test((await st()).panel), JSON.stringify(await st()));
  await page.evaluate(() => window.__map.setView([1.2975, 103.853], 17)); await page.waitForTimeout(800);
  ok('zoomed in, stops show: new ones blue, saved ones green', JSON.stringify((await st()).colours.sort()) === JSON.stringify(['#38bdf8', '#4ade80']), JSON.stringify(await st()));
  await page.evaluate(() => window.__markers.find((m) => m.o.fillColor === '#38bdf8').fire('click')); await page.waitForTimeout(1500);
  const p = await st();
  ok('tapping a stop selects it (the tap does not also clear it)', /Hotel Grand Pacific/.test(p.panel) && p.colours.includes('#fbbf24'), JSON.stringify(p));
  ok('its live bus times show without adding it', (await page.locator('#map-pick .svc .svc-no').allInnerTexts()).join(',') === '9,74' && /Updated/.test(p.panel), p.panel);
  ok('the map centres on the chosen stop', JSON.stringify(p.centre) === JSON.stringify([1.29685, 103.85254]), JSON.stringify(p.centre));
  ok('nothing is saved just by looking', !JSON.parse(await page.evaluate(() => localStorage.getItem('mybuses.v1'))).stops.some((s) => s.code === '01012'));
  await page.locator('#map-q').fill('bugis'); await page.waitForTimeout(1300);
  const found = await page.locator('#map-results').innerText();
  ok('the map search finds bus stops first, then places', /BUS STOPS[\s\S]*Bugis Stn[\s\S]*PLACES[\s\S]*BUGIS JUNCTION/i.test(found), found);
  await page.locator('#map-results button').first().tap(); await page.waitForTimeout(1300);
  ok('choosing a stop from the search selects and centres it', /Bugis Stn/.test((await st()).panel) && JSON.stringify((await st()).centre) === JSON.stringify([1.30012, 103.85561]), JSON.stringify(await st()));
  ok('a saved stop says so', await page.locator('#map-pick button.add-it').isDisabled());
  await page.evaluate(() => window.__map.setView([1.2975, 103.853], 17)); await page.waitForTimeout(800);
  await page.evaluate(() => window.__markers.find((m) => m.ll[0] === 1.29685).fire('click')); await page.waitForTimeout(1200);
  await page.locator('#map-pick button.add-it').tap(); await page.waitForTimeout(1500);
  ok('"Add this stop" closes the map and adds it', !(await st()).open && (await page.locator('.stop[data-code="01012"]').count()) === 1);
  ok('no script errors (map)', !errors.length, errors.join(' | '));
  await ctx.close();
}

// --- 5. Notifications: asked for at the moment they are first needed
{
  const { ctx, page, errors } = await phone({ seed: { stops: [], alertsOn: false, places: [] }, permission: 'granted', granted: false });
  ok('a new phone is not asked on opening', (await page.evaluate(() => window.__asked)) === 0);
  ok('an empty Buses page explains how to add stops', /No stops yet/.test(await page.locator('#stops').innerText()) && (await page.locator('.welcome .add-it').count()) === 1);
  await page.locator('#q').fill('Bugis'); await page.waitForTimeout(900); await page.locator('#results button').first().tap(); await page.waitForTimeout(1500);
  await page.getByText('+ Add an alert time').tap(); await page.waitForTimeout(2500);
  ok('the first alert time asks for permission, and the phone registers', (await page.evaluate(() => window.__asked)) === 1 && JSON.parse(store.get('phones') || '{"ids":[]}').ids.length === 1);
  ok('no script errors (permission)', !errors.length, errors.join(' | '));
  await ctx.close();
}
{
  const { ctx, page } = await phone({ seed: { stops: [TWO_STOPS.stops[1]], alertsOn: false, places: [] }, permission: 'denied', granted: false });
  ok('alert times without permission offer an Allow button', /not allowed on this phone yet/.test(await page.locator('.push-ask').first().innerText()));
  await page.locator('.push-ask button').first().tap(); await page.waitForTimeout(1200);
  ok('if refused, it explains how to unblock', /blocked for this site/.test(await page.locator('.stop .note.warn').first().innerText()));
  await ctx.close();
}

await browser.close(); app.close(); onemap.close(); push.server.close(); lta.kill();
console.log(`\n${passed} screen checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
