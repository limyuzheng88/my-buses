// Refreshes stops/stops.json, the committed snapshot of every bus stop that gets built into the Worker.
//   npm run stops               fetch from LTA DataMall (needs LTA_ACCOUNT_KEY in the environment or in .env)
//   npm run stops -- --from-cache   convert data/stops.json, the cache the local server (server.js) already downloaded
// Commit the result. Bus stops change rarely; refresh every few months or when a stop is missing.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'stops', 'stops.json');

let stops;
if (process.argv.includes('--from-cache')) {
  const cached = JSON.parse(await readFile(path.join(root, 'data', 'stops.json'), 'utf8'));
  stops = cached.stops.map((s) => [s.code, s.name, s.road || '']);
} else {
  let key = process.env.LTA_ACCOUNT_KEY;
  if (!key) {
    try { key = ((await readFile(path.join(root, '.env'), 'utf8')).match(/^\s*LTA_ACCOUNT_KEY\s*=\s*(.*?)\s*$/m) || [])[1]; } catch {}
  }
  if (!key) { console.error('LTA_ACCOUNT_KEY is not set (environment or .env).'); process.exit(1); }
  stops = [];
  for (let skip = 0; ; skip += 500) {
    const res = await fetch(`https://datamall2.mytransport.sg/ltaodataservice/BusStops?$skip=${skip}`, { headers: { AccountKey: key.replace(/^(['"])(.*)\1$/, '$2'), accept: 'application/json' } });
    if (!res.ok) { console.error(`LTA answered ${res.status}`); process.exit(1); }
    const page = (await res.json()).value || [];
    stops.push(...page.map((s) => [s.BusStopCode, s.Description, s.RoadName || '']));
    if (page.length < 500) break;
  }
}
if (stops.length < 1000) { console.error(`Only ${stops.length} stops found; refusing to overwrite the snapshot.`); process.exit(1); }
stops.sort((a, b) => a[0].localeCompare(b[0]));
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, `[\n${stops.map((s) => JSON.stringify(s)).join(',\n')}\n]\n`);   // one stop per line, so changes read well in a diff
console.log(`stops/stops.json written: ${stops.length} stops`);
