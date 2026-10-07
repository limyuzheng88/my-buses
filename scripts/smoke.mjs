// Post-deploy check: is the live app serving the build we just deployed, with everything configured?
//   node scripts/smoke.mjs https://my-buses.example.workers.dev [expected-commit]
const [base, sha] = process.argv.slice(2);
if (!base) { console.error('usage: node scripts/smoke.mjs <app url> [expected commit]'); process.exit(1); }
const want = (sha || '').slice(0, 7);
let last = '';
for (let attempt = 1; attempt <= 10; attempt += 1) {
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/status?t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
    const s = await res.json();
    const problems = [];
    if (want && !String(s.build).includes(`(${want})`)) problems.push(`build is "${s.build}", expected commit ${want}`);
    for (const k of ['keySet', 'push', 'trips', 'calendar']) if (s[k] !== true) problems.push(`${k} is ${s[k]} (a secret or binding is missing on the Worker)`);
    if (!(s.stops > 1000)) problems.push(`only ${s.stops} stops in the build`);
    if (!problems.length) {
      const page = await fetch(base);
      if (!page.ok || !(await page.text()).includes('Bus arrival notifier')) problems.push('the home page did not load');
    }
    if (!problems.length) {
      console.log(`OK: ${base} is serving build ${s.build}`);
      console.log(`    schedule: ${s.scheduler && s.scheduler.lastRun ? `last recorded run ${s.scheduler.lastRun}, ${s.scheduler.minutesAgo} min ago` : 'no run recorded yet (recorded every 10 minutes)'}`);
      process.exit(0);
    }
    last = problems.join('; ');
  } catch (e) { last = String(e.message || e); }
  console.log(`attempt ${attempt}: ${last}`);
  await new Promise((r) => setTimeout(r, 6000));   // a new deploy can take a few seconds to reach every location
}
console.error(`Smoke check failed: ${last}`);
process.exit(1);
