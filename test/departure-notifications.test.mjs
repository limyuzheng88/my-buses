import { received, keys, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, server as psrv } from './stubs/push-stub.mjs';
// Some checks below use an all-day alert time (00:00 to 23:59), which is not running during the last minute of the Singapore day.
// If the suite starts within 90 seconds of midnight there, wait for midnight so the result never depends on when it runs.
{ const untilMidnight = 864e5 - ((Date.now() + 8 * 3600e3) % 864e5); if (untilMidnight < 90e3) await new Promise((r) => setTimeout(r, untilMidnight + 1000)); }
const W = process.env.WORKER_URL;   // the built Worker under test (set by test/run.mjs)
psrv.listen(3299);
const w = (await import(W)).default;
const store = new Map(); let writes = 0;
const KV = { get: async (k, t) => { const v = store.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => { writes++; store.set(k, v); }, delete: async (k) => store.delete(k) };
const phones = () => JSON.parse(store.get('phones') || '{"ids":[]}').ids;
const dev = () => { const id = phones()[0]; if (!id) return undefined; const g = (p) => (store.has(`p:${id}:${p}`) ? JSON.parse(store.get(`p:${id}:${p}`)) : undefined); return { ...g('reg'), muted: g('muted'), manual: g('manual'), plan: g('plan'), log: g('log') }; };
const env = { DEDUPE_OFF: '1', LTA_ACCOUNT_KEY: 'testkey', LTA_BASE: 'http://127.0.0.1:3222/ltaodataservice', KV, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, PUSH_TEST_HOST: '127.0.0.1:3299' };
const post = async (p, body) => { const r = await w.fetch(new Request('https://my-buses.example.workers.dev' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env); return [r.status, await r.json().catch(() => null)]; };
const tick = async (ts) => { received.length = 0; let p; await w.scheduled({ scheduledTime: ts }, env, { waitUntil: (x) => { p = x; } }); await p; return received.map((r) => r.message); };
const ok = (name, cond, extra = '') => console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : extra);
const MIN = 60e3, endpoint = 'http://127.0.0.1:3299/push/phone';
const trip = (leaveInMin, extra = {}) => { const s = Date.now() + leaveInMin * MIN; return { title: 'BUGIS JUNCTION', leaveAt: s, arriveAt: s + 27 * MIN, arriveBy: null, onTime: true, lead: 10, legs: [
  { mode: 'walk', route: '', from: { name: 'Origin', code: null }, to: { name: 'BLK 254', code: '01012' }, start: s, minutes: 4 },
  { mode: 'bus', route: '74', from: { name: 'BLK 254', code: '01012' }, to: { name: 'BUGIS STN', code: '01113' }, start: s + 4 * MIN, minutes: 20 },
  { mode: 'walk', route: '', from: { name: 'BUGIS STN', code: null }, to: { name: 'Destination', code: null }, start: s + 24 * MIN, minutes: 3 } ], ...extra }; };
const sync = () => post('/api/push/sync', { subscription: { endpoint, keys }, stops: [] });

const statusOf = async () => (await (await w.fetch(new Request('https://my-buses.example.workers.dev/api/status'), env)).json()).scheduler;
ok('scheduler: nothing recorded before the first run', (await statusOf()).lastRun === null);
const ten = Math.ceil(Date.now() / (10 * MIN)) * 10 * MIN;
await tick(ten + 3 * MIN);
ok('scheduler: a quiet run off the 10-minute mark is not stored', (await statusOf()).lastRun === null && !store.has('cron'));
await tick(ten);
const sch = await statusOf();
ok('scheduler: run on the 10-minute mark is recorded', typeof sch.lastRun === 'string' && sch.lastSend === null && sch.lastError === null && typeof sch.healthy === 'boolean', JSON.stringify(sch));
ok('unregistered phone refused', (await post('/api/push/trip', { endpoint, trip: trip(40) }))[0] === 404);
await sync();
const t1 = trip(40);
const r1 = (await post('/api/push/trip', { endpoint, trip: t1 }))[1];
const due = Math.floor((t1.leaveAt - 10 * MIN) / MIN) * MIN;
ok('trip accepted with its alert time, nothing sent yet', r1.ok && r1.sentNow === false && r1.manual.alertAt === due && received.length === 0, JSON.stringify(r1));
ok('before the alert time: nothing', (await tick(due - MIN)).length === 0);
const m1 = await tick(due);
ok('10 min before leaving: notified', m1.length === 1 && m1[0].title === 'Leave in 10 min for BUGIS JUNCTION', JSON.stringify(m1));
ok('stays deliverable until it is time to leave (10 to 11 min), not just 5', received[0].ttl >= 600 && received[0].ttl <= 660, String(received[0].ttl));
ok('scheduler: a run that sent something is recorded straight away', JSON.parse(store.get('cron')).lastSend === due && (await statusOf()).lastSend !== null, store.get('cron'));
const rep = await (await w.fetch(new Request('https://my-buses.example.workers.dev/api/push/run'), env)).json();
ok('run report lists recent sends and who sent them', Object.values(rep.recentDepartureSends)[0][0].includes('Leave in 10 min for BUGIS JUNCTION [planned route, sent by the schedule; push service 201]') && rep.phones === 1, JSON.stringify(rep.recentDepartureSends));
ok('message has walk, stop, bus and arrival', /^Walk 4 min to BLK 254 \(01012\) · Bus 74 at \d{1,2}:\d{2} [AP]M · Arrive \d{1,2}:\d{2} [AP]M$/.test(m1[0].body) && !m1[0].alarm, m1[0]?.body);
ok('not repeated on later runs', (await tick(due + MIN)).length === 0 && (await tick(due + 5 * MIN)).length === 0);
const s1 = (await sync())[1];
ok('settings sync keeps the planned trip and reports it to the app', s1.manual && s1.manual.title === 'BUGIS JUNCTION' && s1.manual.sent === true && dev().manual);

const t2 = trip(40, { arriveBy: Date.now() + 70 * MIN });
await post('/api/push/trip', { endpoint, trip: t2 });
const m2 = await tick(Math.floor((t2.leaveAt - 10 * MIN) / MIN) * MIN + 3 * MIN);
ok('scheduler skipped the exact minute: still notified on the next run', m2.length === 1 && m2[0].title === 'Leave in 7 min for BUGIS JUNCTION', JSON.stringify(m2));
ok('arrive-by trips say what the deadline is', / · Arrive \d{1,2}:\d{2} [AP]M for \d{1,2}:\d{2} [AP]M$/.test(m2[0].body), m2[0]?.body);

received.length = 0;
const r3 = (await post('/api/push/trip', { endpoint, trip: trip(6) }))[1];
ok('less than 10 min left: notified straight away', r3.sentNow === true && received.length === 1 && /^Leave in [56] min for BUGIS JUNCTION$/.test(received[0].message.title), JSON.stringify([r3.sentNow, received[0]?.message]));
ok('live LTA time included when the bus is near', /Bus 74 at \d{1,2}:\d{2} [AP]M \(live: \d{1,2}:\d{2} [AP]M\)/.test(received[0].message.body), received[0]?.message.body);
ok('and not sent again by the scheduler', (await tick(Date.now() + MIN)).length === 0);

ok('a trip whose leave time has passed sets nothing', (await post('/api/push/trip', { endpoint, trip: trip(-1) }))[1].manual === null && !dev().manual);
const t4 = trip(40); await post('/api/push/trip', { endpoint, trip: t4 });
ok('cancel removes it', (await post('/api/push/trip', { endpoint, trip: null }))[1].manual === null && !dev().manual && (await tick(Math.floor((t4.leaveAt - 10 * MIN) / MIN) * MIN)).length === 0);
const t5 = trip(40, { lead: 25 }); await post('/api/push/trip', { endpoint, trip: t5 });
ok('custom lead time respected', (await tick(Math.floor((t5.leaveAt - 25 * MIN) / MIN) * MIN))[0]?.title === 'Leave in 25 min for BUGIS JUNCTION');
await tick(t5.leaveAt + 6 * MIN);
ok('finished trips are tidied away', !dev().manual);
const t6 = trip(40); await post('/api/push/trip', { endpoint, trip: t6 }); await post('/api/push/trip', { endpoint, trip: trip(60, { title: 'Second' }) });
ok('planning another trip replaces the first', dev().manual.title === 'Second' && (await tick(Math.floor((t6.leaveAt - 10 * MIN) / MIN) * MIN)).length === 0);
// --- the bug this fixes: a settings sync, or the every-minute job, must never undo a planned trip
const tRace = trip(40, { title: 'Race' }); await post('/api/push/trip', { endpoint, trip: tRace });
const written = []; const realPut = KV.put; KV.put = async (k, v) => { written.push(k); return realPut(k, v); };
await sync(); await tick(Date.now()); await sync();
KV.put = realPut;
// 'cron' is the scheduler's own heartbeat, written in minutes that are a multiple of 10; it holds no trip data
ok('settings sync and the scheduler write nothing but the registration entry', written.some((k) => k.endsWith(':reg')) && written.every((k) => k.endsWith(':reg') || k === 'cron'), JSON.stringify(written));
ok('planned trip survives them', dev().manual && dev().manual.title === 'Race');
// a sync working from an out-of-date copy of the data (as Cloudflare storage can briefly return) still cannot remove it
const staleGet = KV.get; KV.get = async (k, t) => (k.endsWith(':manual') ? null : staleGet(k, t));
await sync(); KV.get = staleGet;
ok('even a sync that cannot see the trip leaves it in place', dev().manual && dev().manual.title === 'Race');
ok('and it is still sent on time', (await tick(Math.floor((tRace.leaveAt - 10 * MIN) / MIN) * MIN))[0]?.title === 'Leave in 10 min for Race');
// a route planned for a calendar appointment carries the appointment id
await post('/api/push/trip', { endpoint, trip: trip(40, { eventId: 'e3', title: 'Dentist' }) });
ok('appointment id kept on the planned route', dev().manual.eventId === 'e3');
// a phone registered seconds ago, not yet readable from storage, can still set a trip using the subscription it sends
const hidden = KV.get; KV.get = async (k, t) => (k.endsWith(':reg') ? null : hidden(k, t));
const soon = (await post('/api/push/trip', { endpoint, subscription: { endpoint, keys }, trip: trip(40, { title: 'Fresh phone' }) }));
KV.get = hidden;
ok('just-registered phone can set a trip', soon[0] === 200 && dev().manual.title === 'Fresh phone', JSON.stringify(soon));
// storage briefly returning an out-of-date "not sent yet" must not cause a second buzz
env.DEDUPE_OFF = undefined;
const tDup = trip(45, { title: 'Dup' }); await post('/api/push/trip', { endpoint, trip: tDup });
const dueDup = Math.floor((tDup.leaveAt - 10 * MIN) / MIN) * MIN;
const firstSend = await tick(dueDup);
const idNow = phones()[0]; const stored = JSON.parse(store.get(`p:${idNow}:manual`)); delete stored.sent; store.set(`p:${idNow}:manual`, JSON.stringify(stored));   // pretend the "sent" mark was not visible yet
const secondSend = await tick(dueDup + MIN);
ok('out-of-date storage does not produce a second notification', firstSend.length === 1 && secondSend.length === 0 && dev().manual.sent === true, JSON.stringify([firstSend.length, secondSend.length]));
env.DEDUPE_OFF = '1';
// data saved by the previous version (one entry holding everything) is carried over on first use
const keep = new Map(store); store.clear();
store.set('state', JSON.stringify({ origin: 'https://my-buses.example.workers.dev', devices: { abc123: { endpoint, keys, stops: [{ code: '01012', name: 'Hotel Grand Pacific', followed: ['74'], threshold: 10, alarms: [{ id: 'a', days: [0, 1, 2, 3, 4, 5, 6], dates: [], from: '00:00', to: '23:59', every: 2 }] }], muted: {}, manual: trip(40, { title: 'Old trip' }) } } }));
received.length = 0; await w.fetch(new Request('https://my-buses.example.workers.dev/api/push/run?force=1'), env);
ok('old data migrated: phone, alert times and planned trip kept, old entry removed', phones().length === 1 && dev().stops.length === 1 && dev().manual.title === 'Old trip' && !store.has('state') && received.length === 1, JSON.stringify([phones(), [...store.keys()], received.length]));
store.clear(); for (const [k, v] of keep) store.set(k, v);
const lg = (await sync())[1].log;
ok('server keeps a record of departure notifications it sent', lg.length >= 4 && lg[0].kind.startsWith('planned route') && /^Leave in/.test(lg[0].title) && lg[0].status === 201 && lg[0].t <= Date.now(), JSON.stringify(lg.slice(0, 2)));
// the log covers the past week only: older entries are not shown
{ const id = phones()[0]; const old = JSON.parse(store.get(`p:${id}:log`)); store.set(`p:${id}:log`, JSON.stringify([...old, { t: Date.now() - 8 * 86_400_000, kind: 'planned route', title: 'Eight days ago', status: 201 }, { t: Date.now() - 6 * 86_400_000, kind: 'planned route', title: 'Six days ago', status: 201 }]));
  const wk = (await sync())[1].log;
  ok('log shows the past week only', wk.some((e) => e.title === 'Six days ago') && !wk.some((e) => e.title === 'Eight days ago'), JSON.stringify(wk.map((e) => e.title))); }
ok('record is capped', lg.length <= 20);
ok('turning notifications off removes this phone from the server', (await post('/api/push/unsubscribe', { endpoint }))[1].ok && phones().length === 0);
ok('after that, a trip cannot be set and nothing is sent', (await post('/api/push/trip', { endpoint, trip: trip(40) }))[0] === 404 && (await tick(Date.now() + 30 * MIN)).length === 0);
psrv.close();
