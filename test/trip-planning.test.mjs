import { om, server } from './stubs/onemap-stub.mjs';
const W = process.env.WORKER_URL;   // the built Worker under test (set by test/run.mjs)
server.listen(3288);
const load = async (v) => (await import(`${W}?v=${v}`)).default;
const store = new Map();
const KV = { get: async (k, t) => { const v = store.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => store.set(k, v) };
const env = { LTA_ACCOUNT_KEY: 'testkey', LTA_BASE: 'http://127.0.0.1:3222/ltaodataservice', ONEMAP_BASE: 'http://127.0.0.1:3288', ONEMAP_EMAIL: ' me@example.com ', ONEMAP_PASSWORD: 'pw', KV };
const mk = (w) => async (p, e = env) => { const r = await w.fetch(new Request('https://x.test' + p), e); return [r.status, await r.json().catch(() => null)]; };
const ok = (name, cond, extra = '') => console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : extra);
const A = '1.3521,103.8198', B = '1.29911,103.8556';

let get = mk(await load(1));
ok('status says trips are ready', (await get('/api/status'))[1].trips === true);
ok('trips off without the secrets', (await get('/api/places?q=bugis', { ...env, ONEMAP_EMAIL: undefined }))[0] === 404);
const p = await get('/api/places?q=bugis');
ok('place search tidies results', p[0] === 200 && p[1].places[0].name === 'BUGIS JUNCTION' && p[1].places[1].name === '230 VICTORIA STREET' && p[1].places[0].lat === 1.29911, JSON.stringify(p[1]));
await get('/api/places?q=bugis');
ok('one sign-in reused across requests', om.issued === 1, `issued=${om.issued}`);
ok('token saved to storage with its expiry', JSON.parse(store.get('onemap')).exp > Date.now() + 71 * 3600e3);

const dep = Date.now() + 5 * 60e3;
om.routeQueries.length = 0;
const r = await get(`/api/route?from=${A}&to=${B}&depart=${encodeURIComponent(new Date(dep).toISOString())}&debug=1`);
const o = r[1].options;
ok('date and time sent to OneMap in Singapore time', Math.abs(om.routeQueries[0].dep - dep) < 1000 && om.routeQueries[0].params.routeType === 'pt', JSON.stringify(om.routeQueries[0]));
ok('leave-now options ordered by arrival', o.length === 3 && o[0].arriveAt < o[1].arriveAt && o[1].arriveAt < o[2].arriveAt);
ok('itinerary tidied', o[0].minutes === 27 && o[0].walkMinutes === 7 && o[0].fare === '1.19' && o[0].legs.length === 3 && o[0].legs[0].mode === 'walk' && o[0].legs[0].minutes === 4, JSON.stringify(o[0]));
ok('bus leg has service, stop code and stop count', o[0].legs[1].mode === 'bus' && o[0].legs[1].route === '74' && o[0].legs[1].from.code === '01012' && o[0].legs[1].stops === 9 && o[0].legs[1].to.code === '01113', JSON.stringify(o[0].legs[1]));
ok('debug shows OneMap raw format', r[1].rawFirst && r[1].rawFirst.legs.length === 3);

// leave now: the walk gets you to the stop ~6 min from now; the live 4.5-min bus is too early only if before reach-3min
const now = await get(`/api/route?from=${A}&to=${B}`);
ok('live LTA estimate attached to the first bus', now[1].options[0].live && now[1].options[0].live.service === '74' && now[1].options[0].live.stop === '01012' && now[1].options[0].live.eta > Date.now(), JSON.stringify(now[1].options[0].live));

om.routeQueries.length = 0;
const arrive = Date.now() + 3 * 3600e3;
const ar = await get(`/api/route?from=${A}&to=${B}&arrive=${encodeURIComponent(new Date(arrive).toISOString())}`);
const ao = ar[1].options;
ok('arrive-by: every option gets there in time', ar[1].onTime && ao.length >= 1 && ao.every((x) => x.arriveAt <= arrive), JSON.stringify(ao.map((x) => (x.arriveAt - arrive) / 60e3)));
ok('arrive-by: first option leaves as late as possible', ao[0].leaveAt >= Math.max(...ao.map((x) => x.leaveAt)) && arrive - ao[0].arriveAt < 10 * 60e3, `slack ${(arrive - ao[0].arriveAt) / 60e3} min`);
ok('arrive-by: far-off trip has no live estimate', ao[0].live == null);
ok('arrive-by uses few OneMap calls', om.routeQueries.length <= 4, `calls=${om.routeQueries.length}`);
ok('bad coordinates refused', (await get('/api/route?from=abc&to=1,2'))[0] === 400);

// token revoked by OneMap -> signs in again without help
om.valid.clear();
ok('revoked token: signs in again and succeeds', (await get('/api/places?q=bugis'))[0] === 200 && om.issued === 2, `issued=${om.issued}`);

// OneMap wanting the bare token instead of "Bearer"
om.bearer = false;
ok('other Authorization format handled', (await get('/api/places?q=bugis'))[0] === 200 && om.issued === 2, `issued=${om.issued}`);
om.bearer = true;

// a fresh Worker instance picks the token up from storage instead of signing in
get = mk(await load(2));
ok('new instance reuses the stored token', (await get('/api/places?q=bugis'))[0] === 200 && om.issued === 2, `issued=${om.issued}`);

// stored token about to expire -> renewed
store.set('onemap', JSON.stringify({ token: 'tok-2', exp: Date.now() + 20 * 60e3 }));
get = mk(await load(3));
ok('token near expiry is renewed', (await get('/api/places?q=bugis'))[0] === 200 && om.issued === 3, `issued=${om.issued}`);

get = mk(await load(4)); store.clear();
const bad = await get('/api/places?q=bugis', { ...env, ONEMAP_PASSWORD: 'wrong' });
ok('wrong password gives a clear message', bad[0] === 502 && /Check the ONEMAP_EMAIL and ONEMAP_PASSWORD/.test(bad[1].detail), JSON.stringify(bad[1]));
ok('bus arrivals still work', (await get('/api/arrivals?stop=01012'))[0] === 200);
server.close();
