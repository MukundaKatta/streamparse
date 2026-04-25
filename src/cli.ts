#!/usr/bin/env node
/**
 * streamparse CLI.
 *
 *   streamparse parse <file>         # parse a (possibly partial) JSON file, print synthetic-closed value
 *   streamparse extract <file>       # extract JSON from prose / fences / code blocks
 *   streamparse validate <file>      # strict-mode RFC 8259 validation, exit 1 on failure
 *   streamparse --help
 *   streamparse --version
 *
 * Reads from stdin if `<file>` is `-` or omitted (and stdin is not a TTY).
 */

import { readFileSync } from 'node:fs';
import { JsonStreamParser, parsePartial } from './index.js';

const USAGE = `streamparse — streaming JSON parser with partial valid trees.

Usage:
  streamparse parse [<file>]      Parse a (possibly partial) JSON file.
  streamparse extract [<file>]    Extract JSON from prose, code fences, or comments.
  streamparse validate [<file>]   Strict-mode RFC 8259 validate. Exits 1 on failure.
  streamparse --help              Print this help.
  streamparse --version           Print version.

If <file> is "-" or omitted while stdin is piped, input is read from stdin.

Examples:
  curl -s api.example.com/stream | streamparse parse -
  streamparse extract response.txt
  streamparse validate config.json
`;

function readSource(file: string | undefined): string {
  if (!file || file === '-') {
    if (process.stdin.isTTY) {
      process.stderr.write('error: no input. Pass a file or pipe to stdin.\n\n');
      process.stderr.write(USAGE);
      process.exit(2);
    }
    // Sync read from stdin file descriptor.
    return readFileSync(0, 'utf8');
  }
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write('error: cannot read ' + file + ': ' + (err as Error).message + '\n');
    process.exit(2);
  }
}

function main(argv: string[]): number {
  const [, , cmd, ...rest] = argv;

  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return cmd ? 0 : 1;
  }
  if (cmd === '--version' || cmd === '-v') {
    // Pull version from package.json without bundling it. Ship-time stamp is fine.
    process.stdout.write('streamparse 1.0.0\n');
    return 0;
  }

  const file = rest[0];

  switch (cmd) {
    case 'parse': {
      const text = readSource(file);
      const value = parsePartial(text);
      const out = JSON.stringify(value, null, 2);
      process.stdout.write(out + '\n');
      return 0;
    }

    case 'extract': {
      const text = readSource(file);
      const value = parsePartial(text);
      if (value === undefined) {
        process.stderr.write('no JSON value found\n');
        return 1;
      }
      process.stdout.write(JSON.stringify(value, null, 2) + '\n');
      return 0;
    }

    case 'validate': {
      const text = readSource(file);
      const p = new JsonStreamParser({ lenient: false });
      try {
        p.push(text);
        p.end();
        const snap = p.snapshot();
        if (!snap.complete) {
          process.stderr.write('error: input is not a complete JSON value\n');
          return 1;
        }
        process.stdout.write('ok\n');
        return 0;
      } catch (err) {
        process.stderr.write((err as Error).message + '\n');
        return 1;
      }
    }

    default:
      process.stderr.write('error: unknown command: ' + cmd + '\n\n');
      process.stderr.write(USAGE);
      return 2;
  }
}

process.exit(main(process.argv));
