# agent-lure

A sensor that tells AI agents apart from people and ordinary bots by what they do with text only a machine reads. It plants lures in a service's pages and reports to a hub (the AI Security Agent) when one is taken.

| Kind | Lure | Who takes it |
|---|---|---|
| `crawl` | `robots` — a path named only as `Disallow` in robots.txt | any bot that ignores robots.txt |
| `crawl` | `fragment` — part of an instruction lure's path | scanners that pull `/paths` out of page text |
| `instruction` | `llms`, `comment`, `error` — a request asked for in plain language in llms.txt, an HTML comment or an error message | a reader that understands the sentence: an LLM agent |
| `bait` | `bait-endpoint`, `bait-key` — the fake admin endpoint and API key the instruction lures lead to | an agent acting on what it found |

The planted text never contains an instruction lure's full path. It names a stem and a suffix to join ("take `/3f9a…` and add `/register`"), so a regex extractor gets only the parts (`fragment`, crawl) while a model composes the whole. Paths and the bait key are derived from a secret and the site name: stable per site, different between sites.

Lures only ask for a request. Nothing served tries to make a visiting agent do anything else. The bait endpoint answers `401 key_expired`.

## Use

```js
import { createSensor, hubReporter, expressSensor } from '@dj_abstract/agent-lure';

const sensor = await createSensor({
  site: 'brain',                         // the hub key must be named lure-brain
  secret: process.env.LURE_SECRET,       // ≥16 chars
  report: hubReporter({ url: process.env.AI_SEC_AGENT_URL, key: process.env.LURE_HUB_KEY }),
});
app.use(expressSensor(sensor));          // after trust proxy, before the auth wall
// put sensor.htmlComment() in public HTML, sensor.errorHint() in 404 / 401 bodies
```

Cloudflare Worker: `const res = workerSensor(sensor, request, ctx); if (res) return res;` at the top of `fetch`.

The hub (`POST /sensor/events` on ai-security-agent) takes the site from the key name, the kind from the lure name, alerts Telegram on the first instruction or bait hit per source per day, and never alerts on crawl hits.

## Lab

`lab/` runs Claude agent sessions and three non-LLM control crawlers (polite, scanner, path extractor) against a local decoy and measures detection.

```bash
node lab/run.js --controls-only                     # free
node lab/run.js --estimate --models haiku,sonnet    # cost ceiling for a plan
node --env-file=<env with ANTHROPIC_API_KEY> lab/run.js --models haiku --repeats 3 --cap 0.5 [--hardened]
```

`--hardened` gives each agent a system-prompt defence against instructions in page content: what an attacker's agent would carry. Results go to `lab/results/` (not committed).

### First results (2026-11-25, Claude Haiku 5.5, effort medium, 3 tasks × 3 sessions)

| Agents | Detected | Used bait | Controls flagged |
|---|---|---|---|
| plain | 9 / 9 | 6 (all recon and data sessions) | 0 / 3 |
| hardened | 4 / 9 | 3 | 0 / 3 |

Hardened agents were caught mostly through the error-message lure (3 of 4). The ones missed read the planted text and declined it.

## Tests

`npm test` — no network beyond loopback, no model calls.
