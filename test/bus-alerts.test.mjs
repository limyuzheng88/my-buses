import http from 'node:http';
import nodeCrypto from 'node:crypto';
// Some checks below use an all-day alert time (00:00 to 23:59), which is not running during the last minute of the Singapore day.
// If the suite starts within 90 seconds of midnight there, wait for midnight so the result never depends on when it runs.
{ const untilMidnight = 864e5 - ((Date.now() + 8 * 3600e3) % 864e5); if (untilMidnight < 90e3) await new Promise((r) => setTimeout(r, untilMidnight + 1000)); }
const W = process.env.WORKER_URL;   // the built Worker under test (set by test/run.mjs)
const w = (await import(W)).default;
const b64u = (b) => Buffer.from(b).toString('base64url');

// --- VAPID keys, as generate-vapid.mjs makes them
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const VAPID_PUBLIC_KEY = b64u(await crypto.subtle.exportKey('raw', pair.publicKey));
const VAPID_PRIVATE_KEY = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;

// --- a pretend phone: its own key pair and auth secret
const ua = nodeCrypto.createECDH('prime256v1'); ua.generateKeys();
const auth = nodeCrypto.randomBytes(16);
const keys = { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) };

// --- a pretend push service: checks the VAPID signature and decrypts the way a browser would (RFC 8291), using node:crypto
const received = []; let respond = 201;
const srv = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const body = Buffer.concat(chunks); const out = { path: req.url, ttl: req.headers.ttl };
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(req.headers.authorization || '');
    if (m) {
      const [hd, pl, sg] = m[1].split('.');
      const pub = nodeCrypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(Buffer.from(m[2], 'base64url').subarray(1, 33)), y: b64u(Buffer.from(m[2], 'base64url').subarray(33)) }, format: 'jwk' });
      out.jwtValid = nodeCrypto.verify('sha256', Buffer.from(`${hd}.${pl}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sg, 'base64url'));
      out.claims = JSON.parse(Buffer.from(pl, 'base64url')); out.keyMatches = m[2] === VAPID_PUBLIC_KEY;
    }
    if (body.length) {
      out.encoding = req.headers['content-encoding'];
      const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
      const shared = ua.computeSecret(asPub);
      const ikm = Buffer.from(nodeCrypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
      const cek = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const d = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      out.rs = rs; out.delimiter = plain[plain.length - 1]; out.message = JSON.parse(plain.subarray(0, plain.length - 1).toString());
    } else out.message = null;
    received.push(out); res.writeHead(respond); res.end();
  });
}).listen(3299);

const store = new Map(); let writes = 0, reads = 0;
const KV = { get: async (k, t) => { reads++; const v = store.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => { writes++; store.set(k, v); }, delete: async (k) => store.delete(k) };
const phones = () => JSON.parse(store.get('phones') || '{"ids":[]}').ids;
const dev = () => { const id = phones()[0]; if (!id) return undefined; const g = (p) => (store.has(`p:${id}:${p}`) ? JSON.parse(store.get(`p:${id}:${p}`)) : undefined); return { ...g('reg'), muted: g('muted'), manual: g('manual'), plan: g('plan'), log: g('log') }; };
const env = { LTA_ACCOUNT_KEY: 'testkey', LTA_BASE: 'http://127.0.0.1:3222/ltaodataservice', KV, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, PUSH_TEST_HOST: '127.0.0.1:3299' };
const call = async (p, init, e = env) => { const r = await w.fetch(new Request('https://my-buses.example.workers.dev' + p, init), e); return [r.status, await r.json().catch(() => null)]; };
const post = (p, body, e) => call(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, e);
const endpoint = 'http://127.0.0.1:3299/push/abc';
const allDays = [0, 1, 2, 3, 4, 5, 6];
const ok = (name, cond, extra = '') => console.log(cond ? 'PASS' : 'FAIL', name, extra);

ok('status reports push ready', (await call('/api/status'))[1].push === true);
ok('push off without KV -> 404', (await call('/api/push/key', undefined, { ...env, KV: undefined }))[0] === 404);
ok('key endpoint', (await call('/api/push/key'))[1].key === VAPID_PUBLIC_KEY);
ok('rejects non-push host', (await post('/api/push/sync', { subscription: { endpoint: 'https://evil.example/x', keys }, stops: [] }))[0] === 400);
ok('rejects missing keys', (await post('/api/push/sync', { subscription: { endpoint }, stops: [] }))[0] === 400);
ok('real FCM host allowed by rule', (await post('/api/push/sync', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys }, stops: [] }, { ...env, KV: { get: async () => null, put: async () => {} } }))[0] === 200);


const sg = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 8, mi);   // a Singapore wall-clock time
const tick = async (ts) => { received.length = 0; let p; await w.scheduled({ scheduledTime: ts }, env, { waitUntil: (x) => { p = x; } }); await p; return received.length; };
const sync = (stops) => post('/api/push/sync', { subscription: { endpoint, keys }, stops });
const stop = (alarms, extra = {}) => ({ code: '01012', name: 'Hotel Grand Pacific', followed: ['74'], threshold: 10, alarms, ...extra });

const t = await (async () => { await sync([]); return post('/api/push/test', { endpoint }); })();
ok('test sends ping + message', t[1].ping === 201 && t[1].message === 201 && received[1].message?.title === 'Test alert', JSON.stringify(t[1]));
ok('VAPID valid', received[0].jwtValid && received[0].keyMatches && received[1].encoding === 'aes128gcm');

// --- weekday alarm: Wednesdays 07:30 to 09:00, every 5 min (7 Oct 2026 is a Wednesday)
const s1 = await sync([stop([{ id: 'wed', days: [3], dates: [], from: '07:30', to: '09:00', every: 5 }]), { code: 'bad' }, stop([{ id: 'x', days: [], dates: [], from: '07:30', to: '09:00' }], { code: '83139' })]);
ok('sync keeps only usable rules', s1[1].rules === 1, JSON.stringify(s1[1]));
ok('Wed 07:29 before start: nothing', await tick(sg(2026, 10, 7, 7, 29)) === 0);
ok('Wed 07:30 start: sends', await tick(sg(2026, 10, 7, 7, 30)) === 1);
ok('Wed 07:31 between intervals: nothing', await tick(sg(2026, 10, 7, 7, 31)) === 0);
ok('Wed 07:35 next interval: sends', await tick(sg(2026, 10, 7, 7, 35)) === 1);
ok('Wed 08:55 last interval: sends', await tick(sg(2026, 10, 7, 8, 55)) === 1);
ok('Wed 09:00 timeframe over: nothing', await tick(sg(2026, 10, 7, 9, 0)) === 0);
ok('Thu 07:30 not a ticked day: nothing', await tick(sg(2026, 10, 8, 7, 30)) === 0);

// --- specific date, running past midnight: Sat 10 Oct 22:00 to 01:00, every 10 min
await sync([stop([{ id: 'sat', days: [], dates: ['2026-10-10'], from: '22:00', to: '01:00', every: 10 }])]);
ok('Sat 22:00 on the date: sends', await tick(sg(2026, 10, 10, 22, 0)) === 1);
ok('Sun 00:50 still the same run: sends', await tick(sg(2026, 10, 11, 0, 50)) === 1);
ok('Sun 00:55 between intervals: nothing', await tick(sg(2026, 10, 11, 0, 55)) === 0);
ok('Sun 01:00 over: nothing', await tick(sg(2026, 10, 11, 1, 0)) === 0);
ok('Sun 22:00 not the date: nothing', await tick(sg(2026, 10, 11, 22, 0)) === 0);
ok('Sat 00:30 (run belongs to Fri night, not ticked): nothing', await tick(sg(2026, 10, 10, 0, 30)) === 0);

// --- several alarms on one stop, days and dates mixed; overlapping alarms give one notification
await sync([stop([
  { id: 'am', days: [1, 3, 5], dates: ['2026-10-08'], from: '07:30', to: '09:00', every: 5 },
  { id: 'am2', days: [3], dates: [], from: '07:00', to: '08:00', every: 5 },
  { id: 'pm', days: [0, 6], dates: [], from: '18:00', to: '19:00', every: 15 },
])]);
ok('Thu 8 Oct 07:30 via its date: sends', await tick(sg(2026, 10, 8, 7, 30)) === 1);
ok('Wed 07:30 two alarms overlap: one notification', await tick(sg(2026, 10, 7, 7, 30)) === 1);
ok('Sat 18:15 weekend alarm, 15-min interval: sends', await tick(sg(2026, 10, 10, 18, 15)) === 1);
ok('Sat 18:20 not on the 15-min interval: nothing', await tick(sg(2026, 10, 10, 18, 20)) === 0);
ok('Tue 07:30 no alarm: nothing', await tick(sg(2026, 10, 6, 7, 30)) === 0);

// --- content, and Stop, using an alarm that is running right now
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const yest = new Date(Date.now() + 8 * 3600e3 - 864e5).toISOString().slice(0, 10);
await sync([stop([{ id: 'now', days: [], dates: [today, yest], from: '00:00', to: '23:59', every: 2 }, { id: 'tail', days: [], dates: [today, yest], from: '23:59', to: '00:00', every: 2 }])]);
received.length = 0;
const r1 = (await call('/api/push/run?force=1'))[1];
const m = received[0]?.message;
ok('forced run sends the bus times', r1.sent === 1 && m.title === 'Leave now: Bus 74 in 4 min' && m.body === '74: 4, 13 min\nHotel Grand Pacific (01012)' && m.tag === 'stop-01012' && m.stop === '01012' && typeof m.alarm === 'string', JSON.stringify(r1) + ' ' + JSON.stringify(m));
writes = 0;
ok('sending costs no storage writes', (await call('/api/push/run?force=1'))[1].sent === 1 && writes === 0, `writes=${writes}`);
const st1 = (await post('/api/push/stop', { endpoint, code: '01012', alarm: m.alarm }))[1];
ok('Stop returns when the run ends', st1.ok && st1.until > Date.now(), JSON.stringify(st1));
received.length = 0;
const r2 = (await call('/api/push/run?force=1'))[1];
ok('after Stop: no more notifications in this run', r2.sent === 0 && received.length === 0 && r2.running >= 1, JSON.stringify(r2));
const s2 = (await sync([stop([{ id: m.alarm, days: [], dates: [today, yest], from: '00:00', to: '23:59', every: 2 }])]))[1];
ok('app learns the alarm is stopped, and Stop survives a settings sync', s2.muted[`01012|${m.alarm}`] === st1.until && (await call('/api/push/run?force=1'))[1].sent === 0, JSON.stringify(s2.muted));
ok('Stop on an alarm that is not running does nothing', (await post('/api/push/stop', { endpoint, code: '01012', alarm: 'nope' }))[1].until === null);
ok('Stop from an unknown phone is refused', (await post('/api/push/stop', { endpoint: endpoint + 'zzz', code: '01012', alarm: 'now' }))[0] === 404);

// --- older app copies (one days/from/to per stop) still work
const s3 = (await sync([{ code: '01012', name: 'Hotel Grand Pacific', followed: ['74'], threshold: 10, days: [3], from: '07:30', to: '09:00' }]))[1];
ok('old format accepted as one alarm', s3.rules === 1 && await tick(sg(2026, 10, 7, 7, 30)) === 1);

// --- interval limits and no-estimate wording
await sync([stop([{ id: 'lim', days: [0, 1, 2, 3, 4, 5, 6], dates: [], from: '00:00', to: '23:59', every: 1 }], { followed: ['74', '9', '999'], threshold: 3 })]);
ok('interval is kept between 2 and 60', dev().stops[0].alarms[0].every === 2, String(dev().stops[0].alarms[0].every));
received.length = 0; await call('/api/push/run?force=1');
ok('wording when no bus is within the leave-now minutes, and for buses with no estimate', received[0].message.title === 'Bus 74 in 4 min' && received[0].message.body.startsWith('74: 4, 13 min · 9: no estimate · 999: no estimate'), JSON.stringify(received[0].message));

respond = 410; received.length = 0; await call('/api/push/run?force=1');
ok('410 removes the device', phones().length === 0);

// --- stops on the map: only those inside the area asked for, with their position
{ const [st, r] = await call('/api/stops/area?box=1.296,103.852,1.298,103.854');
  ok('map area returns the stops inside it, with coordinates', st === 200 && r.total === 1 && r.stops[0].code === '01012' && r.stops[0].lat === 1.29685 && r.stops[0].lng === 103.85254, JSON.stringify(r));
  const [st2, r2] = await call('/api/stops/area?box=1.29,103.85,1.31,103.86');
  ok('a bigger area returns both stops', st2 === 200 && r2.total === 2, JSON.stringify(r2));
  ok('a malformed area is refused', (await call('/api/stops/area?box=north,pole'))[0] === 400 && (await call('/api/stops/area?box=1.3,103.9,1.2,103.8'))[0] === 400);
  const [, r3] = await call('/api/stops?q=bugis');
  ok('name search still works with the extra fields', r3.stops.length === 1 && r3.stops[0].code === '83139' && !('lat' in r3.stops[0]), JSON.stringify(r3)); }
srv.close();
