/**
 * Example: render an LLM tool call as it streams in.
 *
 * Simulates a chunked stream of an Anthropic-shaped tool_use block.
 *
 *   $ npx tsx examples/tool-call.ts
 */

import { JsonStreamParser } from '../src/index.ts';

const fullPayload = JSON.stringify({
  type: 'tool_use',
  id: 'toolu_01abc',
  name: 'edit_file',
  input: {
    path: 'src/auth/jwt.ts',
    patches: [
      {
        line: 42,
        op: 'replace',
        before: 'const token = sign(payload, secret);',
        after: "const token = sign(payload, secret, { expiresIn: '1h' });",
      },
      {
        line: 58,
        op: 'insert',
        content: '  // Validate audience matches our issuer.',
      },
    ],
  },
});

// Simulate chunked delivery from an SSE / streaming endpoint.
function* chunked(text: string, sizes: number[]) {
  let i = 0;
  for (const size of sizes) {
    yield text.slice(i, i + size);
    i += size;
  }
  if (i < text.length) yield text.slice(i);
}

const parser = new JsonStreamParser();

parser.on('field', (path, value) => {
  if (path.length === 1 && path[0] === 'name') {
    console.log('-> tool selected:', value);
  }
  if (path[0] === 'input' && path[1] === 'path') {
    console.log('-> editing:', value);
  }
  if (path[0] === 'input' && path[1] === 'patches' && typeof path[2] === 'number' && path[3] === 'line') {
    console.log('-> patch #' + path[2] + ' targets line', value);
  }
});

parser.on('partial', (snap) => {
  const v = snap.value as any;
  const numPatches = v?.input?.patches?.length ?? 0;
  if (numPatches > 0) {
    process.stdout.write('\r   patches so far: ' + numPatches + '   ');
  }
});

console.log('streaming...');
for (const chunk of chunked(fullPayload, [40, 80, 120, 200, 400, 800, 1500])) {
  parser.push(chunk);
}
parser.end();

console.log('\n');
console.log('final value:');
console.log(JSON.stringify(parser.snapshot().value, null, 2));
