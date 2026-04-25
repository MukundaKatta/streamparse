import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonStreamParser, parsePartial } from '../src/index.ts';

// --- correctness vs JSON.parse on full inputs -----------------------------

const VALID_INPUTS: unknown[] = [
  null,
  true,
  false,
  0,
  1,
  -1,
  3.14,
  -2.5e-3,
  1e10,
  '',
  'hello',
  'with "quotes"',
  'with \\backslash',
  'tab\there',
  'unicode ☃ snowman',
  [],
  [1, 2, 3],
  [null, true, false],
  ['a', 'b', 'c'],
  {},
  { a: 1 },
  { a: 1, b: 'two', c: true, d: null },
  { nested: { deep: { deeper: [1, [2, [3, [4]]]] } } },
  // a tool-call shaped payload
  {
    type: 'tool_use',
    id: 'toolu_01abc',
    name: 'edit_file',
    input: {
      path: 'src/foo.ts',
      patches: [
        { line: 10, op: 'insert', content: 'console.log("hi")' },
        { line: 20, op: 'delete' },
      ],
    },
  },
];

for (const v of VALID_INPUTS) {
  test(`full parse matches JSON.parse for ${JSON.stringify(v).slice(0, 60)}`, () => {
    const text = JSON.stringify(v);
    const p = new JsonStreamParser();
    p.push(text);
    p.end();
    const snap = p.snapshot();
    assert.equal(snap.complete, true);
    assert.deepEqual(snap.value, v);
    assert.equal(snap.confidence, 1);
  });
}

// --- chunked streaming: every split should produce same final value -----

test('chunked input by every byte boundary still parses correctly', () => {
  const v = {
    type: 'tool_use',
    id: 'toolu_01',
    name: 'edit',
    input: { path: 'a/b.ts', changes: [1, 2, 3], on: true, off: null },
  };
  const text = JSON.stringify(v);
  for (let split = 1; split < text.length; split++) {
    const p = new JsonStreamParser();
    p.push(text.slice(0, split));
    p.push(text.slice(split));
    p.end();
    const snap = p.snapshot();
    assert.deepEqual(snap.value, v, `split @ ${split}`);
    assert.equal(snap.complete, true, `split @ ${split}`);
  }
});

test('one byte at a time still parses correctly', () => {
  const v = { items: [{ id: 1, tags: ['a', 'b'] }, { id: 2, tags: [] }] };
  const text = JSON.stringify(v);
  const p = new JsonStreamParser();
  for (const ch of text) p.push(ch);
  p.end();
  assert.deepEqual(p.snapshot().value, v);
  assert.equal(p.snapshot().complete, true);
});

// --- partial snapshots ---------------------------------------------------

test('partial snapshot of an in-progress string', () => {
  const p = new JsonStreamParser();
  p.push('{"name":"Cl');
  const snap = p.snapshot();
  assert.deepEqual(snap.value, { name: 'Cl' });
  assert.equal(snap.complete, false);
  assert.deepEqual(snap.path, ['name']);
});

test('partial snapshot of an in-progress number', () => {
  const p = new JsonStreamParser();
  p.push('{"n":12.3');
  const snap = p.snapshot();
  assert.deepEqual(snap.value, { n: 12.3 });
  assert.equal(snap.complete, false);
});

test('partial snapshot of nested arrays and objects', () => {
  const p = new JsonStreamParser();
  p.push('{"a":[1,2,{"b":[3,4');
  const snap = p.snapshot();
  assert.deepEqual(snap.value, { a: [1, 2, { b: [3, 4] }] });
  assert.equal(snap.complete, false);
});

test('partial snapshot of a partially-parsed key', () => {
  const p = new JsonStreamParser();
  p.push('{"nam');
  const snap = p.snapshot();
  // We render a partial key with a placeholder null value.
  assert.deepEqual(snap.value, { nam: null });
  assert.equal(snap.complete, false);
});

test('partial snapshot inside a deep array', () => {
  const p = new JsonStreamParser();
  p.push('[1,2,3,4,5,6,7,8,9,1');
  const snap = p.snapshot();
  assert.deepEqual(snap.value, [1, 2, 3, 4, 5, 6, 7, 8, 9, 1]);
  assert.equal(snap.complete, false);
});

test('confidence drops while inside scratch and recovers at completion', () => {
  const p = new JsonStreamParser();
  p.push('{"a":"hel');
  const mid = p.snapshot();
  p.push('lo"}');
  p.end();
  const done = p.snapshot();
  assert.ok(mid.confidence < 1);
  assert.equal(done.confidence, 1);
});

// --- lenient repairs -----------------------------------------------------

test('lenient: trailing comma in object', () => {
  assert.deepEqual(parsePartial('{"a":1,"b":2,}'), { a: 1, b: 2 });
});

test('lenient: trailing comma in array', () => {
  assert.deepEqual(parsePartial('[1,2,3,]'), [1, 2, 3]);
});

test('lenient: single quotes', () => {
  assert.deepEqual(parsePartial("{'a': 'hi'}"), { a: 'hi' });
});

test('lenient: unquoted keys', () => {
  assert.deepEqual(parsePartial('{a: 1, b: 2}'), { a: 1, b: 2 });
});

test('lenient: prose before JSON', () => {
  assert.deepEqual(
    parsePartial('Sure! Here is the JSON:\n```json\n{"ok":true}\n```'),
    { ok: true },
  );
});

test('lenient: line comments', () => {
  assert.deepEqual(parsePartial('{\n  // this is a comment\n  "a": 1\n}'), { a: 1 });
});

test('lenient: block comments', () => {
  assert.deepEqual(parsePartial('{ /* block */ "a": 1 /* trailing */ }'), { a: 1 });
});

test('lenient end(): closes open containers', () => {
  const p = new JsonStreamParser();
  p.push('{"a":[1,2,{"b":');
  p.end();
  const snap = p.snapshot();
  assert.equal(snap.complete, true);
  // The inner object had a key without value; the key gets dropped.
  assert.deepEqual(snap.value, { a: [1, 2, {}] });
});

test('lenient: unicode escapes', () => {
  assert.deepEqual(parsePartial('"\\u2603"'), '☃');
});

test('lenient: surrogate pair', () => {
  assert.deepEqual(parsePartial('"\\uD83D\\uDE80"'), '🚀');
});

// --- strict mode ---------------------------------------------------------

test('strict: trailing comma is an error', () => {
  const p = new JsonStreamParser({ lenient: false });
  assert.throws(() => p.push('[1,2,]'));
});

test('strict: single quotes are an error', () => {
  const p = new JsonStreamParser({ lenient: false });
  assert.throws(() => p.push("'hi'"));
});

test('strict: unknown literal fails fast', () => {
  const p = new JsonStreamParser({ lenient: false });
  assert.throws(() => p.push('truex'));
});

// --- limits --------------------------------------------------------------

test('maxDepth is enforced', () => {
  const p = new JsonStreamParser({ maxDepth: 3 });
  assert.throws(() => p.push('[[[[[1]]]]]'));
});

test('maxStringLength is enforced', () => {
  const p = new JsonStreamParser({ maxStringLength: 5 });
  assert.throws(() => p.push('"123456"'));
});

// --- events --------------------------------------------------------------

test('emits field events for leaves', () => {
  const events: Array<[(string | number)[], unknown]> = [];
  const p = new JsonStreamParser();
  p.on('field', (path, value) => events.push([path.slice(), value]));
  p.push('{"a":1,"b":[true,null]}');
  p.end();
  // Order: a=1, then [true, null] inside b. b's container event fires separately.
  const leafKinds = events.map(([, v]) => v);
  assert.deepEqual(leafKinds, [1, true, null]);
});

test('emits container events for objects/arrays', () => {
  const containers: Array<unknown> = [];
  const p = new JsonStreamParser();
  p.on('container', (_path, value) => containers.push(value));
  p.push('{"a":[1,2],"b":{"c":3}}');
  p.end();
  // We expect: inner array, inner object, then outer object.
  assert.equal(containers.length, 3);
});

test('emits complete event exactly once', () => {
  let count = 0;
  const p = new JsonStreamParser();
  p.on('complete', () => count++);
  p.push('{"x":1}');
  p.end();
  assert.equal(count, 1);
});

test('emits partial events on each push', () => {
  let n = 0;
  const p = new JsonStreamParser();
  p.on('partial', () => n++);
  p.push('{"a"');
  p.push(':1}');
  assert.equal(n, 2);
});

test('error event suppresses throw', () => {
  let saw: Error | null = null;
  const p = new JsonStreamParser({ lenient: false });
  p.on('error', (e) => (saw = e));
  // Should NOT throw because we have a listener.
  p.push("'bad'");
  assert.ok(saw, 'expected error to be emitted');
});

// --- parsePartial --------------------------------------------------------

test('parsePartial recovers from truncated tool call', () => {
  const truncated = '{"type":"tool_use","name":"edit","input":{"path":"a/b.ts","cont';
  const result = parsePartial(truncated) as Record<string, unknown>;
  assert.equal(result.type, 'tool_use');
  assert.equal(result.name, 'edit');
  assert.deepEqual(result.input, { path: 'a/b.ts', cont: null });
});

test('parsePartial returns undefined on empty input', () => {
  assert.equal(parsePartial(''), undefined);
});

test('parsePartial returns undefined on pure prose with no json', () => {
  assert.equal(parsePartial('hello world this has no json'), undefined);
});

// --- top-level scalar streaming -----------------------------------------

test('streaming a top-level number', () => {
  const p = new JsonStreamParser();
  p.push('123');
  // Number isn't committed until we hit a non-number byte or end().
  p.end();
  assert.equal(p.snapshot().value, 123);
});

test('streaming a top-level string', () => {
  const p = new JsonStreamParser();
  p.push('"he');
  assert.equal(p.snapshot().value, 'he');
  p.push('llo"');
  p.end();
  assert.equal(p.snapshot().value, 'hello');
});

test('streaming a top-level literal', () => {
  const p = new JsonStreamParser();
  p.push('tr');
  assert.equal(p.snapshot().value, null); // partial literal coerces to null
  p.push('ue');
  p.end();
  assert.equal(p.snapshot().value, true);
});
