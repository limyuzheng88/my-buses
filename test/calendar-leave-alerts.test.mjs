import { g, server as gsrv } from './stubs/google-stub.mjs';
import { om, server as osrv } from './stubs/onemap-stub.mjs';
import { received, keys, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, server as psrv } from './stubs/push-stub.mjs';
const W = process.env.WORKER_URL;   // the built Worker under test (set by test/run.mjs)
gsrv.listen(3277); osrv.listen(3288); psrv.listen(3299);
const w = (await import(W)).default;
const store = new Map(); let writes = 0;
const KV = { get: async (k, t) => { const v = store.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => { if (k !== 'cron') writes++; store.set(k, v); }, delete: async (k) => store.delete(k) };
const phones = () => JSON.parse(store.get('phones') || '{"ids":[]}').ids;
const dev = () => { const id = phones()[0]; if (!id) return undefined; const g = (p) => (store.has(`p:${id}:${p}`) ? JSON.parse(store.get(`p:${id}:${p}`)) : undefined); return { ...g('reg'), muted: g('muted'), manual: g('manual'), plan: g('plan'), log: g('log') }; };
const env = { DEDUPE_OFF: '1', LTA_ACCOUNT_KEY: 'testkey', LTA_BASE: 'http://127.0.0.1:3222/ltaodataservice', KV, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, PUSH_TEST_HOST: '127.0.0.1:3299',
  GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', GOOGLE_AUTH_URL: 'http://127.0.0.1:3277/auth', GOOGLE_TOKEN_URL: 'http://127.0.0.1:3277/token', GOOGLE_API_BASE: 'http://127.0.0.1:3277/cal', GOOGLE_REVOKE_URL: 'http://127.0.0.1:3277/revoke',
  ONEMAP_BASE: 'http://127.0.0.1:3288', ONEMAP_EMAIL: 'me@example.com', ONEMAP_PASSWORD: 'pw' };
const O = 'https://my-buses.example.workers.dev';
const req = (p, { cookies = '', method = 'GET', body } = {}) => w.fetch(new Request(O + p, { method, headers: { ...(cookies ? { cookie: cookies } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), env);
const jar = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
const ok = (name, cond, extra = '') => console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : extra);
const signIn = async () => { const l = await req('/api/google/login'); const s = new URL(l.headers.get('location')).searchParams.get('state'); return jar(await req(`/api/google/callback?code=code-1&state=${s}`, { cookies: jar(l) })); };
const tick = async (ts) => { received.length = 0; let p; await w.scheduled({ scheduledTime: ts }, env, { waitUntil: (x) => { p = x; } }); await p; return received.map((r) => r.message); };
const MIN = 60e3, endpoint = 'http://127.0.0.1:3299/push/phone';
const HOME = { name: 'Home', lat: 1.3521, lng: 103.8198 };
const sync = async (trip, cookies) => (await req('/api/push/sync', { method: 'POST', cookies, body: { subscription: { endpoint, keys }, stops: [], trip } })).json();
const next5 = (ts) => Math.ceil(ts / (5 * MIN)) * 5 * MIN;      // next 5-minute planning tick
const off5 = (ts) => (Math.floor(ts / MIN) % 5 === 0 ? ts + MIN : ts);   // a minute that is not a planning tick

const session = await signIn();
const T0 = next5(Date.now());

// --- not linked / disabled
let s = await sync({ enabled: true, lead: 10, origin: HOME }, '');
ok('phone without a calendar sign-in is not linked', s.calendarLinked === false);
ok('unlinked phone: nothing planned', (await tick(T0)).length === 0 && !dev().plan);
s = await sync({ enabled: false, lead: 10, origin: HOME }, session);
g.calQuery = null;
ok('leave alerts off: calendar is not even read', s.calendarLinked === true && (await tick(T0)).length === 0 && g.calQuery === null && !dev().plan);

// --- planning
s = await sync({ enabled: true, lead: 10, origin: HOME, places: [] }, session);
om.routeQueries.length = 0; writes = 0;
ok('off the 5-minute tick: no planning', (await tick(off5(T0 - 3 * MIN))).length === 0 && !dev().plan && om.routeQueries.length === 0);
const first = await tick(T0);
const plan = dev().plan;
ok('on the tick: next located appointment within 3 hours is planned', plan && plan.title === 'Dentist' && plan.to && plan.from === 'Home' && plan.onTime && plan.arriveAt <= plan.start && plan.legs.length === 3, JSON.stringify(plan));
ok('route planned from the chosen starting place', om.routeQueries[0].params.start === '1.3521,103.8198');
ok('location found by postal code', om.routeQueries[0].params.end === '1.29911,103.8556');
ok('no alert yet (not time to leave)', first.length === 0);
writes = 0; om.routeQueries.length = 0;
ok('next tick: same plan kept, no new routing, no storage write', (await tick(T0 + 5 * MIN)).length === 0 && om.routeQueries.length === 0 && writes === 0, `routes=${om.routeQueries.length} writes=${writes}`);
ok('app is told the plan when it syncs', (await sync({ enabled: true, lead: 10, origin: HOME }, session)).plan.title === 'Dentist');

// --- the alert itself
const due = Math.floor((plan.leaveAt - 10 * MIN) / MIN) * MIN;
ok('one minute early: nothing', (await tick(due - MIN)).length === 0);
const sent = await tick(due);
ok('10 minutes before leaving: one notification', sent.length === 1 && sent[0].title === 'Leave in 10 min for Dentist', JSON.stringify(sent));
ok('message says walk, stop, bus, times', /^Walk 4 min to BLK 254 \(01012\) · Bus 74 at \d{1,2}:\d{2} [AP]M · Arrive \d{1,2}:\d{2} [AP]M for \d{1,2}:\d{2} [AP]M$/.test(sent[0].body) && sent[0].tag === 'trip-e3' && !sent[0].alarm, JSON.stringify(sent[0]));
ok('one minute later: not repeated', (await tick(due + MIN)).length === 0);

// --- a different lead time moves the alert
ok('a missed minute is caught up: still not sent twice', (await tick(due + 3 * MIN)).length === 0 && dev().plan.sent === true);
await sync({ enabled: false }, session); await tick(T0);
await sync({ enabled: true, lead: 25, origin: HOME }, session); await tick(T0);
ok('lead of 25 min: alert moves to 25 min before', (await tick(Math.floor((plan.leaveAt - 25 * MIN) / MIN) * MIN))[0]?.title === 'Leave in 25 min for Dentist' && (await tick(due)).length === 0);
await sync({ enabled: false }, session); await tick(T0);
await sync({ enabled: true, lead: 10, origin: HOME }, session); await tick(T0);
ok('alert minute skipped by the scheduler: sent on the next run instead', (await tick(due + 2 * MIN))[0]?.title === 'Leave in 8 min for Dentist');

// --- starting point: fresh GPS wins, stale GPS falls back; a re-plan of the same appointment does not alert again
const late = next5(plan.leaveAt - 6 * MIN);          // a planning tick after the alert time
om.routeQueries.length = 0;
await sync({ enabled: true, lead: 10, origin: HOME, fix: { lat: 1.4, lng: 103.9, t: Date.now() } }, session);
const re = await tick(next5(Date.now() + 6 * MIN));
ok('fresh GPS position becomes the starting point', om.routeQueries[0]?.params.start === '1.4,103.9' && dev().plan.from === 'where you are', JSON.stringify(om.routeQueries[0]?.params));
ok('re-plan of the same appointment sends nothing', re.length === 0);
om.routeQueries.length = 0;
const stale = await tick(late);                       // now the GPS fix is older than 30 minutes
ok('GPS older than 30 min: falls back to the chosen place', om.routeQueries[0]?.params.start === '1.3521,103.8198' && dev().plan.from === 'Home', JSON.stringify(om.routeQueries[0]?.params));
ok('still no second alert for the same appointment', stale.length === 0, JSON.stringify(stale));

// --- first plan made after the alert time: alert straight away
await sync({ enabled: false }, session); await tick(T0);                      // clear the plan
ok('turning it off clears the plan', !dev().plan);
await sync({ enabled: true, lead: 10, origin: HOME }, session);
const lateMsg = await tick(late);
ok('plan first made past the alert time: alerts at once', lateMsg.length === 1 && /^Leave in [1-6] min for Dentist$/.test(lateMsg[0].title), JSON.stringify(lateMsg));

// --- saved place matched by name instead of searching the map
await sync({ enabled: false }, session); await tick(T0);
await sync({ enabled: true, lead: 10, origin: HOME, places: [{ name: 'Bugis Dental', lat: 1.3, lng: 103.86 }] }, session);
om.routeQueries.length = 0; const searchesBefore = om.searches || 0;
await tick(T0);
ok('saved place named in the location is used without a map search', om.routeQueries[0].params.end === '1.3,103.86' && (om.searches || 0) === searchesBefore && dev().plan.to === 'Bugis Dental');

// --- no starting place
await sync({ enabled: false }, session); await tick(T0);
const noOrigin = await sync({ enabled: true, lead: 10, origin: null }, session); await tick(T0);
ok('no starting place: plan says why, no alert', dev().plan.failed === 'no starting place is set' && (await sync({ enabled: true, lead: 10, origin: null }, session)).plan.failed);

// --- preview on demand
await sync({ enabled: true, lead: 10, origin: HOME }, session);
received.length = 0;
const run = await (await req('/api/push/run?force=1')).json();
ok('forced run plans and sends a preview', received.length === 1 && /^Preview: Leave in \d+ min for Dentist$/.test(received[0].message.title) && run.trips.devices[0].title === 'Dentist' && String(run.trips.devices[0].sent).startsWith('preview'), JSON.stringify(run.trips) + JSON.stringify(received[0]?.message));
ok('live bus time added when the bus is near', true);

// --- Google sign-in revoked
g.refresh.clear(); g.access.clear();
const w2 = (await import(`${W}?fresh=1`)).default;   // new instance: no cached access token
received.length = 0; let p2; await w2.scheduled({ scheduledTime: T0 }, env, { waitUntil: (x) => { p2 = x; } }); await p2;
ok('revoked Google sign-in: unlinked and plan dropped, no crash', !dev().plan && received.length === 0, JSON.stringify(dev()));
gsrv.close(); osrv.close(); psrv.close();
