import http from 'node:http';
const inMin = (m) => new Date(Date.now() + m * 60000).toISOString();
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.headers.accountkey !== 'testkey') { res.writeHead(401); return res.end('{}'); }
  res.setHeader('content-type', 'application/json');
  if (u.pathname.endsWith('/BusArrivalv2')) {
    return res.end(JSON.stringify({ BusStopCode: u.searchParams.get('BusStopCode'), Services: [
      { ServiceNo: '74', Operator: 'SBST',
        NextBus:  { EstimatedArrival: inMin(4.5), Load: 'SEA', Feature: 'WAB', Type: 'DD' },
        NextBus2: { EstimatedArrival: inMin(14), Load: 'SDA', Feature: '', Type: 'SD' },
        NextBus3: { EstimatedArrival: '', Load: '', Feature: '', Type: '' } },
      { ServiceNo: '9', Operator: 'SBST',
        NextBus:  { EstimatedArrival: '', Load: '', Feature: '', Type: '' },
        NextBus2: { EstimatedArrival: '', Load: '', Feature: '', Type: '' },
        NextBus3: { EstimatedArrival: '', Load: '', Feature: '', Type: '' } } ] }));
  }
  if (u.pathname.endsWith('/BusStops')) {
    const skip = Number(u.searchParams.get('$skip') || 0);
    const value = skip === 0 ? [{ BusStopCode: '01012', RoadName: 'Test Rd', Description: 'Opp Test Blk', Latitude: 1.3, Longitude: 103.8 }] : [];
    return res.end(JSON.stringify({ value }));
  }
  res.writeHead(404); res.end('{}');
}).listen(3222);
