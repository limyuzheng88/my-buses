# My Buses

A phone-friendly web app for Singapore bus commuters, running free on Cloudflare Workers.

- **Bus arrival notifier.** Live arrival times for bookmarked stops (LTA DataMall), with notifications at the days and times you choose.
- **Trip departure notifier.** Plans a public transport route (OneMap) and notifies you before you need to leave, for routes you plan and for Google Calendar appointments.

## How it is put together

| Path | What it is |
| --- | --- |
| `public/` | The app itself: page, styles, script, service worker |
| `worker.template.js` | The server: API, notifications, the every-minute job |
| `build-worker.mjs` | Packs `public/` and the stop list into one file, `dist/worker.js` |
| `stops/stops.json` | Snapshot of every bus stop (refresh with `npm run stops`) |
| `wrangler.toml` | Deploy settings: storage binding, schedule, logging |
| `test/` | Test suites and stand-in servers for LTA, OneMap, Google and push |
| `.github/workflows/` | The pipeline: `ci.yml` tests every change, `deploy.yml` ships `main` |
| `server.js` | Optional local server for the bus-times part only |

No dependencies to install. Needs Node 22 or newer.

```
npm test          # run every test suite (about a minute)
npm run build     # produce dist/worker.js
npm run stops     # refresh the stop snapshot from LTA (needs LTA_ACCOUNT_KEY in .env)
npm start         # local server for bus times only (needs LTA_ACCOUNT_KEY in .env)
```

## Working on it: the routine

`main` is always what is live. Nothing reaches `main` except through a pull request that passed its tests.

1. **Start from fresh `main`.** `git switch main && git pull`
2. **Make a branch** named for the change. `git switch -c fix/stop-search-typo`
3. **Change code, and a test with it.** If you fix a bug, first add a check to a suite in `test/` that fails because of the bug.
4. **Run `npm test`** until it passes.
5. **Commit and push.** `git push -u origin fix/stop-search-typo`
6. **Open a pull request** on GitHub. CI runs the tests and the build. Read your own diff there before merging.
7. **Merge** when CI is green. The Deploy workflow tests again, deploys to Cloudflare, and checks the live app is serving that commit.
8. **Confirm** at `/api/status`: the `build` value ends with the commit id, for example `(a1b2c3d)`.

Rules that keep this honest:

- **Do not edit code or settings in the Cloudflare dashboard.** The next deploy overwrites them. Change `wrangler.toml` or the code, in a pull request.
- **Secrets never go in the repository.** They live on the Worker in Cloudflare. `.env` is for local use only and is ignored by git.
- **Small pull requests.** One change each; easier to review, easier to undo.
- **A red pipeline is the first thing to fix.** Do not merge over it.

## Undoing a bad deploy

- **Fastest:** in Cloudflare, open the Worker, Deployments, and roll back to the previous version. Then fix `main` so the next deploy does not bring the problem back.
- **Proper:** `git revert <commit>` on a branch, pull request, merge. The pipeline deploys the reverted code.

## Working from another device

Clone the repository, install Node 22, and you have everything: `git clone`, `npm test`. For local bus times, create `.env` from `.env.example`. You do not need Cloudflare access on that device; pushing a branch and merging a pull request is enough to deploy.

## Setup and history

- `SETUP-CICD.md`: one-time steps to connect GitHub to Cloudflare.
- `DEPLOY.md`: how each Cloudflare and Google piece was originally set up.
