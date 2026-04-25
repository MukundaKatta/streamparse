# streamparse

[![npm](https://img.shields.io/npm/v/@mukundakatta/streamparse.svg)](https://www.npmjs.com/package/@mukundakatta/streamparse)
[![tests](https://img.shields.io/badge/tests-64%20passing-brightgreen.svg)](#)
[![zero deps](https://img.shields.io/badge/dependencies-0-blue.svg)](#)
[![types](https://img.shields.io/badge/types-included-blue.svg)](#)

A streaming JSON parser that yields **partial valid trees** as tokens arrive.

Built for LLM tool-call payloads, structured-output streams, and any place a
regular `JSON.parse` waits too long.

```ts
import { JsonStreamParser } from '@mukundakatta/streamparse';

const parser = new JsonStreamParser();

parser.push('{"name":"Cl');
parser.snapshot().value;   // => { name: 'Cl' }

parser.push('aude","tools":[1,2');
parser.snapshot().value;   // => { name: 'Claude', tools: [1, 2] }

parser.push(']}');
parser.end();
parser.snapshot().complete; // => true
```

Every snapshot is **valid JSON** thanks to synthetic closure of in-progress
strings, numbers, and containers. Render it directly. Persist it. Round-trip
it through `JSON.parse(JSON.stringify(...))`. It just works.

## Why this exists

Every agent framework ships its own broken version of this. They either:

1. Wait for the full payload and feel slow, or
2. Hand-roll partial JSON repair that fails on common LLM-isms, or
3. Use `JSON.parse` in a try/catch on a growing buffer, which is O(n²) and
   throws useless errors until the very last chunk arrives.

`streamparse` is the version you should reuse.

## Install

```bash
npm install @mukundakatta/streamparse        # library
npm install -g @mukundakatta/streamparse     # also installs `streamparse` CLI
brew install mukundakatta/tools/streamparse  # via Homebrew tap
```

Zero runtime dependencies. ESM only. Node 18+. Works in the browser.

## CLI

```bash
echo '{"name":"Cl' | streamparse parse -
# { "name": "Cl" }

streamparse extract response.txt    # strip prose / fences / comments
streamparse validate config.json    # strict-mode RFC 8259 validation
streamparse --help
```

## API

### `new JsonStreamParser(options?)`

```ts
interface ParserOptions {
  lenient?: boolean;       // default true
  maxDepth?: number;       // default 256
  maxStringLength?: number;// default Infinity
}
```

**Lenient mode** (default) tolerates the LLM-isms you actually see in the
wild:

- trailing commas: `{"a": 1,}`
- single-quoted strings: `{'a': 'hi'}`
- unquoted keys: `{a: 1, b: 2}`
- ` ```json ` code fences
- `// line` and `/* block */` comments
- prose before/after the JSON: `Sure! Here it is: {...}`

Set `lenient: false` for strict RFC 8259 mode.

### `parser.push(chunk: string): void`

Feed in more bytes. Safe to call any number of times.

### `parser.end(): void`

Tell the parser the input is complete. In strict mode, an unfinished value
errors. In lenient mode, open containers and dropped keys are closed silently.

### `parser.snapshot(): Snapshot`

Take a snapshot of the current parse state. Always returns valid JSON.

```ts
interface Snapshot {
  value: JsonValue | undefined; // synthetically closed, always valid
  complete: boolean;            // did the input contain a full top-level value?
  path: ReadonlyArray<string|number>; // cursor location
  bytesIn: number;
  confidence: number;           // 0..1, drops while inside scratch
}
```

### `parser.on(event, fn): unsubscribe`

Subscribe to events:

| event       | payload                                  | when                                  |
| ----------- | ---------------------------------------- | ------------------------------------- |
| `field`     | `(path, value)`                          | on every leaf commit                  |
| `container` | `(path, value)`                          | on every `{}` or `[]` close           |
| `partial`   | `(snapshot)`                             | on every `push()`                     |
| `complete`  | `(value)`                                | once, when the top-level value closes |
| `error`     | `(err)`                                  | on syntax error (suppresses throw)    |

### `parsePartial(input, opts?): JsonValue | undefined`

One-shot helper for a possibly-truncated blob.

```ts
import { parsePartial } from '@mukundakatta/streamparse';

const truncated = '{"type":"tool_use","name":"edit","input":{"path":"a/b.ts","cont';
parsePartial(truncated);
// => { type: 'tool_use', name: 'edit', input: { path: 'a/b.ts', cont: null } }
```

### `streamSnapshots(input, opts?): AsyncIterable<Snapshot>`

Pipe an async iterable of strings or `Uint8Array` straight into snapshots.

```ts
const res = await fetch('/agent/run');
for await (const snap of streamSnapshots(res.body!)) {
  ui.render(snap.value);
}
```

## Real-world examples

### Render a tool-call as it arrives from the model

```ts
import { JsonStreamParser } from '@mukundakatta/streamparse';

const parser = new JsonStreamParser();
parser.on('partial', (snap) => {
  const args = (snap.value as any)?.input;
  if (args) ui.updateArgs(args);
});

for await (const chunk of model.stream(prompt)) {
  parser.push(chunk.text);
}
parser.end();
```

### Recover a dropped Anthropic tool call

```ts
import { parsePartial } from '@mukundakatta/streamparse';

// The connection dropped before the model finished writing its tool call.
const partial = '{"type":"tool_use","name":"edit_file","input":{"path":"a.ts","patches":[{"line":10,"op":"insert","content":"console.log(';

const value = parsePartial(partial);
// value.input.patches[0] is fully usable; the truncated content string ends
// where the stream cut off, so you can still inspect line and op.
```

### Stream `event` lines from an SSE response

```ts
const parser = new JsonStreamParser();
parser.on('field', (path, value) => {
  if (path.length === 2 && path[0] === 'events') {
    handleEvent(value);
  }
});
for await (const line of sseLines(res)) {
  parser.push(line);
}
parser.end();
```

## Performance

On a 50-patch tool-call payload (~8.7 KB):

```
JSON.parse                                          0.025 ms/op
streamparse strict                                  0.170 ms/op   (6.8x)
streamparse lenient                                 0.173 ms/op   (6.9x)
```

That's the cost of being mid-stream-friendly and lenient.

For the streaming use case (35 chunks, snapshot per chunk):

```
streamparse + snapshot per chunk                    0.81 ms/op
buffer-then-JSON.parse (try/catch loop)             1.00 ms/op
```

`streamparse` is faster *and* gives a usable tree from the very first chunk.
The naive approach only succeeds at the last one.

Run benchmarks yourself:

```bash
npm run bench
```

## Comparison

|                                | `JSON.parse` | `partial-json` | naive try/catch | **streamparse** |
| ------------------------------ | :----------: | :------------: | :-------------: | :-------------: |
| Full-document parse            |      ✅       |       ✅        |        ✅        |        ✅        |
| Partial tree mid-stream        |      ❌       |       ⚠️       |        ❌        |        ✅        |
| Snapshot is round-trippable    |      —       |       ⚠️       |        —        |        ✅        |
| Trailing commas                |      ❌       |       ✅        |        ❌        |        ✅        |
| Single quotes / unquoted keys  |      ❌       |       ❌        |        ❌        |        ✅        |
| Code fences / prose stripping  |      ❌       |       ❌        |        ❌        |        ✅        |
| Path tracking                  |      ❌       |       ❌        |        ❌        |        ✅        |
| Events on each leaf            |      ❌       |       ❌        |        ❌        |        ✅        |
| Strict mode                    |      ✅       |       —        |        ✅        |        ✅        |
| Zero dependencies              |      ✅       |       ✅        |        ✅        |        ✅        |

## Design

- Single-pass, byte-driven state machine. No buffering of the whole document.
- Tree mutated in place. Snapshot does an O(n) deep clone with scratch patched
  in, so callers get a stable, valid value to render.
- 64 tests covering correctness, streaming, lenient repairs, events, limits.

## License

MIT, by [Mukunda Katta](https://github.com/MukundaKatta).
