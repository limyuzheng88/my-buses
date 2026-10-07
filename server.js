// Bus Arrival App – server. Zero dependencies (Node 22+).
// Proxies LTA DataMall so the AccountKey never reaches the browser.
// With no LTA_ACCOUNT_KEY set it runs in MOCK mode with fake but realistic data.

import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const STOPS_FILE = path.join(DATA_DIR, 'stops.json');

// Load secrets from a local .env file (KEY=value per line). Real environment variables win.
try {
  const env = await readFile(path.join(__dirname, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {} // no .env file is fine

const PORT = Number(process.env.PORT || 3000);
const KEY = process.env.LTA_ACCOUNT_KEY || '';
const MOCK = !KEY;
const LTA = process.env.LTA_BASE || 'https://datamall2.mytransport.sg/ltaodataservice';
const CACHE_MS = 20_000;

// ---------- LTA helpers ----------
async function lta(pathAndQuery) {
  let res;
  try {
    res = await fetch(`${LTA}/${pathAndQuery}`, {
      headers: { AccountKey: KEY, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // Node hides the real reason in e.cause; surface it so problems can be diagnosed.
    const c = e.cause || e;
    throw new Error(`network error reaching LTA: ${c.code || e.name || ''} ${c.message || e.message}`.trim());
  }
  if (!res.ok) throw new Error(`LTA ${res.status} for ${pathAndQuery}`);
  return res.json();
}

function minutesUntil(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((t - now) / 60_000));
}

const LOAD = { SEA: 'seats', SDA: 'standing', LSD: 'limited' };
const TYPE = { SD: 'single', DD: 'double', BD: 'bendy' };

function normalizeArrival(raw) {
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
  return { stop: raw.BusStopCode, fetchedAt: new Date().toISOString(), services };
}

// ---------- Mock data (used when no key is set) ----------
const MOCK_STOPS = [
  { code: '83139', name: 'Bugis Stn (mock)', road: 'Victoria St', lat: 1.3001, lng: 103.8556 },
  { code: '01012', name: 'Hotel Grand Pacific (mock)', road: 'Victoria St', lat: 1.2966, lng: 103.8528 },
  { code: '08138', name: 'Orchard Stn (mock)', road: 'Orchard Rd', lat: 1.3044, lng: 103.8318 },
];

function mockArrival(stop) {
  // Each service runs a bus every `period` minutes; ETAs shrink in real time and
  // roll over to the next bus, so countdowns and leave-now alerts can be tried.
  const now = Date.now();
  const loads = ['SEA', 'SDA', 'LSD'];
  const mk = (svc, period, offset, seed) => {
    const p = period * 60_000;
    const first = p - ((now + offset * 60_000) % p);
    const bus = (i) => ({
      EstimatedArrival: new Date(now + first + i * p).toISOString(),
      Load: loads[(seed + i) % 3], Type: i === 2 ? 'DD' : 'SD', Feature: 'WAB',
    });
    return { ServiceNo: svc, Operator: 'MOCK', NextBus: bus(0), NextBus2: bus(1), NextBus3: bus(2) };
  };
  const services = stop === '01012'
    ? [mk('74', 12, 0, 0), mk('151', 9, 4, 1)]
    : [mk('7', 8, 1, 1), mk('36', 11, 5, 0), mk('190', 15, 9, 2)];
  return { BusStopCode: stop, Services: services };
}

// ---------- Arrivals with cache ----------
const arrivalCache = new Map(); // stop -> { at, data }

async function getArrivals(stop) {
  const hit = arrivalCache.get(stop);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const raw = MOCK ? mockArrival(stop) : await lta(`v3/BusArrival?BusStopCode=${encodeURIComponent(stop)}`).catch(() => lta(`BusArrivalv2?BusStopCode=${encodeURIComponent(stop)}`));
  const data = { ...normalizeArrival(raw), mock: MOCK };
  arrivalCache.set(stop, { at: Date.now(), data });
  return data;
}

// ---------- Stops list (downloaded once, cached on disk) ----------
let stops = [];

async function loadStops() {
  if (MOCK) { stops = MOCK_STOPS; return; }
  await mkdir(DATA_DIR, { recursive: true });
  if (existsSync(STOPS_FILE)) {
    const cached = JSON.parse(await readFile(STOPS_FILE, 'utf8'));
    if (Date.now() - cached.at < 7 * 24 * 3600_000) { stops = cached.stops; return; }
  }
  const all = [];
  for (let skip = 0; ; skip += 500) {
    const page = await lta(`BusStops?$skip=${skip}`);
    if (!page.value?.length) break;
    all.push(...page.value.map((s) => ({ code: s.BusStopCode, name: s.Description, road: s.RoadName, lat: s.Latitude, lng: s.Longitude })));
    if (page.value.length < 500) break;
  }
  stops = all;
  await writeFile(STOPS_FILE, JSON.stringify({ at: Date.now(), stops }));
}

function searchStops(q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  return stops
    .filter((x) => x.code.startsWith(s) || x.name.toLowerCase().includes(s) || (x.road || '').toLowerCase().includes(s))
    .sort((a, b) => Number(b.code.startsWith(s)) - Number(a.code.startsWith(s)) || a.name.localeCompare(b.name))
    .slice(0, 15);
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/arrivals') {
      const stop = url.searchParams.get('stop') || '';
      if (!/^\d{5}$/.test(stop)) return json(res, 400, { error: 'stop must be a 5-digit bus stop code' });
      return json(res, 200, await getArrivals(stop));
    }
    if (url.pathname === '/api/stops') return json(res, 200, { stops: searchStops(url.searchParams.get('q') || '') });
    if (url.pathname === '/api/status') return json(res, 200, { mock: MOCK, stops: stops.length });

    // static files
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const full = path.normalize(path.join(PUBLIC_DIR, file));
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    const body = await readFile(full);
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    if (err.code === 'ENOENT') { res.writeHead(404); return res.end('Not found'); }
    console.error(err.message);
    json(res, 502, { error: 'Could not reach LTA right now', detail: err.message });
  }
});

await loadStops().catch((e) => console.error('Stops load failed:', e.message));
server.listen(PORT, () => {
  console.log(`Bus app on http://localhost:${PORT}  (${MOCK ? 'MOCK data – set LTA_ACCOUNT_KEY for live' : 'LIVE LTA data'}; ${stops.length} stops)`);
});
