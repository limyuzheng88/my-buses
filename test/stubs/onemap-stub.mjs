// Stand-in for OneMap: token, search, public transport routing (OpenTripPlanner-style answer).
import http from 'node:http';
export const om = { issued: 0, valid: new Set(), bearer: true, routeQueries: [], ttlHours: 72 };
export const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const chunks = []; for await (const c of req) chunks.push(c);
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (u.pathname === '/api/auth/post/getToken' && req.method === 'POST') {
    const b = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (b.email !== 'me@example.com' || b.password !== 'pw') return send(401, { error: 'bad credentials' });
    const tok = `tok-${++om.issued}`; om.valid.add(tok);
    return send(200, { access_token: tok, expiry_timestamp: String(Math.floor(Date.now() / 1000 + om.ttlHours * 3600)) });
  }
  const a = req.headers.authorization || '';
  const tok = om.bearer ? (a.startsWith('Bearer ') ? a.slice(7) : '') : a;
  if (!om.valid.has(tok)) return send(401, { message: 'Unauthorized' });
  if (u.pathname === '/api/common/elastic/search') { om.searches = (om.searches || 0) + 1;
    return send(200, { found: 2, results: [
      { SEARCHVAL: 'BUGIS JUNCTION', BUILDING: 'BUGIS JUNCTION', ADDRESS: '200 VICTORIA STREET BUGIS JUNCTION SINGAPORE 188021', LATITUDE: '1.29911', LONGITUDE: '103.85560' },
      { SEARCHVAL: '230 VICTORIA STREET', BUILDING: 'NIL', ADDRESS: '230 VICTORIA STREET SINGAPORE 188024', LATITUDE: '1.30010', LONGITUDE: '103.85600' } ] });
  }
  if (u.pathname === '/api/public/routingsvc/route') {
    const [mo, d, y] = u.searchParams.get('date').split('-'); const dep = Date.parse(`${y}-${mo}-${d}T${u.searchParams.get('time')}+08:00`);
    om.routeQueries.push({ dep, params: Object.fromEntries(u.searchParams) });
    const it = (offMin) => { const s = dep + offMin * 60000; return { duration: 27 * 60, startTime: s, endTime: s + 27 * 60000, walkTime: 7 * 60, transitTime: 20 * 60, transfers: 0, fare: '1.19', legs: [
      { mode: 'WALK', startTime: s, endTime: s + 4 * 60000, duration: 240, from: { name: 'Origin' }, to: { name: 'HOTEL GRAND PACIFIC', stopId: 'FERRY:01012', stopCode: '01012' } },
      { mode: 'BUS', route: '74', startTime: s + 4 * 60000, endTime: s + 24 * 60000, duration: 1200, numIntermediateStops: 8, from: { name: 'HOTEL GRAND PACIFIC', stopId: 'FERRY:01012', stopCode: '01012' }, to: { name: 'BUGIS STN', stopId: 'FERRY:01113' } },
      { mode: 'WALK', startTime: s + 24 * 60000, endTime: s + 27 * 60000, duration: 180, from: { name: 'BUGIS STN' }, to: { name: 'Destination' } } ] }; };
    return send(200, { plan: { itineraries: [it(12), it(2), it(7)] } });
  }
  send(404, {});
});
