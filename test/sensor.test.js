import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSensor, expressSensor, workerSensor, hubReporter } from '../src/index.js';

const SECRET = 'test-secret-0123456789';

async function sensorWithLog(opts = {}) {
  const events = [];
  let clock = Date.parse('2026-11-25T00:00:00Z');
  const sensor = await createSensor({
    site: 'decoy',
    secret: SECRET,
    report: (e) => { events.push(e); },
    now: () => clock,
    log: { error() {} },
    ...opts,
  });
  return { sensor, events, tick: (ms) => { clock += ms; } };
}

const req = (path, extra = {}) => ({ method: 'GET', path, url: path, headers: { 'user-agent': 'ua-1' }, ip: '203.0.113.5', ...extra });

test('rejects a bad site name or a short secret', async () => {
  await assert.rejects(createSensor({ site: 'Bad Site', secret: SECRET }), /site/);
  await assert.rejects(createSensor({ site: 'ok', secret: 'short' }), /secret/);
});

test('paths and bait key are stable for a site and differ between sites', async () => {
  const a1 = (await createSensor({ site: 'a', secret: SECRET })).plan();
  const a2 = (await createSensor({ site: 'a', secret: SECRET })).plan();
  const b = (await createSensor({ site: 'b', secret: SECRET })).plan();
  assert.deepEqual(a1, a2);
  assert.notEqual(a1.paths.llms, b.paths.llms);
  assert.notEqual(a1.baitKey, b.baitKey);
  assert.match(a1.baitKey, /^ak_live_[0-9a-f]{32}$/);
});

test('ordinary requests pass through and report nothing', async () => {
  const { sensor, events } = await sensorWithLog();
  for (const p of ['/', '/health', '/admin', '/login', '/api/v1/users']) {
    const { response, done } = sensor.handle(req(p));
    await done;
    assert.equal(response, null, p);
  }
  assert.equal(events.length, 0);
});

test('robots.txt and llms.txt are served without counting as hits', async () => {
  const { sensor, events } = await sensorWithLog();
  const { paths } = sensor.plan();
  const robots = sensor.handle(req('/robots.txt')).response;
  assert.equal(robots.status, 200);
  assert.ok(robots.body.includes(`Disallow: ${paths.robots}`));
  const llms = sensor.handle(req('/llms.txt')).response;
  assert.ok(llms.body.includes(paths.llms.replace(/\/token$/, '')), 'names the stem');
  assert.ok(!llms.body.includes(paths.llms), 'never the whole path');
  assert.equal(events.length, 0);
});

test('hosts with their own robots.txt can turn serving off', async () => {
  const { sensor } = await sensorWithLog({ serveRobots: false, serveLlms: false });
  assert.equal(sensor.handle(req('/robots.txt')).response, null);
  assert.equal(sensor.handle(req('/llms.txt')).response, null);
  assert.ok(sensor.robotsLines().startsWith('User-agent: *'));
});

test('each lure reports its own name and kind', async () => {
  const { sensor, events } = await sensorWithLog();
  const { paths } = sensor.plan();
  const cases = [
    [paths.robots, 'robots', 'crawl', 404],
    [`${paths.robots}anything/below`, 'robots', 'crawl', 404],
    [paths.llms, 'llms', 'instruction', 200],
    [paths.comment, 'comment', 'instruction', 200],
    [paths.error, 'error', 'instruction', 200],
    [`${paths['bait-endpoint']}users`, 'bait-endpoint', 'bait', 401],
  ];
  for (const [path, lure, kind, status] of cases) {
    events.length = 0;
    const { response, done } = sensor.handle(req(path, { ip: `198.51.100.${cases.findIndex((c) => c[0] === path)}` }));
    await done;
    assert.equal(response.status, status, path);
    assert.equal(events.length, 1, path);
    assert.equal(events[0].lure, lure);
    assert.equal(events[0].kind, kind);
    assert.equal(events[0].site, 'decoy');
    assert.equal(events[0].path, path);
  }
});

test('planted text never holds an instruction lure path whole; its parts alone are fragments', async () => {
  const { sensor, events } = await sensorWithLog();
  const { paths } = sensor.plan();
  const planted = [sensor.llmsText(), sensor.htmlComment(), sensor.errorHint()].join('\n');
  for (const lure of ['llms', 'comment', 'error']) assert.ok(!planted.includes(paths[lure]), lure);

  // What a path-extracting scanner would request from the planted text.
  const extracted = [...new Set(planted.match(/\/[A-Za-z0-9._~\/-]+/g))];
  for (const p of extracted) await sensor.handle(req(p, { ip: `10.1.0.${extracted.indexOf(p)}` })).done;
  assert.ok(events.length > 0, 'the stems are requested');
  assert.ok(events.every((e) => e.lure === 'fragment' && e.kind === 'crawl'), JSON.stringify(events));
});

test('the docs page leads to the bait endpoint and key', async () => {
  const { sensor } = await sensorWithLog();
  const { paths, baitKey } = sensor.plan();
  const body = sensor.handle(req(paths.llms)).response.body;
  assert.ok(body.includes(paths['bait-endpoint']));
  assert.ok(body.includes(baitKey));
});

test('the bait key is caught in a header or the URL, on any path', async () => {
  const { sensor, events } = await sensorWithLog();
  const { baitKey } = sensor.plan();
  let r = sensor.handle(req('/api/anything', { headers: { authorization: `Bearer ${baitKey}` }, ip: '192.0.2.1' }));
  await r.done;
  assert.equal(r.response, null, 'the host still answers the request');
  r = sensor.handle(req(`/x?key=${baitKey}`, { url: `/x?key=${baitKey}`, ip: '192.0.2.2' }));
  await r.done;
  assert.deepEqual(events.map((e) => e.lure), ['bait-key', 'bait-key']);
});

test('the same source taking the same lure reports once per window', async () => {
  const { sensor, events, tick } = await sensorWithLog({ dedupeMs: 60_000 });
  const { paths } = sensor.plan();
  await sensor.handle(req(paths.llms)).done;
  await sensor.handle(req(paths.llms)).done;
  await sensor.handle(req(paths.comment)).done; // another lure counts
  await sensor.handle(req(paths.llms, { ip: '203.0.113.6' })).done; // another source counts
  tick(61_000);
  await sensor.handle(req(paths.llms)).done;
  assert.deepEqual(events.map((e) => e.lure), ['llms', 'comment', 'llms', 'llms']);
});

test('long header values are cut before they are reported', async () => {
  const { sensor, events } = await sensorWithLog();
  const { paths } = sensor.plan();
  await sensor.handle(req(paths.llms, { headers: { 'user-agent': 'x'.repeat(5000), referer: 'y'.repeat(5000) } })).done;
  assert.equal(events[0].ua.length, 300);
  assert.equal(events[0].referer.length, 200);
});

test('a failing reporter never breaks the request', async () => {
  const sensor = await createSensor({ site: 'decoy', secret: SECRET, report: () => { throw new Error('down'); }, log: { error() {} } });
  const { response, done } = sensor.handle(req(sensor.plan().paths.llms));
  await done;
  assert.equal(response.status, 200);
});

test('express adapter answers lures and passes everything else on', async () => {
  const { sensor, events } = await sensorWithLog();
  const mw = expressSensor(sensor);
  const fakeRes = () => {
    const r = { statusCode: 0, headers: {}, body: null };
    r.status = (s) => { r.statusCode = s; return r; };
    r.set = (h) => { Object.assign(r.headers, h); return r; };
    r.send = (b) => { r.body = b; return r; };
    return r;
  };
  let nexted = 0;
  const pass = fakeRes();
  mw({ method: 'GET', path: '/', originalUrl: '/', headers: {}, ip: '1.1.1.1' }, pass, () => { nexted++; });
  assert.equal(nexted, 1);

  const hit = fakeRes();
  const p = sensor.plan().paths.llms;
  mw({ method: 'GET', path: p, originalUrl: p, headers: { 'user-agent': 'agent' }, ip: '1.1.1.1' }, hit, () => { nexted++; });
  assert.equal(nexted, 1);
  assert.equal(hit.statusCode, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(events[0].ip, '1.1.1.1');
});

test('worker adapter uses cf-connecting-ip and waitUntil', async () => {
  const { sensor, events } = await sensorWithLog();
  const waited = [];
  const ctx = { waitUntil: (p) => waited.push(p) };
  assert.equal(workerSensor(sensor, new Request('https://w.example/health'), ctx), null);

  const p = sensor.plan().paths.comment;
  const res = workerSensor(sensor, new Request(`https://w.example${p}`, { headers: { 'cf-connecting-ip': '9.9.9.9', 'User-Agent': 'bot' } }), ctx);
  assert.equal(res.status, 200);
  await Promise.all(waited);
  assert.equal(events[0].ip, '9.9.9.9');
  assert.equal(events[0].ua, 'bot');
});

test('hubReporter posts to /sensor/events with the key', async () => {
  const calls = [];
  const report = hubReporter({
    url: 'https://hub.example/',
    key: 'k1',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response('{}', { status: 202 }); },
  });
  await report({ lure: 'llms' });
  assert.equal(calls[0].url, 'https://hub.example/sensor/events');
  assert.equal(calls[0].init.headers['x-api-key'], 'k1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { events: [{ lure: 'llms' }] });

  const failing = hubReporter({ url: 'https://hub.example', key: 'k1', fetchImpl: async () => new Response('', { status: 401 }) });
  await assert.rejects(failing({}), /401/);
  assert.equal(typeof hubReporter({ url: '', key: '' }), 'function', 'unconfigured reporter is a no-op');
});
