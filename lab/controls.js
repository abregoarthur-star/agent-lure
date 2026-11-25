/**
 * Non-LLM visitors — the control group. None of them should take an
 * instruction or bait lure; if one does, the lure is a false alarm source.
 *
 *   polite     reads robots.txt and obeys it, follows links (a search crawler)
 *   scanner    ignores robots.txt and requests its Disallow paths, follows
 *              links, tries common sensitive paths (a vulnerability scanner)
 *   extractor  pulls every /path-looking string out of every response —
 *              HTML comments, llms.txt, JSON errors included — and requests
 *              them (link extractors such as katana / gau / LinkFinder)
 */

const COMMON = ['/admin', '/.env', '/.git/config', '/wp-login.php', '/api', '/api/v1/users', '/server-status', '/backup.zip', '/config.json', '/swagger.json', '/openapi.json', '/llms.txt'];

async function get(base, path, ua) {
  try {
    const res = await fetch(new URL(path, base), { headers: { 'user-agent': ua }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    return { status: res.status, body: await res.text() };
  } catch {
    return { status: 0, body: '' };
  }
}

const hrefs = (html) => [...html.matchAll(/href="(\/[^"#?]*)"/g)].map((m) => m[1]);
const anyPaths = (text) => [...text.matchAll(/(?<![\w.])\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*/g)].map((m) => m[0]);

function disallows(robots) {
  return [...robots.matchAll(/^Disallow:\s*(\S+)/gim)].map((m) => m[1]);
}

async function crawl(base, ua, { start, extract, blocked = [], limit = 60 }) {
  const seen = new Set();
  const queue = [...start];
  while (queue.length && seen.size < limit) {
    const path = queue.shift();
    if (seen.has(path) || blocked.some((b) => path.startsWith(b))) continue;
    seen.add(path);
    const { body } = await get(base, path, ua);
    for (const p of extract(body)) if (!seen.has(p)) queue.push(p);
  }
  return seen.size;
}

export const CONTROLS = {
  async polite(base, ua) {
    const robots = await get(base, '/robots.txt', ua);
    return (await crawl(base, ua, { start: ['/'], extract: hrefs, blocked: disallows(robots.body) })) + 1;
  },
  async scanner(base, ua) {
    const robots = await get(base, '/robots.txt', ua);
    return (await crawl(base, ua, { start: ['/', ...disallows(robots.body), ...COMMON], extract: hrefs })) + 1;
  },
  async extractor(base, ua) {
    return crawl(base, ua, { start: ['/', '/robots.txt', '/llms.txt', '/does-not-exist', '/api/v1/invoices'], extract: anyPaths, limit: 120 });
  },
};
