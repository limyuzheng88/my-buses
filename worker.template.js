// My Buses – Cloudflare Worker.
// This is the SOURCE. Run `node build-worker.mjs` to produce dist/worker.js, which is what you deploy.
// The LTA key is read from the Worker secret LTA_ACCOUNT_KEY and never reaches the browser.

const ASSETS = /*__ASSETS__*/{};   // "/path" -> { type, body }  (the files from public/)
const STOPS = /*__STOPS__*/[];     // [code, name, road] for every bus stop
const BUILD = /*__BUILD__*/'dev';     // set by the build; shown at /api/status so you can tell which version is live

const LTA_DEFAULT = 'https://datamall2.mytransport.sg/ltaodataservice';
const CACHE_MS = 20_000;
const LOAD = { SEA: 'seats', SDA: 'standing', LSD: 'limited' };
const TYPE = { SD: 'single', DD: 'double', BD: 'bendy' };

// Lives as long as this Worker instance stays warm; saves calls to LTA when the page polls.
const arrivalCache = new Map(); // stop -> { at, data }

async function lta(env, pathAndQuery) {
  const res = await fetch(`${env.LTA_BASE || LTA_DEFAULT}/${pathAndQuery}`, {
    headers: {
      AccountKey: String(env.LTA_ACCOUNT_KEY).trim(),   // tolerate a stray space or newline from pasting
      accept: 'application/json',
      'user-agent': 'my-buses/1.0',                      // Workers send none by default; some servers reject that
    },
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
    throw new Error(`LTA ${res.status}${body ? ` (${body})` : ''}`);
  }
  return res.json();
}

function minutesUntil(iso, now) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((t - now) / 60_000));
}

function normalizeArrival(raw, stop) {
  const now = Date.now();
  const services = (raw.Services || []).map((s) => ({
    service: s.ServiceNo,
    operator: s.Operator,
    buses: ['NextBus', 'NextBus2', 'NextBus3']
      .map((k) => s[k])
      .filter((b) => b && b.EstimatedArrival)
      .map((b) => ({
        eta: b.EstimatedArrival,
        minutes: minutesUntil(b.EstimatedArrival, now),
        load: LOAD[b.Load] || null,
        type: TYPE[b.Type] || null,
        wheelchair: b.Feature === 'WAB',
      })),
  }));
  services.sort((a, b) => a.service.localeCompare(b.service, undefined, { numeric: true }));
  return { stop: raw.BusStopCode || stop, fetchedAt: new Date(now).toISOString(), services, mock: false };
}

async function getArrivals(env, stop) {
  const hit = arrivalCache.get(stop);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const q = `BusStopCode=${encodeURIComponent(stop)}`;
  let raw;
  try {
    raw = await lta(env, `v3/BusArrival?${q}`);
  } catch (e3) {
    // Older address as a fallback; if both fail, report both so the real cause is visible.
    try { raw = await lta(env, `BusArrivalv2?${q}`); }
    catch (e2) { throw new Error(`v3: ${e3.message} | v2: ${e2.message}`); }
  }
  const data = normalizeArrival(raw, stop);
  if (arrivalCache.size > 500) arrivalCache.clear();
  arrivalCache.set(stop, { at: Date.now(), data });
  return data;
}

function searchStops(q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  return STOPS
    .filter((x) => x[0].startsWith(s) || x[1].toLowerCase().includes(s) || (x[2] || '').toLowerCase().includes(s))
    .sort((a, b) => Number(b[0].startsWith(s)) - Number(a[0].startsWith(s)) || a[1].localeCompare(b[1]))
    .slice(0, 15)
    .map(([code, name, road]) => ({ code, name, road }));
}

// Lets you check which key a deployment holds without revealing it: its length and a short fingerprint.
async function keyInfo(env) {
  const k = String(env.LTA_ACCOUNT_KEY || '').trim();
  if (!k) return { keySet: false };
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(k));
  const fp = [...new Uint8Array(d)].slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
  return { keySet: true, keyLen: k.length, keyFp: fp };
}

const json = (code, body) => new Response(JSON.stringify(body), {
  status: code,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

// ---------- Push alerts: reach the phone when the app is closed ----------
// Needs three things set on the Worker: a KV namespace bound as KV, and the secrets
// VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (from `node generate-vapid.mjs`).
// Writes happen only when you change settings, plan a route, tap Stop, or a departure notification is sent.

const STATE_KEY = 'state';
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'notify.windows.com', 'push.apple.com'];
const MAX_DEVICES = 20;
const MAX_STOPS = 10;
const te = new TextEncoder();

const pushReady = (env) => Boolean(env.KV && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// Only ever POST to real browser push services (stops this Worker being pointed at arbitrary URLs).
function pushHostAllowed(env, endpoint) {
  let u; try { u = new URL(endpoint); } catch { return false; }
  if (env.PUSH_TEST_HOST && u.host === env.PUSH_TEST_HOST) return true; // used by local tests only
  return u.protocol === 'https:' && PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

async function deviceId(endpoint) {
  const d = await crypto.subtle.digest('SHA-256', te.encode(endpoint));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Storage. Each phone's data lives in separate KV entries, one per writer, so that one writer can never undo
// another's change (an earlier version kept everything in one entry, and a settings sync could wipe a planned trip):
//   phones           { origin, ids }                         the list of registered phones
//   p:<id>:reg       endpoint, keys, stops, trip, gs         written only by the app's settings sync
//   p:<id>:muted     alarms stopped for now                  written only by Stop
//   p:<id>:manual    departure alert for a planned route     written when a route is planned, sent or cancelled
//   p:<id>:plan      the calendar plan                       written only by the every-minute job
//   p:<id>:log       record of departure notifications sent
const PARTS = ['muted', 'manual', 'plan', 'log'];
const kGet = (env, key) => env.KV.get(key, 'json');
const kPut = (env, key, value) => (value == null ? env.KV.delete(key) : env.KV.put(key, JSON.stringify(value)));
const snapOf = (d) => Object.fromEntries(PARTS.map((p) => [p, JSON.stringify(d[p] == null ? null : d[p])]));
const track = (d) => { Object.defineProperty(d, 'snap', { value: snapOf(d), enumerable: false, writable: true }); return d; };

// Moves data from the old single entry to the new layout, once.
async function migrateLegacy(env) {
  const old = await kGet(env, STATE_KEY);
  if (!old || !old.devices) return null;
  const ids = Object.keys(old.devices);
  for (const id of ids) {
    const d = old.devices[id];
    await kPut(env, `p:${id}:reg`, { endpoint: d.endpoint, keys: d.keys, stops: d.stops || [], trip: d.trip || sanitizeTrip(null), gs: d.gs || null });
    for (const p of PARTS) if (d[p] && Object.keys(d[p]).length) await kPut(env, `p:${id}:${p}`, d[p]);
  }
  const ix = { origin: old.origin || null, ids };
  await kPut(env, 'phones', ix);
  await env.KV.delete(STATE_KEY);
  return ix;
}

const loadIndex = async (env) => (await kGet(env, 'phones')) || (await migrateLegacy(env)) || { origin: null, ids: [] };

async function loadPhone(env, id) {
  const [reg, muted, manual, plan, log] = await Promise.all([kGet(env, `p:${id}:reg`), ...PARTS.map((p) => kGet(env, `p:${id}:${p}`))]);
  return reg ? track({ ...reg, muted: muted || {}, manual: manual || undefined, plan: plan || undefined, log: log || [] }) : null;
}

async function loadState(env) {
  const ix = await loadIndex(env);
  const devices = {};
  await Promise.all(ix.ids.map(async (id) => { const d = await loadPhone(env, id); if (d) devices[id] = d; }));
  return { origin: ix.origin, devices };
}

// Writes back only the parts of a phone's data that this run changed.
async function flushPhone(env, id, d) {
  const now = snapOf(d);
  const empty = (v) => v == null || (Array.isArray(v) ? !v.length : typeof v === 'object' && !Object.keys(v).length);
  await Promise.all(PARTS.filter((p) => now[p] !== d.snap[p]).map((p) => kPut(env, `p:${id}:${p}`, empty(d[p]) ? null : d[p])));
  d.snap = now;
}

async function removePhone(env, id) {
  const ix = await loadIndex(env);
  if (ix.ids.includes(id)) await kPut(env, 'phones', { ...ix, ids: ix.ids.filter((x) => x !== id) });
  await Promise.all(['reg', ...PARTS].map((p) => env.KV.delete(`p:${id}:${p}`)));
}

// A notification with the same tag is not sent twice to a phone within 10 minutes by this Worker instance.
const recentSends = new Map();
async function sendOnce(env, dev, subject, message, ttlSeconds) {
  const key = `${dev.endpoint}|${message.tag}`, now = Date.now();
  if (recentSends.get(key) > now - 10 * 60_000 && env.DEDUPE_OFF !== '1') return 208;   // already sent (DEDUPE_OFF is for tests)
  const status = await sendPush(env, dev, subject, message, ttlSeconds);
  if (status >= 200 && status < 300) { if (recentSends.size > 500) recentSends.clear(); recentSends.set(key, now); }
  return status;
}

// Proves to the push service that the message comes from this app (VAPID, RFC 8292).
async function vapidHeader(env, endpoint, subject) {
  const pub = String(env.VAPID_PUBLIC_KEY).trim();
  const raw = unb64u(pub); // 0x04 || x || y
  const jwk = { kty: 'EC', crv: 'P-256', d: String(env.VAPID_PRIVATE_KEY).trim(), x: b64u(raw.slice(1, 33)), y: b64u(raw.slice(33, 65)) };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const part = (o) => b64u(te.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(unsigned));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${pub}`;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

// Encrypts the message so only this phone's browser can read it (Web Push, RFC 8291, aes128gcm).
async function encryptPayload(keys, text) {
  const uaPub = unb64u(keys.p256dh);
  const auth = unb64u(keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(te.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(te.encode(text), new Uint8Array([2]))));
  return concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, cipher); // header: salt, record size 4096, key
}

// message = { title, body, tag } or null for an empty "ping" push. Returns the push service's HTTP status.
async function sendPush(env, dev, subject, message, ttlSeconds = 300) {
  const headers = { TTL: String(Math.round(ttlSeconds)), Urgency: 'high', Authorization: await vapidHeader(env, dev.endpoint, subject) };
  let body;
  if (message) {
    body = await encryptPayload(dev.keys, JSON.stringify(message));
    headers['Content-Encoding'] = 'aes128gcm';
    headers['Content-Type'] = 'application/octet-stream';
  }
  const res = await fetch(dev.endpoint, { method: 'POST', headers, body });
  console.log(JSON.stringify({ notification: message ? message.title : '(ping)', pushServiceStatus: res.status }));   // visible in the Worker's logs
  return res.status;
}

// Singapore has no daylight saving, so local time is always UTC+8.
const SG = 8 * 3600_000;
const DAY = 86_400_000;
const toMin = (s) => { const m = /^(\d{2}):(\d{2})$/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
function sgParts(ts) {
  const d = new Date(ts + SG);
  return { dow: d.getUTCDay(), date: d.toISOString().slice(0, 10), hm: d.getUTCHours() * 60 + d.getUTCMinutes(), midnight: Math.floor((ts + SG) / DAY) * DAY - SG };
}

// Is this alarm's timeframe running at `now`? If so: minutes since it started, and when it ends.
// An alarm runs on its ticked weekdays and on its specific dates. "to" earlier than "from" means it runs past midnight.
function alarmWindow(alarm, now) {
  const from = toMin(alarm.from), to = toMin(alarm.to);
  if (from == null || to == null || from === to) return { active: false };
  const t = sgParts(now), y = sgParts(now - DAY);
  const on = (p) => alarm.days.includes(p.dow) || alarm.dates.includes(p.date);
  if (from < to) return on(t) && t.hm >= from && t.hm < to ? { active: true, since: t.hm - from, end: t.midnight + to * 60_000 } : { active: false };
  if (on(t) && t.hm >= from) return { active: true, since: t.hm - from, end: t.midnight + DAY + to * 60_000 };
  if (on(y) && t.hm < to) return { active: true, since: t.hm + 1440 - from, end: t.midnight + to * 60_000 };
  return { active: false };
}

function sanitizeAlarms(input) {
  const out = [];
  for (const a of (Array.isArray(input) ? input : []).slice(0, 10)) {
    if (!a || !/^[a-z0-9]{1,12}$/.test(a.id || '') || toMin(a.from) == null || toMin(a.to) == null || a.from === a.to) continue;
    const days = [...new Set((Array.isArray(a.days) ? a.days : []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
    const dates = [...new Set((Array.isArray(a.dates) ? a.dates : []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].slice(0, 30);
    if (!days.length && !dates.length) continue;
    out.push({ id: a.id, days, dates, from: a.from, to: a.to, every: Math.min(60, Math.max(2, Math.round(Number(a.every)) || 5)) });
  }
  return out;
}

// Keep only well-formed rules; a stop with no followed buses or no usable alarm has no closed-app alerts.
function sanitizeStops(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const s of input.slice(0, MAX_STOPS)) {
    if (!s || !/^\d{5}$/.test(s.code)) continue;
    const followed = (Array.isArray(s.followed) ? s.followed : []).filter((x) => /^[0-9A-Za-z]{1,5}$/.test(x)).slice(0, 10);
    // Older copies of the app sent one days/from/to per stop; accept that as a single alarm.
    const alarms = sanitizeAlarms(Array.isArray(s.alarms) ? s.alarms : [{ id: 'a1', days: s.days, dates: [], from: s.from, to: s.to, every: 5 }]);
    if (!followed.length || !alarms.length) continue;
    out.push({
      code: s.code, name: String(s.name || `Stop ${s.code}`).slice(0, 60), followed, alarms,
      threshold: Math.min(60, Math.max(1, Math.round(Number(s.threshold)) || 10)),
    });
  }
  return out;
}

const liveMutes = (muted, now) => Object.fromEntries(Object.entries(muted || {}).filter(([, until]) => until > now));

// Leave-alert settings sent by the app: on/off, minutes of warning, where you start from when the app is closed,
// your last GPS position, and your saved places (so a calendar location like "Office" can be matched by name).
const point = (p, extra = {}) => (p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) ? { lat: Number(p.lat), lng: Number(p.lng), ...extra } : null);
function sanitizeTrip(t) {
  if (!t || typeof t !== 'object') return { enabled: false, lead: 10, origin: null, fix: null, places: [] };
  return {
    enabled: t.enabled === true,
    lead: Math.min(60, Math.max(1, Math.round(Number(t.lead)) || 10)),
    origin: point(t.origin, { name: String((t.origin && t.origin.name) || 'your usual place').slice(0, 40) }),
    fix: t.fix && Number(t.fix.t) > 0 ? point(t.fix, { t: Math.min(Number(t.fix.t), Date.now()) }) : null,
    places: (Array.isArray(t.places) ? t.places : []).slice(0, 20).map((p) => point(p, { name: String((p && p.name) || '').slice(0, 40) })).filter((p) => p && p.name),
  };
}

// Which calendar sign-in belongs to the browser making this request (by its session cookie), if any.
async function linkedCalendar(request, env) {
  if (!googleReady(env)) return null;
  const c = cookieOf(request, 'mb_session');
  if (!c) return null;
  const hash = await sha256hex(c);
  return (await env.KV.get(`gs:${hash}`)) ? hash : null;
}

async function pushSync(request, env) {
  const body = await request.json().catch(() => null);
  const sub = body && body.subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth || !pushHostAllowed(env, sub.endpoint)) {
    return json(400, { error: 'Unsupported push subscription' });
  }
  const ix = await loadIndex(env);
  const id = await deviceId(sub.endpoint);
  const isNew = !ix.ids.includes(id);
  if (isNew && ix.ids.length >= MAX_DEVICES) return json(429, { error: 'Too many devices registered' });
  const origin = new URL(request.url).origin;
  // Only the registration entry is written here; a planned trip, the calendar plan, Stop and the log are left untouched.
  const reg = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, stops: sanitizeStops(body.stops), trip: sanitizeTrip(body.trip), gs: await linkedCalendar(request, env) };
  await kPut(env, `p:${id}:reg`, reg);
  if (isNew || ix.origin !== origin) await kPut(env, 'phones', { origin, ids: isNew ? [...ix.ids, id] : ix.ids });
  const [muted, manual, plan, log] = await Promise.all(PARTS.map((p) => kGet(env, `p:${id}:${p}`)));
  return json(200, { ok: true, id, rules: reg.stops.length, muted: liveMutes(muted, Date.now()), calendarLinked: Boolean(reg.gs), plan: plan || null, manual: manual && manual.leaveAt > Date.now() ? { ...manual, alertAt: dueMinuteOf(manual) * 60_000 } : null, log: log || [] });
}

// Sends two pushes so a failure can be pinned down: an empty ping, and one carrying an encrypted message.
async function pushTest(request, env) {
  const body = await request.json().catch(() => null);
  const dev = body && body.endpoint ? await loadPhone(env, await deviceId(body.endpoint)) : null;
  if (!dev) return json(404, { error: 'This device is not registered for alerts yet' });
  const origin = new URL(request.url).origin;
  const ping = await sendPush(env, dev, origin, null).catch((e) => `error: ${e.message}`);
  const message = await sendPush(env, dev, origin, { title: 'Test alert', body: 'Alerts will reach this phone when the app is closed.', tag: 'test' }).catch((e) => `error: ${e.message}`);
  return json(200, { ping, message });
}

// "Stop these alerts": silence one alarm until its current timeframe ends.
async function pushUnsubscribe(request, env) {
  const body = await request.json().catch(() => null);
  if (body && body.endpoint) await removePhone(env, await deviceId(body.endpoint));
  return json(200, { ok: true });
}

async function pushStop(request, env) {
  const body = await request.json().catch(() => null);
  const id = body && body.endpoint ? await deviceId(body.endpoint) : null;
  const dev = id ? await loadPhone(env, id) : null;
  if (!dev) return json(404, { error: 'This device is not registered for alerts' });
  const now = Date.now();
  const stop = (dev.stops || []).find((s) => s.code === body.code);
  const alarm = stop && stop.alarms.find((a) => a.id === body.alarm);
  const w = alarm ? alarmWindow(alarm, now) : { active: false };
  if (!w.active) return json(200, { ok: true, until: null });
  dev.muted = { ...liveMutes(dev.muted, now), [`${stop.code}|${alarm.id}`]: w.end };
  await flushPhone(env, id, dev);
  return json(200, { ok: true, until: w.end });
}

// What the notification says: the next times for each followed bus, led by the soonest one you can still catch.
function summarize(stop, data, now) {
  let best = null;
  const lines = stop.followed.map((name) => {
    const svc = data.services.find((s) => s.service === name);
    const mins = (svc ? svc.buses : []).map((b) => Math.floor((Date.parse(b.eta) - now) / 60_000)).filter((m) => m >= 0);
    for (const m of mins) if (m >= 1 && (!best || m < best.m)) best = { name, m };
    return mins.length ? `${name}: ${mins.map((m) => (m === 0 ? 'Arr' : m)).join(', ')} min` : `${name}: no estimate`;
  });
  const title = !best ? 'No bus times yet' : best.m <= stop.threshold ? `Leave now: Bus ${best.name} in ${best.m} min` : `Bus ${best.name} in ${best.m} min`;
  return { title, body: `${lines.join(' · ')}\n${stop.name} (${stop.code})` };
}

// Stop alarms. While an alarm's timeframe is running, it sends the bus times every `every` minutes,
// counted from the start of the timeframe, so no record of "last sent" has to be stored.
async function runAlarms(env, st, now, force) {
  const jobs = new Map(); // one notification per device and stop, even if two alarms overlap
  let running = 0;
  for (const [id, dev] of Object.entries(st.devices)) {
    for (const stop of dev.stops || []) {
      for (const alarm of stop.alarms || []) {
        const w = alarmWindow(alarm, now);
        if (!w.active) continue;
        running += 1;
        if ((dev.muted || {})[`${stop.code}|${alarm.id}`] > now) continue;
        if (!force && w.since % alarm.every !== 0) continue;
        if (!jobs.has(`${id}|${stop.code}`)) jobs.set(`${id}|${stop.code}`, { id, stop, alarm });
      }
    }
  }
  if (!jobs.size) return { running, sent: 0 };

  const data = {};
  await Promise.all([...new Set([...jobs.values()].map((j) => j.stop.code))].map(async (c) => { try { data[c] = await getArrivals(env, c); } catch { /* skip this stop this time */ } }));

  const results = [];
  for (const { id, stop, alarm } of jobs.values()) {
    if (!data[stop.code] || !st.devices[id]) continue;
    const message = { ...summarize(stop, data[stop.code], now), tag: `stop-${stop.code}`, stop: stop.code, alarm: alarm.id };
    const status = await sendPush(env, st.devices[id], st.origin, message).catch(() => 0);
    results.push(status);
    if (status === 404 || status === 410) { delete st.devices[id]; await removePhone(env, id); } // the phone unsubscribed
  }
  return { running, sent: results.length, results };
}

async function pushRoutes(request, env, url) {
  if (!pushReady(env)) return json(404, { error: 'Push alerts are not set up on this Worker' });
  try {
    if (url.pathname === '/api/push/key' && request.method === 'GET') return json(200, { key: String(env.VAPID_PUBLIC_KEY).trim() });
    if (url.pathname === '/api/push/sync' && request.method === 'POST') return await pushSync(request, env);
    if (url.pathname === '/api/push/test' && request.method === 'POST') return await pushTest(request, env);
    if (url.pathname === '/api/push/stop' && request.method === 'POST') return await pushStop(request, env);
    if (url.pathname === '/api/push/trip' && request.method === 'POST') return await pushTrip(request, env);
    if (url.pathname === '/api/push/unsubscribe' && request.method === 'POST') return await pushUnsubscribe(request, env);
    // Runs the every-minute check on demand. Add ?force=1 to send now instead of waiting for the next interval.
    if (url.pathname === '/api/push/run' && request.method === 'GET') return json(200, await runAlerts(env, Date.now(), url.searchParams.get('force') === '1'));
    return new Response('Not found', { status: 404 });
  } catch (err) {
    return json(500, { error: 'Push alerts failed', detail: String(err.message || err) });
  }
}

// ---------- Trip planning (OneMap, Singapore Land Authority) ----------
// Needs the secrets ONEMAP_EMAIL and ONEMAP_PASSWORD. The Worker swaps them for a 3-day token and renews it by itself.

const ONEMAP_DEFAULT = 'https://www.onemap.gov.sg';
const tripsReady = (env) => Boolean(env.ONEMAP_EMAIL && env.ONEMAP_PASSWORD);
let onemapMem = null;        // { token, exp } while this Worker instance stays warm
let onemapBearer = true;     // which Authorization format OneMap accepted last

async function onemapToken(env, fresh = false) {
  const now = Date.now();
  if (!fresh) {
    if (onemapMem && onemapMem.exp - now > 3600_000) return onemapMem.token;
    const saved = env.KV ? await env.KV.get('onemap', 'json') : null;
    if (saved && saved.exp - now > 3600_000) { onemapMem = saved; return saved.token; }
  }
  const res = await fetch(`${env.ONEMAP_BASE || ONEMAP_DEFAULT}/api/auth/post/getToken`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'my-buses/1.0' },
    body: JSON.stringify({ email: String(env.ONEMAP_EMAIL).trim(), password: String(env.ONEMAP_PASSWORD) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`OneMap sign-in failed (${res.status}). Check the ONEMAP_EMAIL and ONEMAP_PASSWORD secrets.`);
  const exp = Number(body.expiry_timestamp) > 0 ? Number(body.expiry_timestamp) * 1000 : now + 70 * 3600_000;
  onemapMem = { token: body.access_token, exp };
  if (env.KV) await env.KV.put('onemap', JSON.stringify(onemapMem));
  return onemapMem.token;
}

async function onemap(env, pathAndQuery) {
  const call = async (token, bearer) => fetch(`${env.ONEMAP_BASE || ONEMAP_DEFAULT}${pathAndQuery}`, {
    headers: { Authorization: bearer ? `Bearer ${token}` : token, accept: 'application/json', 'user-agent': 'my-buses/1.0' },
  });
  let token = await onemapToken(env);
  let res = await call(token, onemapBearer);
  if (res.status === 401 || res.status === 403) {            // try the other header format, then a brand-new token
    res = await call(token, !onemapBearer);
    if (res.ok) onemapBearer = !onemapBearer;
    else { token = await onemapToken(env, true); res = await call(token, onemapBearer); }
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`OneMap ${res.status}${text ? ` (${text})` : ''}`);
  }
  return res.json();
}

async function searchPlaces(env, q) {
  const r = await onemap(env, `/api/common/elastic/search?searchVal=${encodeURIComponent(q)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`);
  return (r.results || []).slice(0, 8).map((p) => ({
    name: p.BUILDING && p.BUILDING !== 'NIL' ? p.BUILDING : p.SEARCHVAL,
    address: p.ADDRESS, lat: Number(p.LATITUDE), lng: Number(p.LONGITUDE),
  })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

function sgDateTime(ts) {
  const iso = new Date(ts + SG).toISOString();   // YYYY-MM-DDTHH:MM:SS in Singapore time
  return { date: `${iso.slice(5, 7)}-${iso.slice(8, 10)}-${iso.slice(0, 4)}`, time: iso.slice(11, 19) };
}

const stopCodeOf = (p) => { const c = (p && (p.stopCode || String(p.stopId || '').split(':').pop())) || ''; return /^\d{5}$/.test(c) ? c : null; };

// Turns one OneMap itinerary into the few facts the app shows.
function tidyItinerary(it) {
  const legs = (it.legs || []).map((l) => ({
    mode: l.mode === 'WALK' ? 'walk' : l.mode === 'BUS' ? 'bus' : 'train',
    route: l.route || l.routeShortName || '',
    from: { name: (l.from && l.from.name) || '', code: stopCodeOf(l.from) },
    to: { name: (l.to && l.to.name) || '', code: stopCodeOf(l.to) },
    start: l.startTime, end: l.endTime,
    minutes: Math.max(1, Math.round((l.duration != null ? l.duration * 1000 : l.endTime - l.startTime) / 60_000)),
    stops: l.mode === 'WALK' ? null : (l.numIntermediateStops != null ? l.numIntermediateStops : (l.intermediateStops || []).length) + 1,
  }));
  return {
    leaveAt: it.startTime, arriveAt: it.endTime,
    minutes: Math.round((it.endTime - it.startTime) / 60_000),
    walkMinutes: Math.round((it.walkTime || 0) / 60), transfers: it.transfers || 0, fare: it.fare || null, legs,
  };
}

// OneMap plans from a departure time. For "arrive by", estimate the journey length, then step the departure
// earlier until an option gets there in time. Options are ordered so the first is the one to take.
async function planTrip(env, from, to, { arrive, depart }) {
  const query = async (ts) => {
    const { date, time } = sgDateTime(ts);
    const r = await onemap(env, `/api/public/routingsvc/route?start=${from}&end=${to}&routeType=pt&date=${date}&time=${encodeURIComponent(time)}&mode=TRANSIT&maxWalkDistance=1000&numItineraries=3`);
    return (r.plan && r.plan.itineraries) || [];
  };
  if (!arrive) return { raw: (await query(depart || Date.now())).sort((a, b) => a.endTime - b.endTime), onTime: true };
  let its = await query(arrive - 60 * 60_000);
  if (!its.length) return { raw: [], onTime: false };
  let t = arrive - Math.min(...its.map((i) => i.endTime - i.startTime)) - 5 * 60_000;
  for (let n = 0; n < 3; n += 1) {
    its = await query(t);
    const inTime = its.filter((i) => i.endTime <= arrive);
    if (inTime.length) return { raw: inTime.sort((a, b) => b.startTime - a.startTime), onTime: true };
    t -= 10 * 60_000;
  }
  return { raw: its.sort((a, b) => a.endTime - b.endTime), onTime: false };
}

// If the first bus of the trip is close enough for LTA to have a live estimate, attach it.
async function liveFirstBus(env, option) {
  const leg = option.legs.find((l) => l.mode === 'bus');
  if (!leg || !leg.from.code || !env.LTA_ACCOUNT_KEY || leg.start - Date.now() > 40 * 60_000) return null;
  try {
    const svc = (await getArrivals(env, leg.from.code)).services.find((s) => s.service === leg.route);
    const reachStop = leg.start - 3 * 60_000;   // a bus a little earlier than planned still counts
    const bus = svc && svc.buses.map((b) => Date.parse(b.eta)).find((eta) => eta >= reachStop);
    return bus ? { service: leg.route, stop: leg.from.code, eta: bus } : null;
  } catch { return null; }
}

const LATLNG = /^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;

async function tripRoutes(request, env, url) {
  if (!tripsReady(env)) return json(404, { error: 'Trip planning is not set up on this Worker' });
  try {
    if (url.pathname === '/api/places') {
      const q = (url.searchParams.get('q') || '').trim();
      return json(200, { places: q.length < 2 ? [] : await searchPlaces(env, q) });
    }
    if (url.pathname === '/api/geocode') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
      return json(200, q.length < 2 ? { place: null } : await geocode(env, q));
    }
    const from = url.searchParams.get('from') || '', to = url.searchParams.get('to') || '';
    if (!LATLNG.test(from) || !LATLNG.test(to)) return json(400, { error: 'from and to must be "lat,lng"' });
    const arrive = Date.parse(url.searchParams.get('arrive') || '') || null;
    const depart = Date.parse(url.searchParams.get('depart') || '') || null;
    const { raw, onTime } = await planTrip(env, from, to, { arrive, depart });
    const options = raw.slice(0, 3).map(tidyItinerary);
    if (options[0]) options[0].live = await liveFirstBus(env, options[0]);
    const out = { options, onTime, arriveBy: arrive };
    if (url.searchParams.get('debug') === '1') out.rawFirst = raw[0] || null;   // to check OneMap's format if something looks off
    return json(200, out);
  } catch (err) {
    return json(502, { error: 'Could not get a route from OneMap', detail: String(err.message || err) });
  }
}

// ---------- Google Calendar (read-only) ----------
// Needs the secrets GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, and KV.
// Each browser that signs in gets its own random session cookie; only that browser can read that calendar.
// The Worker keeps Google's refresh token in KV under a hash of the cookie, never the cookie itself.

const G_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const googleReady = (env) => Boolean(env.KV && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const gAccess = new Map();   // session hash -> { token, exp }: short-lived access tokens, kept in memory only
const randomToken = () => b64u(crypto.getRandomValues(new Uint8Array(32)));
const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const cookieOf = (request, name) => { const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(request.headers.get('cookie') || ''); return m ? m[1] : null; };
const cookie = (name, value, maxAge, path = '/') => `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const redirect = (to, cookies = []) => { const h = new Headers({ location: to, 'cache-control': 'no-store' }); for (const c of cookies) h.append('set-cookie', c); return new Response(null, { status: 302, headers: h }); };

async function gToken(env, params) {
  const res = await fetch(env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: String(env.GOOGLE_CLIENT_ID).trim(), client_secret: String(env.GOOGLE_CLIENT_SECRET).trim(), ...params }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`Google ${res.status}: ${body.error || 'error'}${body.error_description ? ` (${body.error_description})` : ''}`);
    e.code = body.error;
    throw e;
  }
  return body;
}

async function gSession(request, env) {
  const c = cookieOf(request, 'mb_session');
  if (!c) return null;
  const hash = await sha256hex(c);
  const rec = await env.KV.get(`gs:${hash}`, 'json');
  return rec ? { hash, rec } : null;
}

async function gAccessToken(env, s, fresh = false) {
  const hit = gAccess.get(s.hash);
  if (!fresh && hit && hit.exp - Date.now() > 60_000) return hit.token;
  const b = await gToken(env, { grant_type: 'refresh_token', refresh_token: s.rec.refresh });
  if (gAccess.size > 200) gAccess.clear();
  gAccess.set(s.hash, { token: b.access_token, exp: Date.now() + (Number(b.expires_in) || 3600) * 1000 });
  return b.access_token;
}

// Upcoming timed events (all-day and cancelled ones are skipped), soonest first.
async function upcomingEvents(env, s) {
  const now = Date.now();
  const q = new URLSearchParams({
    timeMin: new Date(now).toISOString(), timeMax: new Date(now + 7 * DAY).toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '20', fields: 'items(id,summary,location,start,end,status)',
  });
  const call = async (token) => fetch(`${env.GOOGLE_API_BASE || 'https://www.googleapis.com/calendar/v3'}/calendars/primary/events?${q}`, { headers: { Authorization: `Bearer ${token}`, accept: 'application/json' } });
  let res = await call(await gAccessToken(env, s));
  if (res.status === 401) res = await call(await gAccessToken(env, s, true));
  if (!res.ok) throw new Error(`Google Calendar ${res.status} (${(await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)})`);
  const items = (await res.json()).items || [];
  return items
    .filter((e) => e.status !== 'cancelled' && e.start && e.start.dateTime && Date.parse(e.start.dateTime) > now)
    .slice(0, 5)
    .map((e) => ({ id: e.id, title: e.summary || '(no title)', location: (e.location || '').trim(), start: Date.parse(e.start.dateTime), end: e.end && e.end.dateTime ? Date.parse(e.end.dateTime) : null }));
}

async function googleRoutes(request, env, url) {
  if (!googleReady(env)) return json(404, { error: 'Google Calendar is not set up on this Worker' });
  const redirectUri = `${url.origin}/api/google/callback`;
  try {
    if (url.pathname === '/api/google/login' && request.method === 'GET') {
      const state = randomToken();
      const q = new URLSearchParams({ client_id: String(env.GOOGLE_CLIENT_ID).trim(), redirect_uri: redirectUri, response_type: 'code', scope: G_SCOPE, access_type: 'offline', prompt: 'consent', state });
      return redirect(`${env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth'}?${q}`, [cookie('mb_oauth', state, 600, '/api/google')]);
    }
    if (url.pathname === '/api/google/callback' && request.method === 'GET') {
      const clear = cookie('mb_oauth', '', 0, '/api/google');
      if (url.searchParams.get('error')) return redirect('/?calendar=denied', [clear]);
      const state = url.searchParams.get('state');
      if (!state || state !== cookieOf(request, 'mb_oauth')) return redirect('/?calendar=failed', [clear]);   // not a sign-in this browser started
      const b = await gToken(env, { grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: redirectUri });
      if (!b.refresh_token) return redirect('/?calendar=failed', [clear]);
      const session = randomToken();
      await env.KV.put(`gs:${await sha256hex(session)}`, JSON.stringify({ refresh: b.refresh_token, at: Date.now() }));
      return redirect('/?calendar=connected', [clear, cookie('mb_session', session, 365 * 86400)]);
    }
    if (url.pathname === '/api/calendar/next' && request.method === 'GET') {
      const s = await gSession(request, env);
      if (!s) return json(200, { signedIn: false });
      try {
        return json(200, { signedIn: true, events: await upcomingEvents(env, s) });
      } catch (e) {
        if (e.code !== 'invalid_grant') throw e;
        await env.KV.delete(`gs:${s.hash}`); gAccess.delete(s.hash);    // Google no longer honours the sign-in
        return json(200, { signedIn: false, reason: 'expired' });
      }
    }
    if (url.pathname === '/api/google/logout' && request.method === 'POST') {
      const s = await gSession(request, env);
      if (s) {
        await fetch(`${env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke'}?token=${encodeURIComponent(s.rec.refresh)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } }).catch(() => {});
        await env.KV.delete(`gs:${s.hash}`); gAccess.delete(s.hash);
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'set-cookie': cookie('mb_session', '', 0) } });
    }
    return new Response('Not found', { status: 404 });
  } catch (err) {
    if (url.pathname === '/api/google/callback') return redirect(`/?calendar=failed&why=${encodeURIComponent(String(err.message || err).slice(0, 200))}`);
    return json(502, { error: 'Could not read Google Calendar', detail: String(err.message || err) });
  }
}

// Calendar locations are free text. Try the most reliable reading first: a 6-digit postal code, then the text itself, then its parts.
async function geocode(env, text) {
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  const postal = (/\b(\d{6})\b/.exec(text) || [])[1];
  const candidates = [...new Set([postal, parts.length > 1 ? null : text.trim(), parts[0], parts[1], parts.length > 1 ? text.trim() : null].filter(Boolean))].slice(0, 4);
  for (const c of candidates) {
    const found = await searchPlaces(env, c);
    if (found.length) return { place: found[0], matched: c };
  }
  return { place: null, tried: candidates };
}

// ---------- Leave alerts: "leave in 10 min" for the next appointment ----------
// Every 5 minutes: read the calendar, and if the next appointment with a location starts within 3 hours, plan the trip.
// Every minute: if it is now `lead` minutes before the time to leave, send one notification.

const PLAN_AHEAD = 3 * 3600_000;
const FIX_FRESH = 30 * 60_000;      // a GPS position from the app is trusted for this long
const sgClock = (ts) => { const d = new Date(ts + SG), hr = d.getUTCHours(); return `${hr % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${hr < 12 ? 'AM' : 'PM'}`; };

// Works out (or keeps) the plan for one phone. Returns { changed, created }.
async function planFor(env, dev, now) {
  const drop = () => { const had = Boolean(dev.plan); delete dev.plan; return { changed: had, created: false }; };
  const rec = await env.KV.get(`gs:${dev.gs}`, 'json');
  if (!rec) { delete dev.plan; return { changed: true, created: false }; }   // calendar was disconnected
  let events;
  try { events = await upcomingEvents(env, { hash: dev.gs, rec }); }
  catch (e) { if (e.code === 'invalid_grant') { delete dev.plan; return { changed: true, created: false }; } throw e; }
  const ev = events.find((e) => e.location && e.start - now <= PLAN_AHEAD);
  if (!ev) return drop();

  const trip = dev.trip;
  const origin = trip.fix && now - trip.fix.t < FIX_FRESH ? { ...trip.fix, name: 'where you are' } : trip.origin;
  const key = `${ev.id}|${ev.start}|${ev.location}|${origin ? `${origin.lat.toFixed(3)},${origin.lng.toFixed(3)}` : 'none'}`;
  if (dev.plan && dev.plan.key === key) return { changed: false, created: false };
  const base = { key, id: ev.id, title: ev.title, start: ev.start, location: ev.location };
  const fail = (why) => { dev.plan = { ...base, failed: why }; return { changed: true, created: false }; };
  if (!origin) return fail('no starting place is set');

  const loc = ev.location.toLowerCase();
  const place = trip.places.find((p) => p.name.toLowerCase() === loc) || trip.places.find((p) => p.name.length > 2 && loc.includes(p.name.toLowerCase())) || (await geocode(env, ev.location)).place;
  if (!place) return fail('its location was not found on the map');
  const { raw, onTime } = await planTrip(env, `${origin.lat},${origin.lng}`, `${place.lat},${place.lng}`, { arrive: ev.start });
  if (!raw.length) return fail('no public transport route was found');
  const o = tidyItinerary(raw[0]);
  const replanned = Boolean(dev.plan && dev.plan.id === ev.id && !dev.plan.failed);   // same appointment, new starting point or time
  dev.plan = { ...base, sent: replanned ? dev.plan.sent : undefined, from: origin.name, to: place.name, leaveAt: o.leaveAt, arriveAt: o.arriveAt, onTime, legs: o.legs.map(({ mode, route, from, to, start, minutes }) => ({ mode, route, from, to, start, minutes })) };
  return { changed: true, created: !replanned };
}

function tripMessage(plan, now, live, prefix = '') {
  const mins = Math.floor((plan.leaveAt - now) / 60_000);
  const title = !plan.onTime ? `Running late for ${plan.title}: leave now` : mins > 0 ? `Leave in ${mins} min for ${plan.title}` : `Leave now for ${plan.title}`;
  const walk = plan.legs[0] && plan.legs[0].mode === 'walk' ? plan.legs[0] : null;
  const ride = plan.legs.find((l) => l.mode !== 'walk');
  const lines = [];
  if (walk && ride) lines.push(`Walk ${walk.minutes} min to ${ride.from.name}${ride.from.code ? ` (${ride.from.code})` : ''}`);
  if (ride) lines.push(`${ride.mode === 'bus' ? 'Bus' : 'Train'} ${ride.route} at ${sgClock(ride.start)}${live ? ` (live: ${sgClock(live.eta)})` : ''}`);
  else lines.push(`Walk ${plan.legs.reduce((n, l) => n + l.minutes, 0)} min`);
  lines.push(`Arrive ${sgClock(plan.arriveAt)}${plan.start ? ` for ${sgClock(plan.start)}` : ''}`);
  return { title: prefix + title, body: lines.join(' · '), tag: `trip-${plan.id}` };
}

async function runTrips(env, st, now, force) {
  if (!tripsReady(env) || !googleReady(env)) return { skipped: 'calendar or trip planning is not set up' };
  const planning = force || sgParts(now).hm % 5 === 0;
  const report = [];
  for (const [id, dev] of Object.entries(st.devices)) {
    const entry = await tripFor(env, st, id, dev, now, force, planning).catch((e) => ({ id, error: String(e.message || e) }));
    await flushPhone(env, id, dev);
    if (entry) report.push(entry);
  }
  return { planned: planning, devices: report };
}

async function tripFor(env, st, id, dev, now, force, planning) {
    if (!dev.trip || !dev.trip.enabled || !dev.gs) { delete dev.plan; return null; }
    if (planning) await planFor(env, dev, now);
    const plan = dev.plan;
    if (!plan) return { id, plan: 'no appointment with a location in the next 3 hours' };
    if (plan.failed) return { id, title: plan.title, plan: `cannot plan: ${plan.failed}` };
    // A route you planned yourself for this same appointment takes over: its own notification is the one sent.
    if (dev.manual && dev.manual.eventId === plan.id && now < dev.manual.leaveAt) return { id, title: plan.title, plan: 'covered by the route you planned' };
    // Send once, from `lead` minutes before leaving until the appointment starts. "sent" is stored, and carried over
    // when the same appointment is re-planned (you moved), so you are not alerted twice.
    const dueMinute = Math.floor((plan.leaveAt - dev.trip.lead * 60_000) / 60_000), nowMinute = Math.floor(now / 60_000);
    const due = !plan.sent && nowMinute >= dueMinute && now < plan.start;
    if (due) plan.sent = true;
    const entry = { id, title: plan.title, leaveAt: sgClock(plan.leaveAt), alertAt: sgClock(dueMinute * 60_000), sent: Boolean(plan.sent) };
    if (due || force) {
      const live = await liveFirstBus(env, plan);
      const msg = tripMessage(plan, now, live, due ? '' : 'Preview: ');
      const status = await (due ? sendOnce : sendPush)(env, dev, st.origin, msg, ttlUntil(plan.leaveAt, now)).catch(() => 0);
      if (due) logSend(dev, 'calendar, sent by the schedule', msg.title, status);
      entry.sent = due ? status : `preview ${status}`;
      if (status === 404 || status === 410) { delete st.devices[id]; await removePhone(env, id); }
    }
    return entry;
}

// ---------- Departure alert for a trip planned in the app ----------
// The app sends the trip it just planned; one notification goes out `lead` minutes before the time to leave,
// whether the app is open or closed. One planned trip per phone; planning another replaces it.

function sanitizeManual(t) {
  if (!t || !(Number(t.leaveAt) > 0) || !(Number(t.arriveAt) > 0)) return null;
  const name = (p) => String((p && p.name) || '').slice(0, 60);
  const legs = (Array.isArray(t.legs) ? t.legs : []).slice(0, 8).map((l) => ({
    mode: l && ['walk', 'bus', 'train'].includes(l.mode) ? l.mode : 'walk', route: String((l && l.route) || '').slice(0, 8),
    from: { name: name(l && l.from), code: l && l.from && /^\d{5}$/.test(l.from.code || '') ? l.from.code : null }, to: { name: name(l && l.to) },
    start: Number(l && l.start) || 0, minutes: Math.max(1, Math.round(Number(l && l.minutes)) || 1),
  }));
  return {
    id: `m${Math.floor(Number(t.leaveAt) / 60_000)}`, title: String(t.title || 'your trip').slice(0, 60),
    leaveAt: Number(t.leaveAt), arriveAt: Number(t.arriveAt), start: Number(t.arriveBy) > 0 ? Number(t.arriveBy) : null,
    onTime: t.onTime !== false, lead: Math.min(60, Math.max(1, Math.round(Number(t.lead)) || 10)), legs,
    eventId: t.eventId ? String(t.eventId).slice(0, 200) : null,   // the calendar appointment this route is for, if any
  };
}

const logSend = (dev, kind, title, status) => { if (status === 208) return;   // a suppressed repeat is not a send
  dev.log = [{ t: Date.now(), kind, title, status }, ...(dev.log || [])].slice(0, 20); };
const ttlUntil = (ts, now) => Math.min(3600, Math.max(300, (ts - now) / 1000));   // seconds a push may wait for the phone
const dueMinuteOf = (m) => Math.floor((m.leaveAt - m.lead * 60_000) / 60_000);

async function pushTrip(request, env) {
  const body = await request.json().catch(() => null);
  const sub = body && body.subscription;
  const endpoint = (sub && sub.endpoint) || (body && body.endpoint);
  const id = endpoint ? await deviceId(endpoint) : null;
  let dev = id ? await loadPhone(env, id) : null;
  // A phone that registered seconds ago may not be readable from storage yet; its subscription, sent along, is enough to notify it.
  if (!dev && sub && sub.keys && sub.keys.p256dh && sub.keys.auth && pushHostAllowed(env, endpoint)) {
    dev = track({ endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, muted: {}, log: [] });
  }
  if (!dev) return json(404, { error: 'This device is not registered for notifications yet' });
  const origin = new URL(request.url).origin;
  const now = Date.now();
  const m = sanitizeManual(body.trip);
  if (!m || m.leaveAt <= now) {                       // cancel, or it is already time to leave
    delete dev.manual;
    await flushPhone(env, id, dev);
    return json(200, { ok: true, manual: null });
  }
  let sentNow = false;
  if (Math.floor(now / 60_000) >= dueMinuteOf(m)) {   // less than `lead` minutes left: tell them straight away
    m.sent = true;
    const msg = tripMessage(m, now, await liveFirstBus(env, m));
    const status = await sendOnce(env, dev, origin, msg, ttlUntil(m.leaveAt, now)).catch(() => 0);
    sentNow = status >= 200 && status < 300;
    logSend(dev, 'planned route, sent at once because the alert time had passed', msg.title, status);
  }
  dev.manual = m;
  await flushPhone(env, id, dev);
  return json(200, { ok: true, manual: { ...m, alertAt: dueMinuteOf(m) * 60_000 }, sentNow });
}

async function runManual(env, st, now) {
  const report = [];
  for (const [id, dev] of Object.entries(st.devices)) {
    const m = dev.manual;
    if (!m) continue;
    if (now > m.leaveAt + 5 * 60_000) { delete dev.manual; await flushPhone(env, id, dev); continue; }   // over: tidy up
    const entry = { id, title: m.title, leaveAt: sgClock(m.leaveAt), alertAt: sgClock(dueMinuteOf(m) * 60_000), sent: Boolean(m.sent) };
    if (!m.sent && Math.floor(now / 60_000) >= dueMinuteOf(m) && now < m.leaveAt) {
      m.sent = true;
      const msg = tripMessage(m, now, await liveFirstBus(env, m));
      const status = await sendOnce(env, dev, st.origin, msg, ttlUntil(m.leaveAt, now)).catch(() => 0);
      logSend(dev, 'planned route, sent by the schedule', msg.title, status);
      entry.sent = status;
      await flushPhone(env, id, dev);
      if (status === 404 || status === 410) { delete st.devices[id]; await removePhone(env, id); }
    }
    report.push(entry);
  }
  return report;
}

async function schedulerStatus(env) {
  if (!env.KV) return null;
  const c = await kGet(env, 'cron').catch(() => null);
  if (!c) return { lastRun: null, note: 'No scheduled run recorded yet. Runs are recorded every 10 minutes.' };
  const ago = Math.round((Date.now() - c.lastRun) / 60_000);
  return { lastRun: sgClock(c.lastRun), minutesAgo: ago, healthy: ago <= 12, lastSend: c.lastSend ? sgClock(c.lastSend) : null, lastError: c.lastError ? `${sgClock(c.lastError.t)} ${c.lastError.message}` : null };
}

// The every-minute job: bus alert times, the planned trip's departure alert, then calendar leave alerts.
async function runAlerts(env, now = Date.now(), force = false) {
  if (!pushReady(env) || !env.LTA_ACCOUNT_KEY) return { skipped: 'push is not configured' };
  const st = await loadState(env);
  const alarms = await runAlarms(env, st, now, force).catch((e) => ({ error: String(e.message || e) }));
  const departures = await runManual(env, st, now).catch((e) => ({ error: String(e.message || e) }));
  const trips = await runTrips(env, st, now, force).catch((e) => ({ error: String(e.message || e) }));
  const recent = Object.fromEntries(Object.entries(st.devices).map(([id, d]) => [id, (d.log || []).slice(0, 5).map((e) => `${sgClock(e.t)} ${e.title} [${e.kind}; push service ${e.status}]`)]));
  return { phones: Object.keys(st.devices).length, ...alarms, departures, trips, recentDepartureSends: recent };
}

// Heartbeat: proof that Cloudflare is running the every-minute schedule. Stored every 10 minutes (to stay well inside
// the free storage-write limit) and whenever a run sent something or failed.
async function beat(env, ts, result, error) {
  const sentSomething = result && (result.sent > 0 || (Array.isArray(result.departures) && result.departures.some((d) => typeof d.sent === 'number')) || (result.trips && Array.isArray(result.trips.devices) && result.trips.devices.some((d) => typeof d.sent === 'number')));
  if (!error && !sentSomething && Math.floor(ts / 60_000) % 10 !== 0) return;
  const prev = (await kGet(env, 'cron')) || {};
  await kPut(env, 'cron', { lastRun: ts, lastSend: sentSomething ? ts : prev.lastSend || null, lastError: error ? { t: ts, message: String(error).slice(0, 200) } : prev.lastError || null });
}

export default {
  async scheduled(event, env, ctx) {
    const ts = event.scheduledTime || Date.now();
    ctx.waitUntil(runAlerts(env, ts).then((r) => beat(env, ts, r, null), (e) => { console.error('alerts failed:', e.message); return beat(env, ts, null, e.message); }).catch(() => {}));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/push/')) return pushRoutes(request, env, url);
    if (url.pathname.startsWith('/api/google/') || url.pathname === '/api/calendar/next') return googleRoutes(request, env, url);
    if ((url.pathname === '/api/places' || url.pathname === '/api/route' || url.pathname === '/api/geocode') && request.method === 'GET') return tripRoutes(request, env, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    try {
      if (url.pathname === '/api/arrivals') {
        const stop = url.searchParams.get('stop') || '';
        if (!/^\d{5}$/.test(stop)) return json(400, { error: 'stop must be a 5-digit bus stop code' });
        if (!env.LTA_ACCOUNT_KEY) return json(500, { error: 'The LTA_ACCOUNT_KEY secret is not set on this Worker' });
        return json(200, await getArrivals(env, stop));
      }
      if (url.pathname === '/api/stops') return json(200, { stops: searchStops(url.searchParams.get('q') || '') });
      if (url.pathname === '/api/status') return json(200, { mock: false, hosted: true, build: BUILD, stops: STOPS.length, push: pushReady(env), trips: tripsReady(env), calendar: googleReady(env), scheduler: await schedulerStatus(env), ...(await keyInfo(env)) });

      const asset = ASSETS[url.pathname === '/' ? '/index.html' : url.pathname];
      if (asset) return new Response(asset.body, { headers: { 'content-type': asset.type, 'cache-control': 'no-cache' } });
      return new Response('Not found', { status: 404 });
    } catch (err) {
      return json(502, { error: 'Could not reach LTA right now', detail: String(err.message || err) });
    }
  },
};
