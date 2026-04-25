/**
 * Public types for streamparse.
 */

/** Any valid JSON value. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A position in the parse tree. Object keys are strings, array elements are numeric indices. */
export type JsonPath = ReadonlyArray<string | number>;

/** Per-snapshot view of the parser state. */
export interface Snapshot {
  /**
   * The current partial value, with all open containers and strings synthetically closed
   * so it is always valid JSON. Numbers and literals that are mid-parse are coerced
   * conservatively (incomplete numbers fall back to `null`, incomplete literals fall back
   * to `null`), so consumers can render or persist this as-is.
   */
  value: JsonValue | undefined;

  /** True iff the input represented one fully-parsed JSON value at the time of snapshot. */
  complete: boolean;

  /** Cursor path. Where the parser is currently writing inside the tree. */
  path: JsonPath;

  /** Bytes consumed so far. */
  bytesIn: number;

  /**
   * Heuristic 0..1 confidence that the snapshot is "stable enough" to render.
   * 1.0 when complete; lower while inside strings or numbers; falls back as depth grows
   * and as scratch buffers are non-empty.
   */
  confidence: number;
}

/** Events emitted as the parser consumes input. */
export interface ParserEvents {
  /**
   * Emitted whenever a leaf value (string, number, boolean, null) is finalized into its
   * parent. Path is the location of the value within the root tree.
   */
  field: (path: JsonPath, value: JsonValue) => void;

  /**
   * Emitted whenever a container (object or array) is closed.
   */
  container: (path: JsonPath, value: JsonValue) => void;

  /**
   * Emitted on every push() with a fresh snapshot. Useful when the consumer wants partial
   * renders without polling.
   */
  partial: (snapshot: Snapshot) => void;

  /**
   * Emitted exactly once when the top-level value is complete.
   */
  complete: (value: JsonValue) => void;

  /**
   * Emitted when the parser encounters input it cannot continue from. The parser will
   * stop consuming further input until reset(). The error will also be thrown by the
   * call to push() that triggered it, unless an event handler is bound.
   */
  error: (err: Error) => void;
}

/** Options accepted by the parser constructor. */
export interface ParserOptions {
  /**
   * If true, the parser will attempt to repair common LLM mistakes such as trailing
   * commas, single-quoted strings, unquoted keys, and stray code-fence markers around
   * the JSON. Defaults to true; set false for strict RFC 8259 mode.
   */
  lenient?: boolean;

  /**
   * Maximum nesting depth. Defaults to 256. Prevents pathological inputs from blowing
   * the stack.
   */
  maxDepth?: number;

  /**
   * Maximum string length, in characters. Defaults to no limit. Useful when streaming
   * untrusted input.
   */
  maxStringLength?: number;
}
