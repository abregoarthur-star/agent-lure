/**
 * Host adapters. Each turns the host's request into the sensor's plain
 * object and, when the sensor answers, writes its response.
 */

/**
 * Express middleware. Mount it after `app.set('trust proxy', …)` so req.ip is
 * the visitor, and before any auth wall so lures are reachable.
 */
export function expressSensor(sensor) {
  return (req, res, next) => {
    const { response, done } = sensor.handle({
      method: req.method,
      path: req.path,
      url: req.originalUrl,
      headers: req.headers,
      ip: req.ip,
    });
    done.catch(() => {});
    if (!response) return next();
    res.status(response.status).set(response.headers).send(response.body);
  };
}

/**
 * Cloudflare Worker: returns a Response when the sensor answers, else null.
 * The report is kept alive with ctx.waitUntil.
 */
export function workerSensor(sensor, request, ctx) {
  const url = new URL(request.url);
  const headers = {};
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
  const { response, done } = sensor.handle({
    method: request.method,
    path: url.pathname,
    url: url.pathname + url.search,
    headers,
    ip: request.headers.get('cf-connecting-ip') || null,
  });
  if (ctx?.waitUntil) ctx.waitUntil(done);
  if (!response) return null;
  return new Response(response.body, { status: response.status, headers: response.headers });
}
