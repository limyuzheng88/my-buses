import { g, server as gsrv } from './stubs/google-stub.mjs';
import { om, server as osrv } from './stubs/onemap-stub.mjs';
const W = process.env.WORKER_URL;   // the built Worker under test (set by test/run.mjs)
gsrv.listen(3277); osrv.listen(3288);
const w = (await import(W)).default;
const store = new Map();
const KV = { get: async (k, t) => { const v = store.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => store.set(k, v), delete: async (k) => store.delete(k) };
const env = { LTA_ACCOUNT_KEY: 'k', KV, GOOGLE_CLIENT_ID: ' cid ', GOOGLE_CLIENT_SECRET: 'csecret', GOOGLE_AUTH_URL: 'http://127.0.0.1:3277/auth', GOOGLE_TOKEN_URL: 'http://127.0.0.1:3277/token', GOOGLE_API_BASE: 'http://127.0.0.1:3277/cal', GOOGLE_REVOKE_URL: 'http://127.0.0.1:3277/revoke',
  ONEMAP_BASE: 'http://127.0.0.1:3288', ONEMAP_EMAIL: 'me@example.com', ONEMAP_PASSWORD: 'pw' };
const O = 'https://my-buses.example.workers.dev';
const req = async (p, { cookies = '', method = 'GET', e = env } = {}) => w.fetch(new Request(O + p, { method, headers: cookies ? { cookie: cookies } : {}, redirect: 'manual' }), e);
const setCookies = (r) => (r.headers.getSetCookie ? r.headers.getSetCookie() : []);
const jar = (list) => list.map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
const ok = (name, cond, extra = '') => console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : extra);

ok('status says calendar is ready', (await (await req('/api/status')).json()).calendar === true);
ok('calendar off without the secrets', (await req('/api/calendar/next', { e: { ...env, GOOGLE_CLIENT_SECRET: undefined } })).status === 404);
ok('not signed in to start with', (await (await req('/api/calendar/next')).json()).signedIn === false);

const login = await req('/api/google/login');
const loc = new URL(login.headers.get('location'));
const c1 = setCookies(login);
ok('login redirects to Google with read-only scope and offline access', login.status === 302 && loc.searchParams.get('scope') === 'https://www.googleapis.com/auth/calendar.events.readonly' && loc.searchParams.get('access_type') === 'offline' && loc.searchParams.get('client_id') === 'cid' && loc.searchParams.get('redirect_uri') === `${O}/api/google/callback`, loc.href);
ok('state cookie is HttpOnly, Secure, short-lived', /mb_oauth=.+; Path=\/api\/google; Max-Age=600; HttpOnly; Secure; SameSite=Lax/.test(c1[0]), c1[0]);
const state = loc.searchParams.get('state');

const forged = await req(`/api/google/callback?code=code-1&state=${state}`, { cookies: 'mb_oauth=somethingelse' });
ok('callback refused when the state does not match this browser', forged.headers.get('location') === '/?calendar=failed' && ![...store.keys()].some((k) => k.startsWith('gs:')));
ok('callback with Google error goes back as denied', (await req('/api/google/callback?error=access_denied', { cookies: jar(c1) })).headers.get('location') === '/?calendar=denied');

const cb = await req(`/api/google/callback?code=code-1&state=${state}`, { cookies: jar(c1) });
const c2 = setCookies(cb); const session = jar(c2);
ok('callback signs in and sets a year-long session cookie', cb.headers.get('location') === '/?calendar=connected' && /mb_session=.+; Path=\/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax/.test(c2.find((c) => c.startsWith('mb_session'))), JSON.stringify(c2));
const keys = [...store.keys()].filter((k) => k.startsWith('gs:'));
ok('refresh token stored under a hash, not the cookie value', keys.length === 1 && !store.get(keys[0]).includes(session.split('=')[1]) && !keys[0].includes(session.split('=')[1]) && JSON.parse(store.get(keys[0])).refresh === 'rt-1');

const n1 = await (await req('/api/calendar/next', { cookies: session })).json();
ok('upcoming events: skips started, all-day and cancelled', n1.signedIn && n1.events.map((e) => e.id).join() === 'e3,e4,e5', JSON.stringify(n1.events.map((e) => e.id)));
ok('event details tidy', n1.events[0].title === 'Dentist' && n1.events[0].location.startsWith('Bugis Dental') && n1.events[0].start > Date.now() && n1.events[1].location === '' && n1.events[2].title === '(no title)');
ok('asks Google only for the next 7 days, in order', g.calQuery.singleEvents === 'true' && g.calQuery.orderBy === 'startTime' && Date.parse(g.calQuery.timeMax) - Date.parse(g.calQuery.timeMin) === 7 * 864e5);
await req('/api/calendar/next', { cookies: session });
ok('access token reused between requests', g.refreshes === 1, `refreshes=${g.refreshes}`);
ok('another browser (no cookie) sees nothing', (await (await req('/api/calendar/next')).json()).signedIn === false && (await (await req('/api/calendar/next', { cookies: 'mb_session=guess' })).json()).signedIn === false);

g.access.clear();
ok('expired access token: refreshed and retried', (await (await req('/api/calendar/next', { cookies: session })).json()).events.length === 3 && g.refreshes === 2, `refreshes=${g.refreshes}`);

// location lookup for the event
const geo = await (await req(`/api/geocode?q=${encodeURIComponent(n1.events[0].location)}`)).json();
ok('event location found via its postal code first', geo.place && geo.matched === '188024', JSON.stringify(geo));
const geo2 = await (await req('/api/geocode?q=Bugis%20Junction')).json();
ok('plain place name looked up as is', geo2.place && geo2.matched === 'Bugis Junction');

// Google revokes the sign-in (e.g. Testing-mode 7-day expiry)
g.refresh.clear(); g.access.clear();
const exp = await (await req('/api/calendar/next', { cookies: session })).json();
ok('revoked sign-in: reported as expired and forgotten', exp.signedIn === false && exp.reason === 'expired' && ![...store.keys()].some((k) => k.startsWith('gs:')), JSON.stringify(exp));

// sign in again, then disconnect
const l2 = await req('/api/google/login'); const s2 = new URL(l2.headers.get('location')).searchParams.get('state');
const cb2 = await req(`/api/google/callback?code=code-1&state=${s2}`, { cookies: jar(setCookies(l2)) }); const sess2 = jar(setCookies(cb2));
const out = await req('/api/google/logout', { method: 'POST', cookies: sess2 });
ok('disconnect revokes at Google, deletes the stored token, clears the cookie', out.status === 200 && g.revoked.includes('rt-2') && ![...store.keys()].some((k) => k.startsWith('gs:')) && /mb_session=; .*Max-Age=0/.test(setCookies(out)[0]), JSON.stringify([g.revoked, setCookies(out)]));
ok('after disconnect the old cookie no longer works', (await (await req('/api/calendar/next', { cookies: sess2 })).json()).signedIn === false);
const bad = await req(`/api/google/callback?code=wrong&state=x`, { cookies: 'mb_oauth=x' });
ok('failed code exchange returns to the app with the reason', bad.status === 302 && bad.headers.get('location').startsWith('/?calendar=failed&why=Google%20400'), bad.headers.get('location'));
gsrv.close(); osrv.close();
