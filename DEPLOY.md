> **Note.** Day-to-day deploys now go through the pipeline (see README.md and SETUP-CICD.md). This file is kept as the record of how each piece was first set up in the Cloudflare and Google dashboards, and for the one-time setup of a new environment. Where it says to paste `dist/worker.js` into the dashboard, merge to `main` instead.

# Hosting My Buses for free on Cloudflare Workers

The whole app (pages, stop list and the LTA proxy) is packed into one file, `dist/worker.js`. You deploy that one file. Your LTA key is stored as a Worker secret, not in the file.

Free plan limits (checked Oct 2026): 100,000 requests a day. One open page with two stops uses about 360 an hour.

## Build the file

```
node build-worker.mjs
```

This needs `data/stops.json`, which the local app downloads the first time it runs with your key. Rebuild whenever you change anything in `public/` or want a fresh stop list.

## Option A: deploy in the browser (no command line)

1. Sign up for a free account at https://dash.cloudflare.com
2. Go to Workers & Pages, create a new Worker (the "Hello World" starter), name it `my-buses`, and deploy it.
3. Open the Worker and choose Edit code. Delete everything in the editor.
4. Open `dist/worker.js` on your laptop in Notepad or VS Code, select all, copy, and paste it into the editor. Deploy.
5. In the Worker's Settings, under Variables and Secrets, add one of type Secret:
   - Variable name: `LTA_ACCOUNT_KEY`
   - Value: your key
   Deploy.
6. Open the Worker's `workers.dev` address. On your phone, open the same address and use "Add to Home screen".

## Option B: deploy from the command line

```
npx wrangler login
npx wrangler secret put LTA_ACCOUNT_KEY
npx wrangler deploy
```

On a network that inspects secure traffic (the `SELF_SIGNED_CERT_IN_CHAIN` error), run this first in the same PowerShell window:

```
$env:NODE_OPTIONS="--use-system-ca"
```

## Check it worked

Open `https://<your-worker-address>/api/status`. It should show `"keySet":true` and about 5,200 stops. Then open the main address and compare a stop with the MyTransport.SG app.

## Things to know

- Your bookmarks live in each browser. Each browser starts with no stops; add yours there once.
- Anyone who has the address can use the app, and their lookups count against your LTA key's quota. They cannot see the key. Keep the address to yourself.
- Alerts when the app is closed need the one-time setup below.
- If your LTA key ever changes, update the secret in the Worker's settings. No rebuild needed.

## Alerts when the app is closed (one-time setup)

1. **Storage.** In the Cloudflare dashboard go to Storage & Databases, KV, and create a namespace named `my-buses`.
2. **Connect it.** Open the Worker, Settings, Bindings, Add, KV namespace. Variable name: `KV` (capitals). Namespace: `my-buses`. Deploy.
3. **Keys.** On your laptop, in the `bus-app` folder, run `node generate-vapid.mjs`. In the Worker's Settings, Variables and Secrets, add two Secrets with the names and values it prints: `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. Deploy (not "Save version").
4. **Code.** Paste the latest `dist/worker.js` into Edit code and Deploy.
5. **Schedule.** Worker, Settings, Trigger Events, Add, Cron Triggers. Cron expression: `* * * * *` (every minute).
6. **Check.** Open `<your address>/api/status`. It should show `"push":true`.
7. **On your Android phone, in Chrome:** open the address, tap "Turn on leave-now alerts" and allow notifications. Tap "Send a test notification". Two notifications should arrive: a "Ping received" one and a "Test alert" one.
8. On each stop, follow at least one bus (gear icon), then add one or more alert times. Each has its own days of the week, specific dates, hours, and how often to notify (default every 5 minutes, minimum 2).

How it works: every minute Cloudflare runs the Worker. While an alert time is running, it sends the bus times for that stop at your chosen interval, counted from the start of the hours, until the hours end or you tap "Stop these alerts" on a notification (or "Stop for now" in the app). Stopping lasts until that run's hours end; the next run starts as normal. If the end time is earlier than the start time, the run continues past midnight.

Free limits this uses (checked Oct 2026): KV allows 100,000 reads and 1,000 writes a day. The job does one read a minute (1,440 a day). Writes happen only when you change settings or tap Stop.

Useful for troubleshooting: `<your address>/api/push/run` runs the every-minute check on demand and shows what it did. Add `?force=1` to send the notification now instead of waiting for the next interval.

## Trip planning (one-time setup)

1. Register a free account at onemap.gov.sg (API registration).
2. In the Worker's Settings, Variables and Secrets, add two Secrets: `ONEMAP_EMAIL` and `ONEMAP_PASSWORD`. Deploy (not "Save version").
3. Paste the latest `dist/worker.js` into Edit code and Deploy.
4. `<your address>/api/status` should show `"trips":true`. A "Plan a trip" section appears in the app.

OneMap tokens last 3 days. The Worker signs in with the email and password, keeps the token in KV, and renews it by itself, so there is nothing to refresh by hand.

Troubleshooting: `<your address>/api/places?q=bugis` tests the sign-in and place search. Adding `&debug=1` to an `/api/route?...` address shows OneMap's raw answer for the first option.

## Google Calendar (one-time setup)

1. At console.cloud.google.com create a project (for example "My Buses").
2. APIs & Services, Library: enable "Google Calendar API".
3. OAuth consent screen: External. Enter an app name and your email, and add yourself as a test user.
4. Credentials: create an OAuth client ID of type "Web application". Authorised redirect URI, exactly:
   `https://<your address>/api/google/callback`
5. In the Worker's Settings, Variables and Secrets, add two Secrets: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Deploy (not "Save version").
6. Paste the latest `dist/worker.js` into Edit code and Deploy.
7. `<your address>/api/status` should show `"calendar":true`. In the app, under Plan a trip, tap "Connect Google Calendar".
8. Once it works, set the consent screen's publishing status to "In production". In "Testing", Google ends the sign-in after 7 days.

What the app can do: read events only (scope `calendar.events.readonly`). It cannot change your calendar.

Who can see your calendar: only a browser that signed in. Signing in sets a private cookie in that browser; the Worker stores Google's token in KV under a hash of that cookie. Other people opening the address see no calendar. Each of your devices signs in separately. "Disconnect" revokes the access at Google and deletes the stored token.

If sign-in returns to the app with "did not complete", the app shows Google's reason. The usual cause is a redirect URI that doesn't match step 4 exactly.

## Leave alerts for your next appointment

Needs all of the above: closed-app alerts, trip planning and Google Calendar. No extra Cloudflare setup.

In the app, on your phone: turn on leave-now alerts, connect Google Calendar, save your usual starting place (for example Home), then under Next appointments tick "Alert me before I need to leave", set the minutes, and choose the starting place.

How it works:
- Every 5 minutes the Worker reads your calendar. When the next appointment that has a location starts within 3 hours, it plans a public transport route that arrives by the start time.
- One notification is sent the chosen number of minutes before you need to leave, with the walk, stop, bus and times. If LTA has a live estimate for that bus, it is included.
- Starting point: your GPS position if the app saw it in the last 30 minutes, otherwise the starting place you chose. Open the app before you set off from somewhere unusual.
- Locations: a 6-digit postal code in the event location is the most reliable. A saved place whose name appears in the location (for example "Office") is used directly.
- All-day events and events without a location are ignored.

Check it: `<your address>/api/push/run?force=1` plans now and sends a "Preview:" notification of the current plan. The page also shows what was planned, or why it could not be.

## The two features, as named in the app

**Bus arrival notifier.** Bookmarked stops with live times. Bus notifications are sent only during the alert times you add on a stop (days, dates, hours, interval), whether the app is open or closed. Having the app open does not cause any other bus notifications. The "Leave now within N min" setting only changes the wording of those notifications.

**Trip departure notifier.** Plan a route and the app asks the Worker to notify this phone N minutes before the suggested departure (default 10), whether the app is open or closed. One planned trip is held per phone; planning another replaces it, and Cancel removes it. If less than N minutes remain, the notification is sent at once. With Google Calendar connected and "Alert me before I need to leave" ticked, the same kind of notification is sent for your next appointment without you planning anything.

Both need notifications turned on in the app on that phone ("Turn on notifications").
