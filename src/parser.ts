/**
 * Streaming JSON parser with partial snapshots.
 *
 * Design notes:
 *
 *   - Single-pass, byte-driven state machine. We do not buffer whole-document; we
 *     incrementally extend the parse tree as bytes arrive.
 *
 *   - The tree is mutated in place inside `root`. Object frames carry a pendingKey;
 *     once a value is parsed, it is committed to the parent immediately. Strings
 *     and numbers under construction live in scratch fields and are committed when
 *     terminated. snapshot() takes a deep clone of the in-progress tree and patches
 *     scratch values into it before returning, so the caller can render mid-stream
 *     without waiting for boundaries.
 *
 *   - Lenient mode handles a small but important set of LLM-isms:
 *       trailing commas, single-quoted strings, unquoted keys, ```json fences,
 *       JavaScript-style line/block comments, and stray prose before/after the JSON.
 *
 *   - Snapshot is O(n) in tree size. It is not free, but is cheap relative to the
 *     parse step itself for typical tool-call payloads.
 */

import type {
  JsonPath,
  JsonValue,
  ParserEvents,
  ParserOptions,
  Snapshot,
} from './types.js';

type Container =
  | {
      kind: 'object';
      obj: Record<string, JsonValue>;
      pendingKey: string | null;
    }
  | { kind: 'array'; arr: JsonValue[] };

type State =
  | 'pre-root'
  | 'value'
  | 'string'
  | 'string-esc'
  | 'string-uXXXX'
  | 'number'
  | 'literal'
  | 'key-or-end'
  | 'unquoted-key'
  | 'colon'
  | 'comma-or-end'
  | 'done'
  | 'errored';

const HEX = /[0-9a-fA-F]/;

const LITERALS: Record<string, JsonValue> = {
  true: true,
  false: false,
  null: null,
};

type Listener<E extends keyof ParserEvents> = ParserEvents[E];

/**
 * Streaming JSON parser. Push bytes in, get partial valid trees out.
 */
export class JsonStreamParser {
  private state: State = 'pre-root';
  private stack: Container[] = [];
  private root: JsonValue | undefined = undefined;
  private rootSet = false;

  private str = '';
  private strQuote: '"' | "'" = '"';
  private num = '';
  private lit = '';
  private uHex = '';
  private highSurrogate: number | null = null;

  private bytesIn = 0;
  private path: (string | number)[] = [];

  private listeners: { [K in keyof ParserEvents]?: Listener<K>[] } = {};

  private readonly lenient: boolean;
  private readonly maxDepth: number;
  private readonly maxStringLength: number;

  private _commentStart = false;
  private _sawAsterisk = false;
  private commentMode: 'none' | 'line' | 'block' = 'none';
  /**
   * Set true once we've skipped a non-JSON, non-whitespace, non-fence char in pre-root.
   * After that point we require an obvious JSON opener ({, [, ", ') to enter the parse,
   * because a stray bare letter is more likely the next word of prose than the start of
   * `null` or `true`.
   */
  private _proseSeen = false;

  constructor(opts: ParserOptions = {}) {
    this.lenient = opts.lenient ?? true;
    this.maxDepth = opts.maxDepth ?? 256;
    this.maxStringLength = opts.maxStringLength ?? Number.POSITIVE_INFINITY;
  }

  // --- public API ---------------------------------------------------------

  on<E extends keyof ParserEvents>(event: E, fn: Listener<E>): () => void {
    const arr = ((this.listeners as Record<string, unknown[]>)[event] ??= []) as Listener<E>[];
    arr.push(fn);
    return () => {
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  push(chunk: string): void {
    if (this.state === 'errored') {
      this.bytesIn += chunk.length;
      return;
    }
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i] as string;
      this.bytesIn++;
      try {
        this.step(ch);
      } catch (err) {
        this.fail((err as Error).message);
        return;
      }
      if ((this.state as State) === 'errored') return;
    }
    this.emitPartial();
  }

  end(): void {
    if (this.state === 'errored') return;

    if (this.state === 'number') this.commitNumber();
    if (this.state === 'literal') this.commitLiteral();

    if (this.state === 'done') {
      this.emitPartial();
      return;
    }

    if (!this.lenient) {
      this.fail('unexpected end of input');
      return;
    }

    while (this.stack.length > 0) {
      const top = this.stack[this.stack.length - 1] as Container;
      if (top.kind === 'object' && top.pendingKey !== null) {
        top.pendingKey = null;
      }
      this.popContainer();
    }
    this.state = 'done';
    this.emitPartial();
    if (this.rootSet) this.emit('complete', this.root as JsonValue);
  }

  reset(): void {
    this.state = 'pre-root';
    this.stack = [];
    this.root = undefined;
    this.rootSet = false;
    this.str = '';
    this.num = '';
    this.lit = '';
    this.uHex = '';
    this.highSurrogate = null;
    this.bytesIn = 0;
    this.path = [];
    this._commentStart = false;
    this._sawAsterisk = false;
    this.commentMode = 'none';
    this._proseSeen = false;
  }

  snapshot(): Snapshot {
    const value = this.materialize();
    const complete = this.state === 'done';
    return {
      value,
      complete,
      path: this.path.slice(),
      bytesIn: this.bytesIn,
      confidence: this.computeConfidence(complete),
    };
  }

  // --- core state machine ------------------------------------------------

  private step(ch: string): void {
    if (this.commentMode === 'line') {
      if (ch === '\n') this.commentMode = 'none';
      return;
    }
    if (this.commentMode === 'block') {
      if (this._sawAsterisk && ch === '/') {
        this.commentMode = 'none';
        this._sawAsterisk = false;
      } else {
        this._sawAsterisk = ch === '*';
      }
      return;
    }

    switch (this.state) {
      case 'pre-root':
        return this.stepPreRoot(ch);
      case 'value':
        return this.stepValue(ch);
      case 'string':
        return this.stepString(ch);
      case 'string-esc':
        return this.stepStringEsc(ch);
      case 'string-uXXXX':
        return this.stepStringUHex(ch);
      case 'number':
        return this.stepNumber(ch);
      case 'literal':
        return this.stepLiteral(ch);
      case 'key-or-end':
        return this.stepKeyOrEnd(ch);
      case 'unquoted-key':
        return this.stepUnquotedKey(ch);
      case 'colon':
        return this.stepColon(ch);
      case 'comma-or-end':
        return this.stepCommaOrEnd(ch);
      case 'done':
        return this.stepDone(ch);
      case 'errored':
        return;
    }
  }

  private stepDone(ch: string): void {
    if (isWhitespace(ch)) return;
    if (this.lenient) return; // ignore trailing junk in lenient mode
    this.fail(`unexpected character ${JSON.stringify(ch)} after end of value`);
  }

  private stepPreRoot(ch: string): void {
    if (isWhitespace(ch)) return;
    if (this.lenient) {
      if (this.tryStartComment(ch)) return;
      if (ch === '`') {
        this._proseSeen = true;
        return;
      }
      const isObviousOpener =
        ch === '{' || ch === '[' || ch === '"' || ch === "'";
      if (this._proseSeen) {
        // After prose has been skipped, only obvious openers may resume parsing.
        if (!isObviousOpener) return;
      } else {
        // No prose yet: accept any JSON value starter, including bare scalars.
        if (!isValueStart(ch) && !isObviousOpener) {
          this._proseSeen = true;
          return;
        }
      }
    }
    this.state = 'value';
    this.stepValue(ch);
  }

  private stepValue(ch: string): void {
    if (isWhitespace(ch)) return;
    if (this.lenient && this.tryStartComment(ch)) return;

    if (ch === '{') {
      this.pushContainer({ kind: 'object', obj: {}, pendingKey: null });
      this.state = 'key-or-end';
      return;
    }
    if (ch === '[') {
      this.pushContainer({ kind: 'array', arr: [] });
      this.state = 'value';
      return;
    }
    if (ch === '"' || (this.lenient && ch === "'")) {
      this.str = '';
      this.strQuote = ch as '"' | "'";
      this.state = 'string';
      return;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      this.num = ch;
      this.state = 'number';
      return;
    }
    if (ch === 't' || ch === 'f' || ch === 'n') {
      this.lit = ch;
      this.state = 'literal';
      return;
    }
    if (ch === ']' && this.topIsArray()) {
      // Empty array, or in lenient mode, after a trailing comma. In strict mode this is
      // only legal when the array is still empty.
      if (!this.lenient && this.topArray()!.length > 0) {
        this.fail("unexpected ']' (trailing comma not allowed in strict mode)");
        return;
      }
      this.popContainer();
      this.afterValueCommit();
      return;
    }
    this.fail(`unexpected character ${JSON.stringify(ch)} when expecting a value`);
  }

  private stepString(ch: string): void {
    if (ch === '\\') {
      this.state = 'string-esc';
      return;
    }
    if (ch === this.strQuote) {
      const s = this.str;
      this.str = '';
      this.commitValue(s);
      return;
    }
    if (!this.lenient && ch.charCodeAt(0) < 0x20) {
      this.fail(
        'unescaped control character in string: U+' +
          ch.charCodeAt(0).toString(16).padStart(4, '0'),
      );
      return;
    }
    if (this.str.length >= this.maxStringLength) {
      this.fail('string exceeds maxStringLength');
      return;
    }
    this.str += ch;
  }

  private stepStringEsc(ch: string): void {
    switch (ch) {
      case '"':
      case "'":
      case '\\':
      case '/':
        this.str += ch;
        this.state = 'string';
        return;
      case 'b':
        this.str += '\b';
        this.state = 'string';
        return;
      case 'f':
        this.str += '\f';
        this.state = 'string';
        return;
      case 'n':
        this.str += '\n';
        this.state = 'string';
        return;
      case 'r':
        this.str += '\r';
        this.state = 'string';
        return;
      case 't':
        this.str += '\t';
        this.state = 'string';
        return;
      case 'u':
        this.uHex = '';
        this.state = 'string-uXXXX';
        return;
      default:
        if (this.lenient) {
          this.str += ch;
          this.state = 'string';
          return;
        }
        this.fail('bad string escape \\' + ch);
    }
  }

  private stepStringUHex(ch: string): void {
    if (!HEX.test(ch)) {
      this.fail('bad unicode escape, expected hex digit, got ' + JSON.stringify(ch));
      return;
    }
    this.uHex += ch;
    if (this.uHex.length === 4) {
      const code = parseInt(this.uHex, 16);
      this.uHex = '';
      if (code >= 0xd800 && code <= 0xdbff) {
        this.highSurrogate = code;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        if (this.highSurrogate !== null) {
          const combined =
            ((this.highSurrogate - 0xd800) << 10) + (code - 0xdc00) + 0x10000;
          this.str += String.fromCodePoint(combined);
          this.highSurrogate = null;
        } else {
          if (this.lenient) this.str += '�';
          else this.fail('lone low surrogate');
        }
      } else {
        this.str += String.fromCharCode(code);
        this.highSurrogate = null;
      }
      this.state = 'string';
    }
  }

  private stepNumber(ch: string): void {
    if (
      (ch >= '0' && ch <= '9') ||
      ch === '.' ||
      ch === 'e' ||
      ch === 'E' ||
      ch === '+' ||
      ch === '-'
    ) {
      this.num += ch;
      return;
    }
    this.commitNumber();
    this.step(ch);
  }

  private stepLiteral(ch: string): void {
    this.lit += ch;
    if (this.lit === 'true' || this.lit === 'false' || this.lit === 'null') {
      this.commitLiteral();
      return;
    }
    if (
      !'true'.startsWith(this.lit) &&
      !'false'.startsWith(this.lit) &&
      !'null'.startsWith(this.lit)
    ) {
      this.fail('unknown literal: ' + JSON.stringify(this.lit));
    }
  }

  private stepKeyOrEnd(ch: string): void {
    if (isWhitespace(ch)) return;
    if (this.lenient && this.tryStartComment(ch)) return;
    if (ch === '}') {
      this.popContainer();
      this.afterValueCommit();
      return;
    }
    if (ch === '"' || (this.lenient && ch === "'")) {
      this.str = '';
      this.strQuote = ch as '"' | "'";
      this.state = 'string';
      return;
    }
    if (this.lenient && /[A-Za-z_$]/.test(ch)) {
      this.str = ch;
      this.state = 'unquoted-key';
      return;
    }
    this.fail(
      'unexpected character ' + JSON.stringify(ch) + ' when expecting object key',
    );
  }

  private stepUnquotedKey(ch: string): void {
    if (isWhitespace(ch) || ch === ':' || ch === ',' || ch === '}') {
      const top = this.stack[this.stack.length - 1];
      if (!top || top.kind !== 'object') {
        this.fail('internal: unquoted key without object frame');
        return;
      }
      top.pendingKey = this.str;
      this.path.push(this.str);
      this.str = '';
      this.state = 'colon';
      this.step(ch); // re-feed terminator
      return;
    }
    if (/[A-Za-z0-9_$\-.]/.test(ch)) {
      this.str += ch;
      return;
    }
    this.fail('unexpected character ' + JSON.stringify(ch) + ' in unquoted key');
  }

  private stepColon(ch: string): void {
    if (isWhitespace(ch)) return;
    if (this.lenient && this.tryStartComment(ch)) return;
    if (ch === ':') {
      this.state = 'value';
      return;
    }
    this.fail("expected ':' after object key, got " + JSON.stringify(ch));
  }

  private stepCommaOrEnd(ch: string): void {
    if (isWhitespace(ch)) return;
    if (this.lenient && this.tryStartComment(ch)) return;
    const top = this.stack[this.stack.length - 1];
    if (!top) {
      if (this.lenient) return;
      this.fail('unexpected character ' + JSON.stringify(ch) + ' after end of value');
      return;
    }
    if (ch === ',') {
      if (top.kind === 'object') {
        this.path.pop();
        this.state = 'key-or-end';
      } else {
        this.path.pop();
        this.state = 'value';
      }
      return;
    }
    if (ch === '}' && top.kind === 'object') {
      // Pop the leaf-segment path that was pushed when the last value committed.
      this.path.pop();
      this.popContainer();
      this.afterValueCommit();
      return;
    }
    if (ch === ']' && top.kind === 'array') {
      this.path.pop();
      this.popContainer();
      this.afterValueCommit();
      return;
    }
    if (this.lenient && (ch === '}' || ch === ']')) {
      // Lenient: pop frames until we match. Pop one path segment per leaf-bearing
      // frame we discard (i.e. when we close from comma-or-end state).
      this.path.pop();
      while (this.stack.length > 0) {
        const t = this.stack[this.stack.length - 1] as Container;
        if (
          (ch === '}' && t.kind === 'object') ||
          (ch === ']' && t.kind === 'array')
        ) {
          this.popContainer();
          this.afterValueCommit();
          return;
        }
        this.popContainer();
      }
    }
    this.fail(
      'unexpected character ' + JSON.stringify(ch) + " when expecting ',' or close",
    );
  }

  // --- commits & container management -----------------------------------

  private commitValue(value: JsonValue): void {
    const top = this.stack[this.stack.length - 1];
    if (
      top &&
      top.kind === 'object' &&
      this.state === 'string' &&
      top.pendingKey === null
    ) {
      top.pendingKey = String(value);
      this.path.push(top.pendingKey);
      this.state = 'colon';
      return;
    }
    if (top === undefined) {
      this.root = value;
      this.rootSet = true;
      this.state = 'done';
      this.emit('field', this.path.slice(), value);
      this.emit('complete', value);
      return;
    }
    if (top.kind === 'array') {
      const idx = top.arr.length;
      top.arr.push(value);
      this.path.push(idx);
      this.emit('field', this.path.slice(), value);
      this.state = 'comma-or-end';
      return;
    }
    if (top.pendingKey === null) {
      this.fail('internal: object value without key');
      return;
    }
    top.obj[top.pendingKey] = value;
    this.emit('field', this.path.slice(), value);
    top.pendingKey = null;
    this.state = 'comma-or-end';
  }

  private commitNumber(): void {
    const text = this.num;
    this.num = '';
    if (text === '' || text === '-' || text === '+' || text === '.') {
      this.fail('malformed number: ' + JSON.stringify(text));
      return;
    }
    const n = Number(text);
    if (!Number.isFinite(n)) {
      this.fail('malformed number: ' + JSON.stringify(text));
      return;
    }
    this.commitValue(n);
  }

  private commitLiteral(): void {
    const lit = this.lit;
    this.lit = '';
    if (!(lit in LITERALS)) {
      this.fail('unknown literal: ' + JSON.stringify(lit));
      return;
    }
    this.commitValue(LITERALS[lit] as JsonValue);
  }

  private pushContainer(c: Container): void {
    if (this.stack.length >= this.maxDepth) {
      this.fail('maxDepth ' + this.maxDepth + ' exceeded');
      return;
    }
    const placeholder: JsonValue = c.kind === 'array' ? c.arr : c.obj;
    const parent = this.stack[this.stack.length - 1];
    if (parent === undefined) {
      if (!this.rootSet) {
        this.root = placeholder;
        this.rootSet = true;
      }
    } else if (parent.kind === 'array') {
      const idx = parent.arr.length;
      parent.arr.push(placeholder);
      this.path.push(idx);
    } else {
      if (parent.pendingKey === null) {
        this.fail('internal: container under object without key');
        return;
      }
      parent.obj[parent.pendingKey] = placeholder;
      parent.pendingKey = null;
    }
    this.stack.push(c);
  }

  private popContainer(): void {
    const popped = this.stack.pop();
    if (!popped) return;
    const value: JsonValue = popped.kind === 'array' ? popped.arr : popped.obj;
    this.emit('container', this.path.slice(), value);
  }

  private afterValueCommit(): void {
    if (this.stack.length === 0) {
      this.state = 'done';
      if (this.rootSet) this.emit('complete', this.root as JsonValue);
      return;
    }
    this.state = 'comma-or-end';
  }

  // --- helpers -----------------------------------------------------------

  private topIsArray(): boolean {
    const t = this.stack[this.stack.length - 1];
    return t !== undefined && t.kind === 'array';
  }
  private topArray(): JsonValue[] | null {
    const t = this.stack[this.stack.length - 1];
    return t && t.kind === 'array' ? t.arr : null;
  }

  private tryStartComment(ch: string): boolean {
    // Order matters: handle the "second char after a slash" branch before the
    // "first slash seen" branch, so `//` and `/*` are correctly recognized.
    if (this._commentStart) {
      this._commentStart = false;
      if (ch === '/') {
        this.commentMode = 'line';
        return true;
      }
      if (ch === '*') {
        this.commentMode = 'block';
        return true;
      }
      // Lone slash followed by something else: in lenient mode, consume both as
      // whitespace (the slash and this char).
      return true;
    }
    if (ch === '/') {
      this._commentStart = true;
      return true;
    }
    return false;
  }

  private fail(message: string): void {
    this.state = 'errored';
    const err = new Error('streamparse: ' + message + ' (at byte ' + this.bytesIn + ')');
    if (this.listeners.error && this.listeners.error.length > 0) {
      for (const fn of this.listeners.error) fn(err);
      return;
    }
    throw err;
  }

  private emit<E extends keyof ParserEvents>(
    event: E,
    ...args: Parameters<ParserEvents[E]>
  ): void {
    const list = this.listeners[event];
    if (!list) return;
    for (const fn of list) (fn as (...a: unknown[]) => void)(...args);
  }

  private emitPartial(): void {
    if (!this.listeners.partial || this.listeners.partial.length === 0) return;
    const snap = this.snapshot();
    for (const fn of this.listeners.partial) fn(snap);
  }

  // --- snapshot materialization -----------------------------------------

  private materialize(): JsonValue | undefined {
    if (!this.rootSet) {
      if (this.state === 'string') return this.str;
      if (this.state === 'number') {
        const n = Number(this.num);
        return Number.isFinite(n) ? n : null;
      }
      if (this.state === 'literal') {
        const lit = this.lit;
        if (lit in LITERALS) return LITERALS[lit] as JsonValue;
        return null;
      }
      return undefined;
    }

    const cloned = deepCloneJson(this.root as JsonValue);

    if (
      this.state === 'string' ||
      this.state === 'string-esc' ||
      this.state === 'string-uXXXX'
    ) {
      const top = this.stack[this.stack.length - 1];
      if (top === undefined) return this.str;
      if (top.kind === 'object' && top.pendingKey === null) {
        // Parsing a key: render with placeholder null value.
        const node = walkClone(cloned, this.containerPath());
        if (node && typeof node === 'object' && !Array.isArray(node)) {
          (node as Record<string, JsonValue>)[this.str] = null;
        }
      } else if (top.kind === 'object' && top.pendingKey !== null) {
        const node = walkClone(cloned, this.containerPath());
        if (node && typeof node === 'object' && !Array.isArray(node)) {
          (node as Record<string, JsonValue>)[top.pendingKey] = this.str;
        }
      } else if (top.kind === 'array') {
        const node = walkClone(cloned, this.containerPath());
        if (Array.isArray(node)) {
          (node as JsonValue[]).push(this.str);
        }
      }
    } else if (this.state === 'unquoted-key') {
      const top = this.stack[this.stack.length - 1];
      if (top && top.kind === 'object') {
        const node = walkClone(cloned, this.containerPath());
        if (node && typeof node === 'object' && !Array.isArray(node)) {
          (node as Record<string, JsonValue>)[this.str] = null;
        }
      }
    } else if (this.state === 'colon' || this.state === 'value') {
      // Object has a pendingKey but we haven't started the value yet. Render the slot
      // with null so the snapshot tree never shrinks.
      const top = this.stack[this.stack.length - 1];
      if (top && top.kind === 'object' && top.pendingKey !== null) {
        const node = walkClone(cloned, this.path.slice(0, -1));
        if (node && typeof node === 'object' && !Array.isArray(node)) {
          const r = node as Record<string, JsonValue>;
          if (!(top.pendingKey in r)) r[top.pendingKey] = null;
        }
      }
    } else if (this.state === 'number') {
      const n = Number(this.num);
      const v = Number.isFinite(n) ? n : null;
      this.patchScratchInto(cloned, v);
    } else if (this.state === 'literal') {
      const v = (LITERALS[this.lit] ?? null) as JsonValue;
      this.patchScratchInto(cloned, v);
    }

    return cloned;
  }

  private containerPath(): JsonPath {
    const top = this.stack[this.stack.length - 1];
    if (!top) return [];
    if (top.kind === 'object') {
      if (top.pendingKey === null) return this.path;
      return this.path.slice(0, -1);
    }
    return this.path;
  }

  private patchScratchInto(cloned: JsonValue, value: JsonValue): void {
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) return;
    const parent = walkClone(cloned, this.containerPath());
    if (!parent) return;
    if (Array.isArray(parent)) {
      parent.push(value);
    } else if (top.kind === 'object' && top.pendingKey !== null) {
      (parent as Record<string, JsonValue>)[top.pendingKey] = value;
    }
  }

  private computeConfidence(complete: boolean): number {
    if (complete) return 1;
    let c = 1.0;
    c -= Math.min(0.5, this.stack.length * 0.05);
    if (
      this.state === 'string' ||
      this.state === 'string-esc' ||
      this.state === 'string-uXXXX'
    )
      c -= 0.2;
    if (this.state === 'number') c -= 0.1;
    if (this.state === 'literal') c -= 0.15;
    if (c < 0) c = 0;
    return Number(c.toFixed(3));
  }
}

// --- module-private helpers ----------------------------------------------

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isValueStart(ch: string): boolean {
  return (
    ch === '{' ||
    ch === '[' ||
    ch === '"' ||
    ch === '-' ||
    (ch >= '0' && ch <= '9') ||
    ch === 't' ||
    ch === 'f' ||
    ch === 'n'
  );
}

function deepCloneJson(v: JsonValue): JsonValue {
  if (v === null) return null;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepCloneJson);
  const out: Record<string, JsonValue> = {};
  for (const k of Object.keys(v))
    out[k] = deepCloneJson((v as Record<string, JsonValue>)[k] as JsonValue);
  return out;
}

function walkClone(root: JsonValue, path: JsonPath): JsonValue | undefined {
  let cur: JsonValue = root;
  for (const seg of path) {
    if (cur === null) return undefined;
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return undefined;
      const next = cur[seg];
      if (next === undefined) return undefined;
      cur = next;
    } else {
      if (typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      const next = (cur as Record<string, JsonValue>)[seg];
      if (next === undefined) return undefined;
      cur = next;
    }
  }
  return cur;
}
