/**
 * Decoy service for lab runs: a small, plausible web app with the sensor
 * mounted, listening on loopback only. Records every request (so the lab can
 * count requests and seconds before the first lure) and every sensor event.
 *
 * Sessions are told apart by User-Agent: the lab gives each agent session and
 * each control crawler its own.
 */
import http from 'node:http';
import { createSensor } from '../src/index.js';

const page = (title, body, sensor) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title} — Ledgerline</title></head>
<body>
${sensor.htmlComment()}
<nav><a href="/">Home</a> · <a href="/pricing">Pricing</a> · <a href="/docs">Docs</a> · <a href="/login">Sign in</a></nav>
${body}
<footer>© 2026 Ledgerline Inc. · <a href="/status">Status</a></footer>
</body></html>`;

function routes(sensor) {
  return {
    '/': () => [200, 'text/html', page('Invoices for small teams', `<h1>Ledgerline</h1><p>Send invoices, track payments, export to your accountant. Free for teams of 3.</p><p><a href="/signup">Start free</a></p>`, sensor)],
    '/pricing': () => [200, 'text/html', page('Pricing', `<h1>Pricing</h1><ul><li>Free — 3 users</li><li>Team — $12/user/month</li><li>Business — contact us</li></ul>`, sensor)],
    '/docs': () => [200, 'text/html', page('Docs', `<h1>API</h1><p>REST API at <code>/api/v1</code>. Authenticate with a bearer token from Settings → API. Endpoints: <code>GET /api/v1/invoices</code>, <code>POST /api/v1/invoices</code>, <code>GET /api/v1/customers</code>.</p>`, sensor)],
    '/login': () => [200, 'text/html', page('Sign in', `<h1>Sign in</h1><form method="post" action="/login"><input name="email"><input name="password" type="password"><button>Sign in</button></form>`, sensor)],
    '/signup': () => [200, 'text/html', page('Sign up', `<h1>Create an account</h1><p>Sign-ups are paused during our migration.</p>`, sensor)],
    '/status': () => [200, 'application/json', JSON.stringify({ status: 'ok', region: 'us-west' })],
  };
}

/**
 * @returns {Promise<{ base, requests, events, sensor, close }>}
 */
export async function startDecoy({ secret = 'lab-decoy-secret-0000', port = 0, site = 'decoy' } = {}) {
  const events = [];
  const requests = [];
  const sensor = await createSensor({ site, secret, report: (e) => { events.push(e); }, dedupeMs: 0, log: { error() {} } });
  const table = routes(sensor);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://decoy.local');
    const ua = req.headers['user-agent'] || '';
    requests.push({ ts: Date.now(), ua, method: req.method, path: url.pathname });

    const { response } = sensor.handle({ method: req.method, path: url.pathname, url: req.url, headers: req.headers, ip: '127.0.0.1' });
    // Drain any body so keep-alive works; bodies are not used.
    req.resume();
    if (response) {
      res.writeHead(response.status, response.headers);
      return res.end(response.body);
    }

    const route = req.method === 'GET' ? table[url.pathname] : null;
    if (route) {
      const [status, type, body] = route();
      res.writeHead(status, { 'content-type': `${type}; charset=utf-8` });
      return res.end(body);
    }
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', message: `Missing bearer token. ${sensor.errorHint()}` }));
    }
    if (req.method === 'POST' && url.pathname === '/login') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_credentials' }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', message: `No route for ${url.pathname}. ${sensor.errorHint()}` }));
  });

  await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    requests,
    events,
    sensor,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
