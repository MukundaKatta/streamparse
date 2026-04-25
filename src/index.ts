/**
 * streamparse: streaming JSON parser with partial valid trees.
 *
 *   import { JsonStreamParser, parsePartial } from '@mukundakatta/streamparse';
 *
 *   const parser = new JsonStreamParser();
 *   parser.push('{"name":"Cl');
 *   parser.snapshot().value;  // => { name: 'Cl' }
 *   parser.push('aude","tools":[1,2');
 *   parser.snapshot().value;  // => { name: 'Claude', tools: [1, 2] }
 *   parser.push(']}');
 *   parser.end();
 *   parser.snapshot().complete;  // => true
 *
 * Or for one-shot use on a possibly-partial blob:
 *
 *   const value = parsePartial('{"name":"Cl');  // => { name: 'Cl' }
 */

export { JsonStreamParser } from './parser.js';
export type {
  JsonPath,
  JsonValue,
  ParserEvents,
  ParserOptions,
  Snapshot,
} from './types.js';

import { JsonStreamParser } from './parser.js';
import type { JsonValue, ParserOptions } from './types.js';

/**
 * Parse a possibly-partial JSON string and return the best valid tree we can recover.
 * Defaults to lenient mode. Returns undefined if the input is empty or unparseable
 * even after lenient repair.
 */
export function parsePartial(input: string, opts?: ParserOptions): JsonValue | undefined {
  const p = new JsonStreamParser(opts);
  try {
    p.push(input);
  } catch {
    // In lenient mode, push() is unlikely to throw on truncation. If it does, the
    // snapshot we already have is the best we can do.
  }
  return p.snapshot().value;
}

/**
 * Convert an async iterable of strings into an async iterable of snapshots. Useful
 * for piping a fetch() body directly into a UI.
 *
 *   for await (const snap of streamSnapshots(response.body!)) {
 *     ui.render(snap.value);
 *   }
 */
export async function* streamSnapshots(
  input: AsyncIterable<string | Uint8Array>,
  opts?: ParserOptions,
) {
  const p = new JsonStreamParser(opts);
  const dec = new TextDecoder();
  for await (const chunk of input) {
    const s = typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
    p.push(s);
    yield p.snapshot();
  }
  p.end();
  yield p.snapshot();
}
