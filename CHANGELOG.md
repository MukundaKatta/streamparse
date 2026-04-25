# Changelog

## 1.0.1 — 2026-04-25

- Add `streamparse` CLI: `parse`, `extract`, `validate` subcommands.
- Cleaner error messages (no double `streamparse:` prefix).
- Homebrew formula at `mukundakatta/tools`.

## 1.0.0 — 2026-04-25

Initial release.

- `JsonStreamParser`: incremental JSON parser with `push()` / `end()` /
  `snapshot()` API.
- `parsePartial()`: one-shot helper for possibly-truncated blobs.
- `streamSnapshots()`: async-iterable adapter for fetch/SSE/anywhere a
  ReadableStream lands.
- Lenient mode handles trailing commas, single-quoted strings, unquoted
  keys, ` ```json ` fences, line and block comments, and prose padding.
- Strict mode is RFC 8259 compliant.
- Path tracking, per-leaf and per-container events, partial-snapshot
  events.
- 64 tests covering correctness, streaming, lenient repairs, events,
  limits, and path stability.
- Zero runtime dependencies. ESM. Node 18+. Browser-safe.
