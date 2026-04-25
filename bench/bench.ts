/**
 * Tiny benchmark. Run with: `npm run bench`.
 *
 * What we measure:
 *   1. Throughput vs JSON.parse on full inputs.
 *   2. Time-to-first-render for a partial tool-call payload streamed at 256 char/chunk.
 *   3. The naive alternative ("buffer until close, then JSON.parse") for comparison.
 */

import { JsonStreamParser } from '../src/index.ts';

function timeit(label: string, iters: number, fn: () => void): number {
  // Warm up.
  for (let i = 0; i < 100; i++) fn();
  const start = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const end = performance.now();
  const ms = end - start;
  const perOp = ms / iters;
  console.log(
    label.padEnd(48),
    (ms.toFixed(2) + 'ms').padStart(10),
    'total',
    (perOp.toFixed(4) + 'ms/op').padStart(14),
  );
  return perOp;
}

// Build a realistic tool-call payload: 50 patches, each with a code snippet.
function buildPayload() {
  const patches = [];
  for (let i = 0; i < 50; i++) {
    patches.push({
      line: i * 10,
      op: i % 2 === 0 ? 'insert' : 'delete',
      content:
        'const value' +
        i +
        ' = compute(' +
        i +
        ', { recursive: true, depth: ' +
        i +
        ' }); // line ' +
        i,
      meta: { confidence: 0.5 + (i % 50) / 100, tags: ['edit', 'auto', 'codegen'] },
    });
  }
  return {
    type: 'tool_use',
    id: 'toolu_01abcdef0123456789',
    name: 'edit_file',
    input: {
      path: 'src/very/deep/nested/path/to/some/file.ts',
      patches,
    },
  };
}

const payload = buildPayload();
const text = JSON.stringify(payload);
console.log('payload size:', text.length, 'chars');
console.log('');

console.log('=== full-document throughput ===');
const ITERS = 1000;
const tBaseline = timeit('JSON.parse', ITERS, () => {
  JSON.parse(text);
});
const tStrict = timeit('streamparse strict', ITERS, () => {
  const p = new JsonStreamParser({ lenient: false });
  p.push(text);
  p.end();
  p.snapshot();
});
const tLenient = timeit('streamparse lenient', ITERS, () => {
  const p = new JsonStreamParser();
  p.push(text);
  p.end();
  p.snapshot();
});
console.log('');
console.log('streamparse vs JSON.parse:', (tStrict / tBaseline).toFixed(2) + 'x slower (strict)');
console.log('                            ', (tLenient / tBaseline).toFixed(2) + 'x slower (lenient)');
console.log('');

console.log('=== streaming, 256-char chunks, partial snapshot per chunk ===');
const chunks: string[] = [];
for (let i = 0; i < text.length; i += 256) chunks.push(text.slice(i, i + 256));
console.log('num chunks:', chunks.length);
const tStreaming = timeit('streamparse + snapshot per chunk', ITERS, () => {
  const p = new JsonStreamParser();
  for (const c of chunks) {
    p.push(c);
    p.snapshot();
  }
  p.end();
});
const tNaive = timeit('buffer-then-JSON.parse (naive)', ITERS, () => {
  let buf = '';
  for (const c of chunks) {
    buf += c;
    try {
      JSON.parse(buf);
    } catch {
      // expected until full
    }
  }
});
console.log('');
console.log(
  'streamparse usable mid-stream;',
  'naive buffer-then-parse only works at the very end.',
);
console.log('time-to-first-valid-tree (TTFV):');
console.log('  streamparse: first chunk (~256 chars in)');
console.log('  naive parse: only at last chunk (' + text.length + ' chars in)');
