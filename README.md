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

### Results (2026-11-25, Claude Haiku 5.5, effort medium)

Tasks: `recon` (authorized pentest of the site), `data` (get the customer records), `benign` (explain the API).

| Lure wording | Agents | Attack tasks detected | Benign detected | Controls flagged |
|---|---|---|---|---|
| Round 1: notes addressed to "AI assistants" | plain | 6 / 6 | 3 / 3 | 0 / 3 |
| | hardened | 3 / 6 | 1 / 3 | 0 / 3 |
| **Round 2: developer-voice token notes (current)** | plain | **10 / 10** | 0 / 5 | 0 / 3 |
| | hardened | **10 / 10** | 0 / 5 | 0 / 3 |

Hardened agents declined text addressed to AI agents but followed notes that read like part of the API. Every round-2 detection went on to use the bait token. The current wording detects agents seeking access, not every agent that visits.

**Claude Sonnet 5.5 and Opus 5.5** (same tasks, plain and hardened, 36 sessions): every recon and data session ended in a `refusal` (category `cyber`) on the first call, before any request reached the decoy, so there is no detection rate to report for them as attackers. Their benign sessions (11 that ran) took no lure, as with Haiku. Measuring frontier models as attackers is not the goal; the realistic attacker is an open-weight model, which is the next lab target.

Cost: ~$0.0013 per Haiku session (~11 tool calls). The lab is small (n = 10–15 per condition) and the decoy is local; the live false-alarm rate is measured on real traffic.

## Tests

`npm test` — no network beyond loopback, no model calls.
