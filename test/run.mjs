// Runs every test suite against a freshly built Worker. No dependencies: `npm test`.
// Each suite talks to stand-in servers (test/stubs) for LTA, OneMap, Google and the push service, so no real keys are needed.
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const out = path.join(root, '.tmp', 'worker.test.js');
mkdirSync(path.dirname(out), { recursive: true });

const build = spawnSync(process.execPath, [path.join(root, 'build-worker.mjs')], { env: { ...process.env, STOPS_FILE: path.join(here, 'fixtures', 'stops.json'), OUT_FILE: out }, encoding: 'utf8' });
if (build.status !== 0) { console.error(build.stdout + build.stderr); console.error('Build failed.'); process.exit(1); }
const check = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' });
if (check.status !== 0) { console.error(check.stderr); console.error('The built Worker has a syntax error.'); process.exit(1); }

const lta = spawn(process.execPath, [path.join(here, 'stubs', 'lta-stub.mjs')], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));

const only = process.argv[2];
const suites = readdirSync(here).filter((f) => f.endsWith('.test.mjs') && (!only || f.includes(only))).sort();
let passed = 0, failed = 0;
for (const suite of suites) {
  const r = spawnSync(process.execPath, [path.join(here, suite)], { env: { ...process.env, WORKER_URL: pathToFileURL(out).href }, encoding: 'utf8', timeout: 180_000 });
  const lines = (r.stdout || '').split('\n');
  const p = lines.filter((l) => l.startsWith('PASS')).length, f = lines.filter((l) => l.startsWith('FAIL'));
  const crashed = r.status !== 0 || p === 0;
  passed += p; failed += f.length + (crashed ? 1 : 0);
  console.log(`${f.length || crashed ? '✗' : '✓'} ${suite.replace('.test.mjs', '')}: ${p} passed${f.length ? `, ${f.length} failed` : ''}${crashed ? ' (suite did not finish cleanly)' : ''}`);
  for (const l of f) console.log(`    ${l}`);
  if (crashed) console.log((r.stderr || '').split('\n').filter(Boolean).slice(0, 12).map((l) => `    ${l}`).join('\n'));
}
lta.kill();
console.log(`\n${passed} checks passed, ${failed} failed, across ${suites.length} suites.`);
process.exit(failed || !suites.length ? 1 : 0);
