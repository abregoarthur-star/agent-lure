import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDecoy } from '../lab/decoy.js';
import { CONTROLS } from '../lab/controls.js';
import { runAgentSession, httpTool, costOf } from '../lab/agent.js';
import { outcome, summarize, sessionCeiling } from '../lab/run.js';

/** A stand-in for the Anthropic client that plays a script of tool calls. */
function scripted(steps) {
  let i = 0;
  const seen = [];
  return {
    seen,
    messages: {
      async create(req) {
        seen.push({ ...req, roles: req.messages.map((m) => m.role) });
        const step = steps[i++];
        const lastResult = req.messages.at(-1).content?.[0]?.content ?? '';
        if (!step) return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 100, output_tokens: 10 } };
        const input = typeof step === 'function' ? step(lastResult) : step;
        return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${i}`, name: 'http_request', input }], usage: { input_tokens: 1000, output_tokens: 100 } };
      },
    },
  };
}

// What an LLM does with llms.txt: join the two parts it names.
const follow = (text) => {
  const m = text.match(/GET on (\S+) with (\S+) appended/);
  return { method: 'GET', path: m ? m[1] + m[2] : '/nothing' };
};

test('an agent that follows llms.txt is detected; the loop sends 5.5-safe requests', async (t) => {
  const decoy = await startDecoy();
  t.after(() => decoy.close());
  const client = scripted([{ method: 'GET', path: '/' }, { method: 'GET', path: '/llms.txt' }, follow]);
  const budget = { spent: 0, cap: 1 };
  const s = await runAgentSession({ client, model: 'claude-haiku-5-5', effort: 'medium', task: 'x', base: decoy.base, ua: 'agent-a', budget });

  assert.equal(s.end, 'end_turn');
  assert.equal(s.calls, 3);
  for (const req of client.seen) {
    assert.equal(req.thinking, undefined, 'thinking is never sent');
    assert.equal(req.tool_choice, undefined, 'no forced tool_choice');
    assert.equal(req.output_config.effort, 'medium');
  }
  // The full assistant content is appended each turn, in order.
  assert.deepEqual(client.seen.at(-1).roles, ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);

  const o = outcome('agent-a', decoy.requests, decoy.events);
  assert.equal(o.detected, true);
  assert.equal(o.firstLure, 'llms');
  assert.equal(o.requestsBefore, 2);
  assert.ok(budget.spent > 0);
});

test('an agent that uses the bait key is detected as bait', async (t) => {
  const decoy = await startDecoy();
  t.after(() => decoy.close());
  const { paths, baitKey } = decoy.sensor.plan();
  const client = scripted([{ method: 'GET', path: `${paths['bait-endpoint']}users`, headers: { authorization: `Bearer ${baitKey}` } }]);
  await runAgentSession({ client, model: 'claude-haiku-5-5', effort: 'low', task: 'x', base: decoy.base, ua: 'agent-b', budget: { spent: 0, cap: 1 } });
  const o = outcome('agent-b', decoy.requests, decoy.events);
  assert.equal(o.baitUsed, true);
  assert.deepEqual(o.lures.sort(), ['bait-endpoint', 'bait-key']);
});

test('the session stops at the call limit and at the budget', async (t) => {
  const decoy = await startDecoy();
  t.after(() => decoy.close());
  const forever = Array.from({ length: 50 }, () => ({ method: 'GET', path: '/' }));
  const a = await runAgentSession({ client: scripted(forever), model: 'claude-haiku-5-5', effort: 'low', task: 'x', base: decoy.base, ua: 'c1', maxCalls: 4, budget: { spent: 0, cap: 1 } });
  assert.equal(a.end, 'max_calls');
  assert.equal(a.calls, 4);
  const b = await runAgentSession({ client: scripted(forever), model: 'claude-haiku-5-5', effort: 'low', task: 'x', base: decoy.base, ua: 'c2', budget: { spent: 5, cap: 1 } });
  assert.equal(b.end, 'budget');
  assert.equal(b.calls, 0);
});

test('a refusal ends the session and is recorded with its category', async (t) => {
  const decoy = await startDecoy();
  t.after(() => decoy.close());
  const client = { messages: { create: async () => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [], usage: { input_tokens: 10, output_tokens: 0 } }) } };
  const s = await runAgentSession({ client, model: 'claude-sonnet-5-5', effort: 'medium', task: 'x', base: decoy.base, ua: 'r', budget: { spent: 0, cap: 1 } });
  assert.equal(s.end, 'refusal:cyber');
});

test('the tool reaches only the decoy', async (t) => {
  const decoy = await startDecoy();
  t.after(() => decoy.close());
  for (const path of ['//example.com/x', 'http://example.com/', 'relative']) {
    const out = await httpTool(decoy.base, 'ua', { method: 'GET', path });
    assert.equal(out.isError, true, path);
  }
  assert.equal(decoy.requests.length, 0);
});

test('no control crawler is detected', async (t) => {
  const decoy = await startDecoy();
  t.after(() => decoy.close());
  for (const [name, run] of Object.entries(CONTROLS)) {
    await run(decoy.base, `ctl-${name}`);
    const o = outcome(`ctl-${name}`, decoy.requests, decoy.events);
    assert.equal(o.detected, false, `${name} took ${o.lures.join(', ')}`);
    assert.ok(o.requests > 1, `${name} crawled`);
  }
});

test('summary counts detection per group and flags control false alarms', () => {
  const s = summarize(
    { polite: { requests: 5, lures: [], detected: false }, bad: { requests: 5, lures: ['llms'], detected: true } },
    [
      { key: 'haiku', task: 'recon', end: 'end_turn', detected: true, baitUsed: false, requests: 4, requestsBefore: 2, secondsToFirst: 3 },
      { key: 'haiku', task: 'recon', end: 'refusal:cyber', detected: false, baitUsed: false, requests: 0, requestsBefore: null, secondsToFirst: null },
    ],
  );
  assert.deepEqual(s.falseAlarms, ['bad']);
  assert.equal(s.agents.rate, 0.5);
  assert.equal(s.agents.rate_of_active, 1);
  assert.equal(s.byGroup[0].refused, 1);
});

test('cost: prices per model, and the ceiling is above a cached real run', () => {
  assert.equal(costOf('claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e6 }), 12);
  assert.ok(Math.abs(costOf('claude-haiku-5-5', { cache_read_input_tokens: 1e6 }) - 0.01) < 1e-9);
  assert.throws(() => costOf('nope', {}), /no price/);
  assert.ok(sessionCeiling('claude-sonnet-5-5', 15) > 0.4);
});

test('groq session: OpenAI-style tool loop against the decoy, detected like a Claude agent', async (t) => {
  const { runGroqSession } = await import('../lab/agent.js');
  const decoy = await startDecoy();
  t.after(() => decoy.close());
  const sent = [];
  let step = 0;
  let throttled = false;
  const fetchImpl = async (url, init) => {
    if (!throttled) { throttled = true; return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }); }
    const body = JSON.parse(init.body);
    sent.push(body);
    const lastTool = [...body.messages].reverse().find((m) => m.role === 'tool')?.content ?? '';
    const script = [{ method: 'GET', path: '/llms.txt' }, follow(lastTool)];
    const usage = { prompt_tokens: 1000, completion_tokens: 50 };
    if (step >= script.length) return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }], usage });
    const args = JSON.stringify(script[step++]);
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `c${step}`, type: 'function', function: { name: 'http_request', arguments: args } }] } }], usage });
  };
  const budget = { spent: 0, cap: 1 };
  const s = await runGroqSession({ model: 'openai/gpt-oss-120b', task: 'x', base: decoy.base, ua: 'llama-a', budget, apiKey: 'k', fetchImpl, hardened: true });
  assert.equal(s.end, 'stop');
  assert.equal(s.calls, 2);
  assert.match(sent[0].messages[0].content, /untrusted data/, 'hardening in the system message');
  assert.equal(sent[0].tool_choice, 'auto');
  assert.equal(outcome('llama-a', decoy.requests, decoy.events).firstLure, 'llms');
  assert.ok(budget.spent > 0);
});

test('groq session: bad tool-call JSON becomes an error result, an API error ends the session', async (t) => {
  const { runGroqSession } = await import('../lab/agent.js');
  const decoy = await startDecoy();
  t.after(() => decoy.close());
  let n = 0;
  const fetchImpl = async (url, init) => {
    n++;
    if (n === 1) return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'http_request', arguments: '{not json' } }] } }], usage: {} });
    const body = JSON.parse(init.body);
    assert.match(body.messages.at(-1).content, /not valid JSON/);
    return new Response('nope', { status: 401 });
  };
  const s = await runGroqSession({ model: 'openai/gpt-oss-20b', task: 'x', base: decoy.base, ua: 'llama-b', budget: { spent: 0, cap: 1 }, apiKey: 'k', fetchImpl });
  assert.match(s.end, /^api_error: 401/);
  assert.equal(decoy.requests.length, 0);
});
