// Minimal service worker: makes the app installable and lets notifications show from the worker.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // network only; live data should never be served stale
// A push from the server: show its message. A push with no message is the test "ping".
self.addEventListener('push', (e) => {
  let msg = null;
  try { msg = e.data ? e.data.json() : null; } catch {}
  const title = (msg && msg.title) || 'My Buses';
  const body = (msg && msg.body) || 'Ping received: the push channel to this phone works.';
  const repeating = Boolean(msg && msg.stop && msg.alarm);   // part of a run that can be stopped
  e.waitUntil(Promise.all([logReceived({ t: Date.now(), title, body }), self.registration.showNotification(title, {
    // Bus updates buzz every time. A departure notification buzzes once: a repeat with the same tag replaces it silently.
    body, tag: (msg && msg.tag) || 'ping', icon: '/icon.svg', renotify: !(msg && msg.tag && msg.tag.startsWith('trip-')),
    data: repeating ? { stop: msg.stop, alarm: msg.alarm } : null,
    actions: repeating ? [{ action: 'stop', title: 'Stop these alerts' }] : [],
  })]));
});

// Keep the past week's notifications that reached this phone (at most 300), so the app can show a log.
async function logReceived(entry) {
  try {
    const c = await caches.open('mb-log');
    const r = await c.match('/__log');
    const list = r ? await r.json() : [];
    const weekAgo = Date.now() - 7 * 86_400_000;
    const keep = [entry, ...list.filter((e) => e && e.t > weekAgo)].slice(0, 300);
    await c.put('/__log', new Response(JSON.stringify(keep), { headers: { 'content-type': 'application/json' } }));
  } catch {}
}

// Tapping "Stop these alerts" ends that run until its hours are over. Tapping the notification opens the app.
self.addEventListener('notificationclick', (e) => {
  const d = e.notification.data;
  e.notification.close();
  if (e.action === 'stop' && d) {
    e.waitUntil(self.registration.pushManager.getSubscription().then((sub) => sub && fetch('/api/push/stop', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint, code: d.stop, alarm: d.alarm }),
    })).catch(() => {}));
    return;
  }
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow('/'))));
});
