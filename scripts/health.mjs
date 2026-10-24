// Hourly health check of the live app (run by .github/workflows/health.yml, or by hand):
//   node scripts/health.mjs https://my-buses.example.workers.dev
// Checks what has silently broken before: the every-minute schedule, the LTA key, OneMap sign-in, the settings on the Worker.
// Prints one line per check and exits 1 if any failed, so the workflow can open an issue (which emails you).
const base = (process.argv[2] || '').replace(/\/$/, '');
if (!base) { console.error('usage: node scripts/health.mjs <app url>'); process.exit(1); }

const results = [];
const check = async (name, fn) => {
  try { const detail = await fn(); results.push({ ok: true, name, detail }); }
  catch (e) { results.push({ ok: false, name, detail: String(e.message || e) }); }
};
const get = async (path) => {
  const res = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};

let status = null;
await check('App answers', async () => {
  const r = await get('/api/status');
  if (r.status !== 200) throw new Error(`/api/status answered ${r.status}`);
  status = r.body;
  return `build ${status.build}`;
});
if (status) {
  await check('Settings on the Worker', async () => {
    const missing = ['keySet', 'push', 'trips', 'calendar'].filter((k) => status[k] !== true);
    if (missing.length) throw new Error(`not set up: ${missing.join(', ')} (a secret or binding is missing)`);
    return `${status.stops} stops, push, trips and calendar configured`;
  });
  await check('Every-minute schedule', async () => {
    const s = status.scheduler;
    if (!s) throw new Error('no storage binding, so the schedule cannot record its runs');
    if (s.lastRun == null) throw new Error('no run recorded: the Cron Trigger may be missing');
    if (!s.healthy) throw new Error(`last recorded run ${s.minutesAgo} min ago (should be within 12): the schedule looks stopped`);
    return `last recorded run ${s.minutesAgo} min ago${s.lastError ? ` (last error: ${s.lastError})` : ''}`;
  });
}
await check('LTA bus arrivals', async () => {
  const r = await get('/api/arrivals?stop=01012');
  if (r.status !== 200 || !Array.isArray(r.body.services)) throw new Error(`answered ${r.status}: ${r.body.error || ''} ${r.body.detail || ''}`.trim());
  return `${r.body.services.length} services at stop 01012`;
});
await check('OneMap place search', async () => {
  const r = await get('/api/places?q=bugis');
  if (r.status !== 200 || !Array.isArray(r.body.places) || !r.body.places.length) throw new Error(`answered ${r.status}: ${r.body.error || ''} ${r.body.detail || ''}`.trim());
  return `${r.body.places.length} places found`;
});
await check('Home page', async () => {
  const res = await fetch(base);
  if (!res.ok || !(await res.text()).includes('Bus arrival notifier')) throw new Error(`answered ${res.status} without the app`);
  return 'loads';
});

for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}: ${r.detail}`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed at ${new Date().toISOString()} for ${base}` : `\nAll ${results.length} checks passed at ${new Date().toISOString()}`);
process.exit(failed.length ? 1 : 0);
