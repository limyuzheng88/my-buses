// My Buses – front end. State lives in localStorage (no accounts in v1).

const REFRESH_MS = 20_000;
const STORE_KEY = 'mybuses.v1';

// ---------- state ----------
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.stops)) return s;
  } catch {}
  // First run: no stops. The page invites the user to search for one.
  return { stops: [], alertsOn: false };
}
const state = loadState();

// Alert times ("alarms") per stop: days of the week and/or specific dates, hours, and how often to notify.
const SG = 8 * 3600_000, DAY = 86_400_000;
const sgDate = (ts = Date.now()) => new Date(ts + SG).toISOString().slice(0, 10);
const newAlarm = () => ({ id: Math.random().toString(36).slice(2, 10), days: [], dates: [], from: '07:30', to: '09:00', every: 5 });
for (const stop of state.stops) {
  if (!Array.isArray(stop.alarms)) {   // older saved data had one days/from/to per stop
    stop.alarms = stop.days && stop.days.length ? [{ ...newAlarm(), days: stop.days, from: stop.from || '07:30', to: stop.to || '09:00' }] : [];
    delete stop.days; delete stop.from; delete stop.to;
  }
  const keepFrom = sgDate(Date.now() - DAY);   // drop dates that have passed
  for (const al of stop.alarms) al.dates = (al.dates || []).filter((d) => d >= keepFrom);
}
let serverMuted = {};  // "stop|alarm" -> time until which that alarm was stopped (from the server)
const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {} schedulePushSync(); };

// Closed-app alerts (only when the server supports push, i.e. the hosted version)
let pushAvailable = false; // server has push set up
let pushSub = null;        // this browser's push subscription, once alerts are on
let pushSyncTimer;

const arrivals = {};   // stop code -> latest API response (or { error })
const editing = new Set(); // stop codes showing all services for follow selection
const openAlarms = new Set(); // "stop|alarm" keys whose editor is open; the rest show as one line
let lastRefresh = null;

// ---------- tiny DOM helper (never uses innerHTML, so stop names can't inject markup) ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

const minsFrom = (iso) => Math.max(0, Math.floor((Date.parse(iso) - Date.now()) / 60_000));
const fmtMin = (m) => (m <= 0 ? 'Arr' : `${m}`);

// ---------- data ----------
async function fetchStop(code) {
  try {
    const r = await fetch(`/api/arrivals?stop=${code}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    arrivals[code] = await r.json();
  } catch (e) {
    arrivals[code] = { error: e.message, prev: arrivals[code]?.services };
  }
}

async function refreshAll() {
  await Promise.all(state.stops.map((s) => fetchStop(s.code)));
  lastRefresh = new Date();
  const el = document.activeElement;
  if (!(el && el.tagName === 'INPUT' && el.closest('#stops'))) render();   // don't rebuild a card while it is being edited
  nudgeDeparture();
}

// Backup while the app is open: if the alert time has arrived and the server has not sent the departure notification,
// ask it to send now. (With the app closed, Cloudflare's every-minute schedule is what sends it.)
let nudging = false;
async function nudgeDeparture() {
  if (nudging || !pushSub || !departure || departure.sent || Date.now() < departure.alertAt + 60_000 || Date.now() >= departure.leaveAt) return;
  nudging = true;
  try { await pushSyncNow(); } catch {}   // first learn whether the server already sent it
  if (!departure || departure.sent || Date.now() >= departure.leaveAt) { nudging = false; return renderDeparture(); }
  try { const r = await setDeparture({ ...departure, arriveBy: departure.start }); departure = r.manual ? { ...r.manual, sentNow: r.sentNow } : null; renderDeparture(); } catch {}
  nudging = false;
}

// ---------- render ----------
function render() {
  const root = document.getElementById('stops');
  root.replaceChildren(...(state.stops.length ? state.stops.map(stopCard) : [h('p', { class: 'note' }, 'No stops yet. Search below to add one.')]));
  const st = document.getElementById('status');
  const mock = Object.values(arrivals).some((a) => a.mock);
  st.textContent = lastRefresh ? `${mock ? 'DEMO data · ' : ''}Updated ${lastRefresh.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Loading…';
}

function stopCard(stop) {
  const data = arrivals[stop.code];
  const isEditing = editing.has(stop.code);
  const head = h('div', { class: 'stop-head' },
    h('div', {},
      h('div', { class: 'stop-name' }, stop.name),
      h('div', { class: 'stop-code' }, `Stop ${stop.code}`)),
    h('div', {},
      h('button', { class: 'icon-btn', title: 'Choose services', 'aria-label': 'Choose services to follow', onclick: () => { isEditing ? editing.delete(stop.code) : editing.add(stop.code); render(); } }, isEditing ? '✓' : '⚙'),
      h('button', { class: 'icon-btn', title: 'Remove stop', 'aria-label': 'Remove stop', onclick: () => removeStop(stop.code) }, '✕')));

  const card = h('article', { class: 'stop' }, head);

  if (!data) { card.append(h('div', { class: 'empty' }, 'Loading…')); return card; }
  if (data.error && !data.prev) { card.append(h('div', { class: 'empty' }, `Couldn't load arrivals (${data.error}). Retrying…`)); return card; }
  if (data.error) card.append(h('div', { class: 'empty' }, 'Showing last known times; refresh failed.'));

  const services = data.services || data.prev || [];
  const followedSet = new Set(stop.followed || []);
  const visible = isEditing || followedSet.size === 0 ? services : services.filter((s) => followedSet.has(s.service));

  if (!services.length) card.append(h('div', { class: 'empty' }, 'No service right now. Buses may not be running at this hour.'));
  else if (!visible.length) card.append(h('div', { class: 'empty' }, `None of your followed buses (${[...followedSet].join(', ')}) have an estimate yet. Tap ⚙ to change.`));

  for (const svc of visible) card.append(serviceRow(stop, svc, followedSet.has(svc.service), isEditing));

  if (!isEditing && followedSet.size) {
    // Followed services that are not in the feed at all right now
    const missing = [...followedSet].filter((n) => !services.some((s) => s.service === n));
    for (const n of missing) card.append(h('div', { class: 'svc off' }, h('div', { class: 'svc-no' }, n), h('div', { class: 'note' }, 'No estimate yet'), h('div')));
  }

  card.append(h('div', { class: 'thresh' }, 'Say "Leave now" when a followed bus is within',
    h('input', { type: 'number', min: 1, max: 60, value: stop.threshold, 'aria-label': 'Alert threshold in minutes', onchange: (e) => { stop.threshold = Math.min(60, Math.max(1, Number(e.target.value) || 10)); save(); } }),
    'min'));
  if (pushAvailable) card.append(alarmsSection(stop));
  return card;
}

// Same rule the server uses: is this alarm's timeframe running now, and when does it end?
const toMin = (s) => { const m = /^(\d{2}):(\d{2})$/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
function sgParts(ts) {
  const d = new Date(ts + SG);
  return { dow: d.getUTCDay(), date: d.toISOString().slice(0, 10), hm: d.getUTCHours() * 60 + d.getUTCMinutes(), midnight: Math.floor((ts + SG) / DAY) * DAY - SG };
}
function alarmWindow(alarm, now = Date.now()) {
  const from = toMin(alarm.from), to = toMin(alarm.to);
  if (from == null || to == null || from === to) return { active: false };
  const t = sgParts(now), y = sgParts(now - DAY);
  const on = (p) => alarm.days.includes(p.dow) || alarm.dates.includes(p.date);
  if (from < to) return on(t) && t.hm >= from && t.hm < to ? { active: true, end: t.midnight + to * 60_000 } : { active: false };
  if (on(t) && t.hm >= from) return { active: true, end: t.midnight + DAY + to * 60_000 };
  if (on(y) && t.hm < to) return { active: true, end: t.midnight + to * 60_000 };
  return { active: false };
}
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const niceDate = (d) => new Date(`${d}T00:00:00+08:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

const DAY_CHIPS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];

// Closed-app alerts for one stop: any number of alert times.
function alarmsSection(stop) {
  const changed = () => { save(); render(); };
  const box = h('div', { class: 'window' }, h('div', { class: 'window-title' }, 'Notify me of bus times at these times only'));
  const ask = stop.alarms.length ? pushPrompt('these alert times will not reach you') : null;
  if (ask) box.append(ask);
  if (!(stop.followed || []).length) box.append(h('div', { class: 'note' }, 'Tap ⚙ and follow at least one bus first.'));
  stop.alarms.forEach((al, idx) => box.append(alarmEditor(stop, al, idx, changed)));
  box.append(h('button', { class: 'secondary small', type: 'button', onclick: () => { const al = newAlarm(); stop.alarms.push(al); openAlarms.add(`${stop.code}|${al.id}`); changed(); ensurePush(); } }, '+ Add an alert time'));
  return box;
}

function alarmEditor(stop, al, idx, changed) {
  const key = `${stop.code}|${al.id}`;
  const w = alarmWindow(al);
  const stoppedUntil = serverMuted[key] > Date.now() ? serverMuted[key] : null;

  const days = h('div', { class: 'chips' }, DAY_CHIPS.map(([d, label]) => h('button', {
    type: 'button', class: `chip${al.days.includes(d) ? ' on' : ''}`, 'aria-pressed': String(al.days.includes(d)),
    onclick: () => { al.days = al.days.includes(d) ? al.days.filter((x) => x !== d) : [...al.days, d].sort(); changed(); },
  }, label)));

  const dates = h('div', { class: 'chips' },
    al.dates.map((d) => h('button', { type: 'button', class: 'chip on', title: 'Remove this date', onclick: () => { al.dates = al.dates.filter((x) => x !== d); changed(); } }, `${niceDate(d)} ✕`)),
    h('label', { class: 'date-add' }, 'Add a date',
      h('input', { type: 'date', min: sgDate(), 'aria-label': 'Add a specific date', onchange: (e) => { const d = e.target.value; if (d && !al.dates.includes(d)) { al.dates = [...al.dates, d].sort(); changed(); } } })));

  const time = (field, label) => h('input', { type: 'time', value: al[field], 'aria-label': label, onchange: (e) => { if (e.target.value) { al[field] = e.target.value; changed(); } } });
  const every = h('input', { type: 'number', min: 2, max: 60, value: al.every, 'aria-label': 'Minutes between notifications', onchange: (e) => { al.every = Math.min(60, Math.max(2, Math.round(Number(e.target.value)) || 5)); changed(); } });

  const hasWhen = al.days.length || al.dates.length;
  const status = !hasWhen ? 'Off: pick at least one day or date.'
    : al.from === al.to ? 'Off: the start and end times are the same.'
    : stoppedUntil ? `Stopped until ${clock(stoppedUntil)}.`
    : w.active && pushSub ? `Running now until ${clock(w.end)}: a notification every ${al.every} min.`
    : `A notification every ${al.every} min during these hours${toMin(al.to) < toMin(al.from) ? ' (runs past midnight)' : ''}, app open or closed.`;

  const buttons = h('div', { class: 'alarm-actions' });
  if (pushSub && w.active && !stoppedUntil) buttons.append(h('button', { type: 'button', class: 'link', onclick: () => stopAlarm(stop, al) }, 'Stop for now'));
  buttons.append(h('button', { type: 'button', class: 'link danger', onclick: () => { stop.alarms.splice(idx, 1); changed(); } }, 'Remove'));

  // Closed: one line saying when it runs. Tap it to edit.
  if (!openAlarms.has(key)) {
    const short = !hasWhen || al.from === al.to ? status : stoppedUntil ? `Stopped until ${clock(stoppedUntil)}` : w.active && pushSub ? `Running now until ${clock(w.end)}` : '';
    return h('button', { type: 'button', class: `alarm alarm-line${w.active && pushSub && !stoppedUntil ? ' running' : ''}`, 'aria-expanded': 'false', onclick: () => { openAlarms.add(key); render(); } },
      h('span', { class: 'alarm-when' }, alarmSummary(al)), short ? h('span', { class: 'alarm-state' }, short) : null, h('span', { class: 'alarm-edit' }, 'Edit'));
  }
  buttons.append(h('button', { type: 'button', class: 'link', onclick: () => { openAlarms.delete(key); render(); } }, 'Done'));
  return h('div', { class: 'alarm' },
    days, dates,
    h('div', { class: 'window-row' }, 'from', time('from', 'Start time'), 'to', time('to', 'End time'), 'every', every, 'min'),
    h('div', { class: 'note' }, status),
    buttons);
}

// "Weekdays · 07:30 to 09:00 · every 5 min"
function alarmSummary(al) {
  const has = (...ds) => ds.every((d) => al.days.includes(d));
  const days = al.days.length === 7 ? 'Every day' : al.days.length === 5 && has(1, 2, 3, 4, 5) ? 'Weekdays' : al.days.length === 2 && has(6, 0) ? 'Weekends'
    : DAY_CHIPS.filter(([d]) => al.days.includes(d)).map(([, label]) => label).join(', ');
  const dates = al.dates.length === 1 ? niceDate(al.dates[0]) : al.dates.length ? `${al.dates.length} dates` : '';
  return `${[days, dates].filter(Boolean).join(' + ') || 'No days chosen'} · ${al.from} to ${al.to} · every ${al.every} min`;
}

async function stopAlarm(stop, al) {
  try {
    const r = await (await fetch('/api/push/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: pushSub.endpoint, code: stop.code, alarm: al.id }) })).json();
    if (r.until) serverMuted[`${stop.code}|${al.id}`] = r.until;
  } catch (e) { console.warn('stop failed', e); }
  render();
}

function serviceRow(stop, svc, followed, isEditing) {
  const etas = h('div', { class: 'etas' });
  if (!svc.buses.length) etas.append(h('span', { class: 'note' }, 'No estimate yet'));
  svc.buses.forEach((b, i) => {
    const m = minsFrom(b.eta);
    etas.append(h('div', { class: `eta${m <= (stop.threshold || 10) && i === 0 ? ' soon' : ''}` },
      h('b', {}, fmtMin(m)),
      h('small', {}, b.load ? h('span', { class: `load ${b.load}`, title: b.load }) : null, i === 0 ? 'min' : '')));
  });
  const follow = isEditing
    ? h('label', { class: 'follow' }, h('input', { type: 'checkbox', checked: followed, onchange: (e) => toggleFollow(stop, svc.service, e.target.checked) }), 'follow')
    : h('div');
  return h('div', { class: `svc${isEditing && !followed ? ' off' : ''}` }, h('div', { class: 'svc-no' }, svc.service), etas, follow);
}

function toggleFollow(stop, service, on) {
  const set = new Set(stop.followed || []);
  on ? set.add(service) : set.delete(service);
  stop.followed = [...set];
  save();
}

function removeStop(code) {
  state.stops = state.stops.filter((s) => s.code !== code);
  delete arrivals[code]; editing.delete(code); save(); render();
}

// ---------- search / bookmark ----------
const q = document.getElementById('q');
const results = document.getElementById('results');
let searchTimer;
q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const term = q.value.trim();
    if (!term) return results.replaceChildren();
    try {
      const { stops } = await (await fetch(`/api/stops?q=${encodeURIComponent(term)}`)).json();
      results.replaceChildren(...(stops.length
        ? stops.map((s) => h('li', {}, h('button', { onclick: () => addStop(s) }, `${s.name} `, h('small', {}, `· ${s.road || ''} · ${s.code}`))))
        : [h('li', { class: 'note' }, 'No matching stops.')]));
    } catch { results.replaceChildren(h('li', { class: 'note' }, 'Search failed. Is the server running?')); }
  }, 250);
});

async function addStop(s) {
  if (!state.stops.some((x) => x.code === s.code)) {
    state.stops.push({ code: s.code, name: s.name, followed: [], threshold: 10, alarms: [] });
    editing.add(s.code); // open service picker so you can choose which buses to follow
    save();
    await fetchStop(s.code);
  }
  q.value = ''; results.replaceChildren(); render();
}

// Replace the placeholder name of the seeded stop once the stop list is available
async function fixSeedNames() {
  for (const s of state.stops.filter((x) => x.name === `Stop ${x.code}` || x.name.endsWith('(mock)'))) {
    try {
      const { stops } = await (await fetch(`/api/stops?q=${s.code}`)).json();
      const hit = stops.find((x) => x.code === s.code);
      if (hit) { s.name = hit.name; save(); }
    } catch {}
  }
}

// ---------- permission to notify ----------
// There is no on/off switch. Notifications follow what is set up: bus alert times on a stop, a planned route, a connected calendar.
// The browser still needs the phone owner's permission once, so the app asks at the moment they first set one of those up.
let pushChecked = false;   // true once we know whether this server can send notifications
const canAskPush = () => 'Notification' in window && pushAvailable;
async function ensurePush() {   // call from a tap; resolves true when this phone can receive notifications
  if (pushSub) return true;
  if (!canAskPush()) return false;
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  state.alertsOn = perm === 'granted'; save();
  if (perm === 'granted') await initPush();
  else { render(); renderDeparture(); if (cal) renderCal(); }
  return Boolean(pushSub);
}
// What to show where notifications are needed but this phone cannot receive them yet. Null when all is well.
function pushPrompt(what) {
  if (pushSub || !pushChecked) return null;
  if (!canAskPush()) return h('div', { class: 'note' }, 'This browser cannot receive notifications.');
  if (Notification.permission === 'denied') return h('div', { class: 'note warn' }, `Notifications are blocked for this site, so ${what}. Allow them in your browser's site settings, then reopen the app.`);
  return h('div', { class: 'push-ask' }, h('span', {}, `Notifications are not allowed on this phone yet, so ${what}.`),
    h('button', { type: 'button', class: 'secondary small', onclick: () => ensurePush() }, 'Allow notifications'));
}

// ---------- alerts when the app is closed (push) ----------
const keyBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function initPush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const r = await fetch('/api/push/key');
    if (!r.ok) return; // this server has no push set up (for example, the local version)
    const { key } = await r.json();
    pushAvailable = true;
    if (state.alertsOn && Notification.permission === 'granted') {
      const reg = await navigator.serviceWorker.ready;
      pushSub = await reg.pushManager.getSubscription();
      if (!pushSub) {
        try { pushSub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }); }
        catch (e) { console.warn('push subscribe failed', e); }
      }
      if (pushSub) schedulePushSync();
    }
  } catch (e) { console.warn('push setup failed', e); }
  pushChecked = true;
  render(); if ($('trip-alert')) renderDeparture(); if (cal) renderCal();
}

const pushRules = () => state.stops.map(({ code, name, followed, threshold, alarms }) => ({ code, name, followed, threshold, alarms }));
const tripSettings = () => ({ enabled: Boolean(state.alertsOn), lead: (state.trip && state.trip.lead) || 10, origin: (state.trip && state.trip.origin) || null, fix: state.lastFix || null, places: state.places || [] });
async function pushSyncNow() {
  const r = await fetch('/api/push/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: pushSub.toJSON(), stops: pushRules(), trip: tripSettings() }) });
  const body = await r.json().catch(() => ({}));
  if (body.muted) { serverMuted = body.muted; render(); }
  if ('plan' in body) { serverPlan = body.plan; calendarLinked = Boolean(body.calendarLinked); if (cal) renderCal(); }
  if ('manual' in body && !departureNote) { departure = body.manual; if ($('trip-alert')) renderDeparture(); }
  if (Array.isArray(body.log)) { serverLog = body.log; renderLog(); }
}
function schedulePushSync() {
  if (!pushSub) return;
  clearTimeout(pushSyncTimer);
  pushSyncTimer = setTimeout(() => pushSyncNow().catch((e) => console.warn('push sync failed', e)), 1500);
}

// ---------- trip planning (only when the server has OneMap set up) ----------
if (!Array.isArray(state.places)) state.places = [];   // saved places: { name, address, lat, lng }
if (!state.trip) state.trip = { enabled: false, lead: 10, origin: null };
let departure = null;     // the departure alert the server holds for this phone: { title, leaveAt, alertAt, lead, sent }
let departureNote = '';
let tripTo = null;        // chosen destination { name, address, lat, lng }
let tripPlan = null;      // last answer from /api/route
let tripMsg = '';
let tripFor = null;       // the calendar event this plan is for, if any
let cal = null;           // { signedIn, events } from the calendar, or null when calendar isn't set up
let serverPlan = null;    // the leave alert the server currently has planned for this phone
let calendarLinked = false;
const $ = (id) => document.getElementById(id);

function getFix() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location is not available in this browser.'));
    navigator.geolocation.getCurrentPosition(
      (p) => { state.lastFix = { lat: p.coords.latitude, lng: p.coords.longitude, t: Date.now() }; save(); resolve(state.lastFix); },
      (e) => reject(new Error(e.code === 1 ? 'Location permission was denied. Allow it, or pick a saved place under From.' : 'Could not get your location. Try again, or pick a saved place under From.')),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 });
  });
}

function renderTripInputs() {
  const from = $('trip-from'), keep = from.value;
  from.replaceChildren(h('option', { value: 'gps' }, 'My current location'), ...state.places.map((p, i) => h('option', { value: String(i) }, p.name)));
  if ([...from.options].some((o) => o.value === keep)) from.value = keep;

  $('trip-places').replaceChildren(...state.places.map((p, i) => h('span', { class: 'place' },
    h('button', { type: 'button', class: `chip${tripTo && tripTo.lat === p.lat && tripTo.lng === p.lng ? ' on' : ''}`, onclick: () => { tripTo = p; renderTripInputs(); } }, p.name),
    h('button', { type: 'button', class: 'icon-btn small', title: `Forget ${p.name}`, 'aria-label': `Forget ${p.name}`, onclick: () => { state.places.splice(i, 1); save(); renderTripInputs(); if (cal) renderCal(); } }, '✕'))));

  const chosen = $('trip-chosen');
  if (!tripTo) return chosen.replaceChildren();
  const isSaved = state.places.some((p) => p.lat === tripTo.lat && p.lng === tripTo.lng);
  const nameBox = h('input', { type: 'text', maxlength: 24, placeholder: 'Name, e.g. Home', 'aria-label': 'Name for this place' });
  chosen.replaceChildren(...[
    h('div', { class: 'note' }, `Going to: ${tripTo.name}${tripTo.address && tripTo.address !== tripTo.name ? `, ${tripTo.address}` : ''}`),
    isSaved ? null : h('div', { class: 'window-row' }, nameBox, h('button', { type: 'button', class: 'link', onclick: () => {
      const name = nameBox.value.trim();
      if (!name) return nameBox.focus();
      state.places.push({ name, address: tripTo.address, lat: tripTo.lat, lng: tripTo.lng });
      tripTo = state.places[state.places.length - 1]; save(); renderTripInputs(); if (cal) renderCal();
    } }, 'Save this place'))].filter(Boolean));
}

let placeTimer;
function onPlaceSearch() {
  clearTimeout(placeTimer);
  placeTimer = setTimeout(async () => {
    const term = $('trip-to').value.trim();
    if (term.length < 2) return $('trip-results').replaceChildren();
    try {
      const r = await fetch(`/api/places?q=${encodeURIComponent(term)}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.detail || body.error);
      $('trip-results').replaceChildren(...(body.places.length
        ? body.places.map((p) => h('li', {}, h('button', { type: 'button', onclick: () => { tripTo = p; $('trip-to').value = ''; $('trip-results').replaceChildren(); renderTripInputs(); } }, `${p.name} `, h('small', {}, p.address && p.address !== p.name ? `· ${p.address}` : ''))))
        : [h('li', { class: 'note' }, 'No matching places. Check the spelling, or try the postal code.')]));
    } catch (e) { $('trip-results').replaceChildren(h('li', { class: 'note' }, `Search failed: ${e.message}`)); }
  }, 350);
}

function renderTripOut() {
  const out = $('trip-out');
  if (tripMsg) return out.replaceChildren(h('p', { class: 'note' }, tripMsg));
  if (!tripPlan) return out.replaceChildren();
  if (!tripPlan.options.length) return out.replaceChildren(h('p', { class: 'note' }, 'No public transport route found for that trip.'));
  const kids = [];
  if (tripFor) kids.push(h('p', { class: 'note' }, `For: ${tripFor.title}, ${whenLabel(tripFor.start)}`));
  if (tripPlan.arriveBy && !tripPlan.onTime) kids.push(h('p', { class: 'note' }, `Nothing gets there by ${clock(tripPlan.arriveBy)}. These are the closest.`));
  tripPlan.options.forEach((o, idx) => {
    const late = o.leaveAt < Date.now() - 60_000;
    const steps = o.legs.map((l) => h('li', {},
      l.mode === 'walk' ? `Walk ${l.minutes} min to ${l.to.name || 'your destination'}`
        : l.mode === 'bus' ? `Bus ${l.route} from ${l.from.name}${l.from.code ? ` (${l.from.code})` : ''}, ${l.stops} stop${l.stops === 1 ? '' : 's'} to ${l.to.name}`
          : `Train ${l.route} from ${l.from.name} to ${l.to.name}`,
      l.mode === 'walk' ? null : h('small', {}, ` · ${clock(l.start)}`)));
    kids.push(h('article', { class: `option${idx === 0 ? ' first' : ''}` },
      h('div', { class: 'option-head' }, late ? 'Leave now' : `Leave at ${clock(o.leaveAt)}`),
      h('div', { class: 'note' }, `Arrive ${clock(o.arriveAt)} · ${o.minutes} min · walk ${o.walkMinutes} min${o.fare ? ` · $${o.fare}` : ''}`),
      o.live ? h('div', { class: 'live' }, `Live: Bus ${o.live.service} reaches stop ${o.live.stop} at ${clock(o.live.eta)} (in ${Math.max(0, Math.floor((o.live.eta - Date.now()) / 60_000))} min)`) : null,
      h('ol', { class: 'steps' }, steps)));
  });
  out.replaceChildren(...kids);
}

// arriveTs is set when routing to a calendar event; otherwise the Leave now / Arrive by choice is used.
async function planTrip(arriveTs = null) {
  if (!arriveTs) tripFor = null;
  if (!tripTo) { tripMsg = 'Choose where you are going first.'; return renderTripOut(); }
  const btn = $('trip-go');
  btn.disabled = true; tripPlan = null; tripMsg = 'Finding your route…'; renderTripOut();
  try {
    const sel = $('trip-from').value;
    const from = sel === 'gps' ? await getFix() : state.places[Number(sel)];
    let when = '';
    if (arriveTs) when = `&arrive=${encodeURIComponent(new Date(arriveTs).toISOString())}`;
    else if (document.querySelector('input[name="trip-when"]:checked').value === 'arrive') {
      const hm = $('trip-time').value;
      if (!hm) throw new Error('Set the time you need to arrive by.');
      // The time is Singapore time today; if it has already passed, it means tomorrow.
      let ts = Date.parse(`${sgDate()}T${hm}:00+08:00`);
      if (ts < Date.now()) ts += DAY;
      when = `&arrive=${encodeURIComponent(new Date(ts).toISOString())}`;
    }
    const r = await fetch(`/api/route?from=${from.lat},${from.lng}&to=${tripTo.lat},${tripTo.lng}${when}`);
    const body = await r.json();
    if (!r.ok) throw new Error(body.detail || body.error || `HTTP ${r.status}`);
    tripPlan = body; tripMsg = '';
    await scheduleDeparture();
  } catch (e) { tripMsg = e.message; }
  btn.disabled = false; renderTripOut(); renderDeparture();
}

// Ask the server to notify this phone before the planned trip's departure. Works with the app open or closed.
async function setDeparture(trip) {
  const send = () => fetch('/api/push/trip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: pushSub.endpoint, subscription: pushSub.toJSON(), trip }) });
  let r = await send();
  if (r.status === 404) { await pushSyncNow(); r = await send(); }   // phone not registered yet
  const body = await r.json();
  if (!r.ok) throw new Error(body.detail || body.error || `HTTP ${r.status}`);
  return body;
}

async function scheduleDeparture() {
  const o = tripPlan && tripPlan.options[0];
  departureNote = '';
  if (!o) return;
  if (!pushSub) return;   // renderDeparture explains and offers to allow notifications
  if (o.leaveAt - Date.now() < 60_000) {   // leaving now: nothing to wait for, and any earlier trip's notification no longer applies
    if (departure) { try { await setDeparture(null); } catch {} departure = null; }
    return;
  }
  try {
    const r = await setDeparture({ eventId: tripFor ? tripFor.id : null, title: tripFor ? tripFor.title : tripTo.name, leaveAt: o.leaveAt, arriveAt: o.arriveAt, arriveBy: tripPlan.arriveBy, onTime: tripPlan.onTime, lead: state.trip.lead, legs: o.legs });
    departure = r.manual ? { ...r.manual, sentNow: r.sentNow } : null;
  } catch (e) { departureNote = `Could not set the departure notification: ${e.message}`; }
}

function renderDeparture() {
  const box = $('trip-alert');
  if (departureNote) return box.replaceChildren(h('div', { class: 'note' }, departureNote));
  const o = tripPlan && tripPlan.options[0];
  if (!pushSub && o && o.leaveAt - Date.now() >= 60_000) { const ask = pushPrompt('you will not be told when to leave'); return box.replaceChildren(...(ask ? [ask] : [])); }
  if (!departure || departure.leaveAt < Date.now()) return box.replaceChildren();
  const lead = h('input', { type: 'number', min: 1, max: 60, value: departure.lead, 'aria-label': 'Minutes of warning before leaving', onchange: async (e) => {
    state.trip.lead = Math.min(60, Math.max(1, Math.round(Number(e.target.value)) || 10)); save();
    try { const r = await setDeparture({ ...departure, arriveBy: departure.start, lead: state.trip.lead }); departure = r.manual ? { ...r.manual, sentNow: r.sentNow } : null; } catch {}
    renderDeparture(); if (cal) renderCal();
  } });
  box.replaceChildren(h('div', { class: 'depart' },
    h('div', { class: 'depart-title' }, `Departure notification: ${departure.title}`),
    h('div', { class: 'window-row' },
      departure.sent ? `Sent. Leave at ${clock(departure.leaveAt)}.` : `Leave at ${clock(departure.leaveAt)}. You will be notified at ${clock(departure.alertAt)},`,
      departure.sent ? null : lead, departure.sent ? null : 'min before.',
      h('button', { type: 'button', class: 'link danger', onclick: async () => { try { await setDeparture(null); } catch {} departure = null; renderDeparture(); } }, 'Cancel'))));
}

async function initTrips() {
  try {
    const s = await (await fetch('/api/status')).json();
    if (!s.trips) return;
    tripsReady = true; showTab(tab);
    $('trip-to').addEventListener('input', onPlaceSearch);
    $('trip-go').addEventListener('click', async () => { await ensurePush(); planTrip(); });
    renderTripInputs();
    if (s.calendar) { loadCalendar(); refreshFixQuietly(); }
  } catch {}
}

// ---------- Google Calendar: next appointments ----------
const whenLabel = (ts) => `${sgDate(ts) === sgDate() ? 'today' : new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${clock(ts)}`;

async function loadCalendar() {
  const params = new URLSearchParams(location.search);
  const flag = params.get('calendar'), why = params.get('why');
  if (flag) history.replaceState(null, '', location.pathname);   // tidy the address after returning from Google
  try { cal = await (await fetch('/api/calendar/next')).json(); } catch { cal = { signedIn: false, error: true }; }
  renderCal(flag, why);
}

function renderCal(flag, reason) {
  const box = $('cal');
  if (!cal) return box.replaceChildren();
  if (!cal.signedIn) {
    const why = flag === 'denied' ? 'Google sign-in was cancelled.' : flag === 'failed' ? `Google sign-in did not complete${reason ? `: ${reason}` : '. Try again.'}`
      : cal.reason === 'expired' ? 'Your Google sign-in has expired. Connect again.' : 'See your next appointment here and get a route to it.';
    return box.replaceChildren(h('div', { class: 'cal' }, h('div', { class: 'note' }, why), h('a', { class: 'btn-link', href: '/api/google/login' }, 'Connect Google Calendar')));
  }
  const rows = cal.events.length
    ? cal.events.map((ev) => h('div', { class: 'cal-ev' },
      h('div', {}, h('div', { class: 'cal-title' }, ev.title), h('div', { class: 'note' }, `${whenLabel(ev.start)}${ev.location ? ` · ${ev.location}` : ' · no location set'}`)),
      ev.location ? h('button', { type: 'button', class: 'link', onclick: () => routeToEvent(ev) }, 'Route') : null))
    : [h('div', { class: 'note' }, 'No appointments in the next 7 days.')];
  box.replaceChildren(h('div', { class: 'cal' },
    h('div', { class: 'cal-head' }, h('span', {}, 'Next appointments'), h('button', { type: 'button', class: 'link', onclick: disconnectCalendar }, 'Disconnect')),
    ...rows, leaveAlertSettings()));
}

// "Tell me before I need to leave": on/off, minutes of warning, and where you start from when the app is closed.
function leaveAlertSettings() {
  const tr = state.trip;
  const changed = () => { save(); renderCal(); };
  const originIdx = tr.origin ? state.places.findIndex((p) => p.lat === tr.origin.lat && p.lng === tr.origin.lng) : -1;
  const status = !pushSub ? (pushPrompt('you will not be told when to leave for these') || '')
    : !calendarLinked ? 'Linking this phone to your calendar… reopen the app if this stays.'
    : !tr.origin && !(state.lastFix && Date.now() - state.lastFix.t < 30 * 60_000) ? 'Choose a starting place, so a route can be planned when the app is closed.'
    : !serverPlan ? 'Watching your calendar. A trip is planned once an appointment with a location is within 3 hours (checked every 5 minutes).'
    : serverPlan.failed ? `Cannot plan for "${serverPlan.title}": ${serverPlan.failed}.`
    : `Planned: ${serverPlan.title}. Leave ${serverPlan.from ? `from ${serverPlan.from} ` : ''}at ${clock(serverPlan.leaveAt)}; you will be alerted ${tr.lead} min before.`;
  return h('div', { class: 'leave' },
    h('div', { class: 'window-row' }, 'Notify me',
      h('input', { type: 'number', min: 1, max: 60, value: tr.lead, 'aria-label': 'Minutes of warning', onchange: (e) => { tr.lead = Math.min(60, Math.max(1, Math.round(Number(e.target.value)) || 10)); changed(); } }), 'min before I need to leave. When the app is closed, start from',
      h('select', { 'aria-label': 'Starting place when the app is closed', onchange: (e) => { const p = state.places[Number(e.target.value)]; tr.origin = p ? { name: p.name, lat: p.lat, lng: p.lng } : null; changed(); } },
        h('option', { value: '-1', selected: originIdx < 0 }, state.places.length ? 'choose a saved place' : 'save a place first'),
        ...state.places.map((p, i) => h('option', { value: String(i), selected: i === originIdx }, p.name)))),
    typeof status === 'string' ? h('div', { class: 'note' }, status) : status);
}

// When leave alerts are on and location is already allowed, note where you are each time the app opens.
// The server uses a position newer than 30 minutes as your starting point; otherwise your chosen saved place.
async function refreshFixQuietly(mayAsk = false) {
  if (!state.alertsOn || !navigator.geolocation) return;
  try {
    const perm = navigator.permissions ? await navigator.permissions.query({ name: 'geolocation' }) : { state: 'prompt' };
    if (perm.state === 'granted' || (mayAsk && perm.state === 'prompt')) await getFix();
  } catch {}
}

// Find the appointment's location on the map (a saved place with a matching name wins), then plan to arrive by its start.
async function routeToEvent(ev) {
  tripPlan = null; tripMsg = `Finding "${ev.location}" on the map…`; renderTripOut();
  const loc = ev.location.toLowerCase();
  let place = state.places.find((p) => p.name.toLowerCase() === loc) || state.places.find((p) => p.name.length > 2 && loc.includes(p.name.toLowerCase()));
  try {
    if (!place) {
      const r = await fetch(`/api/geocode?q=${encodeURIComponent(ev.location)}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.detail || body.error);
      place = body.place;
    }
  } catch (e) { tripMsg = `Could not look up the location: ${e.message}`; return renderTripOut(); }
  if (!place) { tripMsg = `Could not find "${ev.location}" on the map. Search for it under To, then tap Find public transport route.`; return renderTripOut(); }
  tripTo = place; tripFor = ev; renderTripInputs();
  await planTrip(ev.start);
}

async function disconnectCalendar() {
  try { await fetch('/api/google/logout', { method: 'POST' }); } catch {}
  cal = { signedIn: false }; renderCal();
}

// ---------- notification log ----------
// "Received" is recorded on this phone by the service worker each time a notification arrives.
// "Sent" is the server's record of departure notifications it handed to the push service (201 means accepted).
let serverLog = [];
const stamp = (ts) => `${sgDate(ts) === sgDate() ? 'Today' : new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clock(ts)}`;
async function receivedLog() {
  try { const r = await (await caches.open('mb-log')).match('/__log'); const weekAgo = Date.now() - 7 * DAY; return r ? (await r.json()).filter((e) => e && e.t > weekAgo) : []; } catch { return []; }
}
async function renderLog() {
  const out = $('log-out');
  if (!out) return;
  const got = await receivedLog();
  const row = (e, text) => h('li', {}, h('small', {}, stamp(e.t)), ` ${text}`);
  let sched = null;
  try { sched = (await (await fetch('/api/status')).json()).scheduler; } catch {}
  const schedLine = !sched ? null
    : sched.lastRun == null ? 'Cloudflare schedule: no run recorded yet (recorded every 10 minutes). If this stays, the Cron Trigger is missing.'
      : `Cloudflare schedule: last recorded run ${sched.lastRun} (${sched.minutesAgo} min ago)${sched.healthy ? '' : '. It should run every minute, so it looks stopped: check the Cron Trigger in Cloudflare.'}${sched.lastError ? ` Last error: ${sched.lastError}.` : ''}`;
  out.replaceChildren(...[
    schedLine ? h('div', { class: 'note' }, schedLine) : null,
    h('div', { class: 'log-head' }, h('span', {}, `Received on this phone, past week (${got.length})`), got.length ? h('button', { type: 'button', class: 'link', onclick: async () => { try { await caches.delete('mb-log'); } catch {} renderLog(); } }, 'Clear') : null),
    got.length ? h('ul', { class: 'log-list' }, got.map((e) => row(e, `${e.title}${e.body ? `: ${e.body.replace(/\n/g, ' · ')}` : ''}`))) : h('div', { class: 'note' }, 'Nothing received yet.'),
    h('div', { class: 'log-head' }, h('span', {}, `Departure notifications sent by the server, past week (${serverLog.length})`)),
    serverLog.length ? h('ul', { class: 'log-list' }, serverLog.filter((e) => e.t > Date.now() - 7 * DAY).map((e) => row(e, `${e.title} (${e.kind}; ${e.status >= 200 && e.status < 300 ? 'accepted for delivery' : `failed, code ${e.status}`})`))) : h('div', { class: 'note' }, 'None yet.')].filter(Boolean));
}

// ---------- pages: Buses and Trips ----------
// The two pages sit side by side in a sideways-scrolling strip that snaps to one page. Swiping drags the strip with the finger,
// and the highlight behind the tabs moves in step with it. Tapping a tab scrolls the strip smoothly.
const pager = $('pager'), pill = $('tab-pill');
const pages = { bus: $('page-bus'), trip: $('trip') };
const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
let tripsReady = false;   // the Trips page exists only when the server has trip planning set up
let tab = 'bus';          // the page the user chose; remembered between visits
let sliding = false;
let settleTimer = null;
try { if (localStorage.getItem('mybuses.tab') === 'trip') tab = 'trip'; } catch {}
const maxScroll = () => pager.scrollWidth - pager.clientWidth;
const progress = () => (tripsReady && maxScroll() > 0 ? Math.min(1, Math.max(0, pager.scrollLeft / maxScroll())) : 0);   // 0 = Buses, 1 = Trips
function paintTabs() {
  const p = progress();
  pill.style.transform = `translateX(calc(${p.toFixed(4)} * (100% + 4px)))`;
  for (const b of document.querySelectorAll('#tabs button')) { const on = (b.dataset.tab === 'trip') === (p > 0.5); b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
}
// At rest the strip is exactly as tall as the page in view, so a short page has no empty space under it. While sliding, both pages show in full.
function fitHeight() { pager.style.height = sliding ? '' : `${pages[tripsReady ? tab : 'bus'].offsetHeight}px`; }
function settle() {
  sliding = false;
  if (tripsReady) { const now = progress() > 0.5 ? 'trip' : 'bus'; if (now !== tab) { tab = now; try { localStorage.setItem('mybuses.tab', tab); } catch {} } }
  paintTabs(); fitHeight();
}
pager.addEventListener('scroll', () => {
  if (!sliding) { sliding = true; fitHeight(); }
  paintTabs();
  clearTimeout(settleTimer); settleTimer = setTimeout(settle, 140);
}, { passive: true });
function showTab(next, smooth = false) {
  tab = next === 'trip' ? 'trip' : 'bus';
  try { localStorage.setItem('mybuses.tab', tab); } catch {}
  $('tabs').hidden = !tripsReady;
  pages.trip.hidden = !tripsReady;
  const left = tripsReady && tab === 'trip' ? maxScroll() : 0;
  if (smooth && !calm.matches && Math.abs(pager.scrollLeft - left) > 1) pager.scrollTo({ left, behavior: 'smooth' });
  else { pager.scrollTo({ left, behavior: 'instant' }); clearTimeout(settleTimer); settle(); }
}
for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab, true));
if ('ResizeObserver' in window) { const ro = new ResizeObserver(() => { if (!sliding) fitHeight(); }); ro.observe(pages.bus); ro.observe(pages.trip); }
window.addEventListener('resize', () => showTab(tab));
showTab(tab);

// ---------- logs: a button at the top right opens them ----------
$('logs-btn').addEventListener('click', () => { renderLog(); $('log-dialog').showModal(); });
$('log-close').addEventListener('click', () => $('log-dialog').close());
$('log-dialog').addEventListener('click', (e) => { if (e.target === $('log-dialog')) $('log-dialog').close(); });   // tap outside to close

// ---------- boot ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
render();
fixSeedNames();
initPush();
initTrips();
renderLog();
refreshAll();
setInterval(refreshAll, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshAll(); refreshFixQuietly(); schedulePushSync(); renderLog(); } });
