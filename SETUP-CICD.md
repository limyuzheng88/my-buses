# One-time pipeline setup

About 20 minutes. After this, merging to `main` deploys the app.

## 1. Create the repository and place the pipeline files

1. On github.com create a new **private** repository named `my-buses`. Do not add a README or .gitignore (the project has them).
2. Put the two pipeline files where GitHub looks for them. They were delivered in a folder named `github-workflows` because the tool that copied this project to your computer is not allowed to write into `.github`. In PowerShell, in the project folder:

```
New-Item -ItemType Directory -Force .github\workflows
Move-Item github-workflows\*.yml .github\workflows\
Remove-Item github-workflows
```

## 2. Tell the pipeline which storage to use

1. In the Cloudflare dashboard open Storage & Databases, KV, and copy the **ID** of the `my-buses` namespace (a long string of letters and digits).
2. In `wrangler.toml` replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with it, and save.

The ID is not a secret. If it is wrong, the deploy would attach the Worker to different (empty) storage, so copy it carefully.

## 3. Give GitHub permission to deploy

1. **Cloudflare API token.** In the Cloudflare dashboard open your profile, API Tokens, Create Token, and use the **Edit Cloudflare Workers** template. Copy the token; it is shown once.
2. **Account ID.** Shown on the Workers & Pages overview page.
3. In the GitHub repository open Settings, Secrets and variables, Actions.
   - Secrets tab, New repository secret: `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID` (the account ID).
   - Variables tab, New repository variable: `APP_URL` = `https://my-buses.<your-subdomain>.workers.dev` (used for the check after each deploy).

The app's own secrets (LTA key, VAPID keys, OneMap, Google) stay on the Worker in Cloudflare. A deploy does not touch them.

## 4. Commit and push

Do this last: the first push to `main` triggers a deploy, so steps 2 and 3 must already be in place.

```
git init -b main
git add .
git status          # check that .env is NOT listed
git commit -m "Initial commit: bus arrival and trip departure notifier"
git remote add origin https://github.com/<your-username>/my-buses.git
git push -u origin main
```

Open the repository's **Actions** tab and watch the Deploy run: Test, then Deploy to Cloudflare, then the live check.

Afterwards open `<your address>/api/status`. `build` should end with the commit id, and `push`, `trips`, `calendar` and `keySet` should all be `true`. If any is `false`, a binding or secret went missing: stop and compare the Worker's Settings with `DEPLOY.md`.

What the first deploy changes on Cloudflare: the schedule (`* * * * *`) and logging are now set from `wrangler.toml`, replacing what was set by hand. Storage and secrets stay as they are.

## 5. Protect `main`

In the GitHub repository open Settings, Branches (or Rules), and add a rule for `main`:

- Require a pull request before merging.
- Require status checks to pass, and select **Test and build**.
- Do not allow bypassing (include administrators), if you want the rule to apply to you too.

From here on, follow "Working on it: the routine" in `README.md`.

## Optional later steps

- **Approval before deploy.** The deploy job runs in a GitHub environment named `production`. In Settings, Environments, you can require a manual approval click before each deploy.
- **A staging copy.** A second Worker (`my-buses-staging`) with its own KV namespace and secrets, deployed from pull requests, so changes can be tried on a phone before they reach `main`.
- **Browser tests.** The suites test the server and its logic. Tests that drive the page in a real browser can be added with Playwright as a separate CI job.
