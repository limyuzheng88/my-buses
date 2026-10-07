// Stand-in for Google: consent redirect, token exchange/refresh, calendar events, revoke.
import http from 'node:http';
export const g = { refresh: new Set(), access: new Set(), n: 0, refreshes: 0, authParams: null, revoked: [], calQuery: null };
const BASE = Date.now();   // appointments keep fixed times, as a real calendar does
const inH = (h) => new Date(BASE + h * 3600e3).toISOString().replace('Z', '+00:00');
export const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const chunks = []; for await (const c of req) chunks.push(c);
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (u.pathname === '/auth') { g.authParams = Object.fromEntries(u.searchParams); res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=code-1&state=${u.searchParams.get('state')}` }); return res.end(); }
  if (u.pathname === '/token') {
    const b = new URLSearchParams(Buffer.concat(chunks).toString());
    if (b.get('client_id') !== 'cid' || b.get('client_secret') !== 'csecret') return send(401, { error: 'invalid_client' });
    if (b.get('grant_type') === 'authorization_code') {
      if (b.get('code') !== 'code-1' || !b.get('redirect_uri').endsWith('/api/google/callback')) return send(400, { error: 'invalid_grant', error_description: 'Bad code' });
      const rt = `rt-${++g.n}`, at = `at-${g.n}`; g.refresh.add(rt); g.access.add(at); return send(200, { access_token: at, refresh_token: rt, expires_in: 3600 });
    }
    if (!g.refresh.has(b.get('refresh_token'))) return send(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    g.refreshes += 1; const at = `at-r${g.refreshes}`; g.access.add(at); return send(200, { access_token: at, expires_in: 3600 });
  }
  if (u.pathname === '/revoke') { g.revoked.push(u.searchParams.get('token')); g.refresh.delete(u.searchParams.get('token')); return send(200, {}); }
  if (u.pathname === '/cal/calendars/primary/events') {
    if (!g.access.has((req.headers.authorization || '').replace('Bearer ', ''))) return send(401, { error: { message: 'Invalid Credentials' } });
    g.calQuery = Object.fromEntries(u.searchParams);
    return send(200, { items: [
      { id: 'e0', summary: 'Already started', location: 'Somewhere', status: 'confirmed', start: { dateTime: inH(-0.5) }, end: { dateTime: inH(0.5) } },
      { id: 'e1', summary: 'Public holiday', status: 'confirmed', start: { date: '2026-10-05' }, end: { date: '2026-10-06' } },
      { id: 'e2', summary: 'Cancelled thing', location: 'X', status: 'cancelled', start: { dateTime: inH(1) }, end: { dateTime: inH(2) } },
      { id: 'e3', summary: 'Dentist', location: 'Bugis Dental, 230 Victoria Street, Singapore 188024', status: 'confirmed', start: { dateTime: inH(2) }, end: { dateTime: inH(3) } },
      { id: 'e4', summary: 'Lunch', status: 'confirmed', start: { dateTime: inH(5) }, end: { dateTime: inH(6) } },
      { id: 'e5', location: 'Office', status: 'confirmed', start: { dateTime: inH(26) }, end: { dateTime: inH(27) } } ] });
  }
  send(404, {});
});
