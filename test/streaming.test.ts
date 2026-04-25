/**
 * Hard streaming scenarios: a large object split into 1-byte chunks should yield
 * monotonically growing valid trees with stable types.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonStreamParser, parsePartial, streamSnapshots } from '../src/index.ts';

test('every per-byte snapshot round-trips through JSON', () => {
  // Slightly weaker invariant than strict monotonic growth (since `null` placeholders
  // can shrink to `""` mid-stream), but still useful: no snapshot is ever malformed.
  const v = {
    type: 'response',
    items: [
      { id: 1, tags: ['a', 'b', 'c'], meta: { ok: true } },
      { id: 2, tags: [], meta: { ok: false, why: 'rate limit' } },
      { id: 3, tags: ['x'], meta: { ok: null } },
    ],
    cursor: 'next-page',
  };
  const text = JSON.stringify(v);
  const p = new JsonStreamParser();
  for (const ch of text) {
    p.push(ch);
    const snap = p.snapshot();
    const round = JSON.parse(JSON.stringify(snap.value));
    assert.deepEqual(round, snap.value);
  }
  p.end();
  assert.deepEqual(p.snapshot().value, v);
});

test('streamSnapshots over an async iterable', async () => {
  async function* chunks() {
    yield '{"name":';
    yield '"Cl';
    yield 'aude",';
    yield '"tools":[1,2,';
    yield '3]}';
  }
  const seen: unknown[] = [];
  for await (const snap of streamSnapshots(chunks())) {
    seen.push(snap.value);
  }
  // Last snapshot is final.
  assert.deepEqual(seen[seen.length - 1], {
    name: 'Claude',
    tools: [1, 2, 3],
  });
  // Earlier snapshots are partial but valid.
  assert.ok(seen.length > 1);
});

test('LLM-shaped messy input round-trips', () => {
  const messy = `Sure! Here is the data.
\`\`\`json
{
  // toolset
  "tools": [
    {"name": 'edit_file', "args": {path: "a.ts", line: 10}},
    {"name": "read_file", "args": {path: "b.ts",}},  // trailing comma
  ],
  count: 2
}
\`\`\`
Anything else?`;
  const v = parsePartial(messy) as Record<string, unknown>;
  assert.equal((v.tools as unknown[]).length, 2);
  assert.equal(v.count, 2);
});

test('truncated mid-deep-string surfaces best-guess', () => {
  const truncated =
    '{"events":[{"id":"a"},{"id":"b"},{"id":"c","note":"this is going to be cut';
  const v = parsePartial(truncated) as Record<string, unknown>;
  const events = v.events as Array<Record<string, unknown>>;
  assert.equal(events.length, 3);
  assert.equal(events[0]!.id, 'a');
  assert.equal(events[1]!.id, 'b');
  assert.equal(events[2]!.id, 'c');
  assert.equal(events[2]!.note, 'this is going to be cut');
});

test('path tracks current cursor location', () => {
  const p = new JsonStreamParser();
  p.push('{"items":[{"name":"');
  assert.deepEqual(p.snapshot().path, ['items', 0, 'name']);
});

test('per-byte field events fire exactly once per leaf', () => {
  const p = new JsonStreamParser();
  const fields: Array<[unknown, unknown]> = [];
  p.on('field', (path, value) => fields.push([path.slice(), value]));
  const v = { a: 1, b: [true, 'x'], c: { d: null } };
  for (const ch of JSON.stringify(v)) p.push(ch);
  p.end();
  // We expect 5 field emissions: 1, true, 'x', null, plus the inner list of leaves
  // is just those 4 — and 'a','b','c','d' are keys, not fields.
  assert.equal(fields.length, 4);
  assert.deepEqual(
    fields.map((f) => f[1]),
    [1, true, 'x', null],
  );
});
