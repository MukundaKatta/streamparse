# Launch post draft

A few flavors. Pick one or remix.

---

## HN / X long form

**streamparse: a JSON parser that yields partial valid trees as tokens arrive**

Every agent framework hand-rolls this and most do it badly.

When an LLM is mid-tool-call and only half the JSON has arrived, you have three bad options today:

1. Wait for the full payload. Slow, kills any chance of streaming UX.
2. Buffer and `JSON.parse` in a try/catch. O(n²), throws useless errors until the very last byte.
3. Hand-roll partial-JSON repair. Always fails on the LLM-isms that matter: trailing commas, single quotes, code fences, comment lines, unquoted keys, the prose the model glued before and after the JSON.

So I built the version you should reuse.

`@mukundakatta/streamparse` is a single-pass streaming JSON parser. You push bytes in, take a snapshot any time, and get a valid JSON tree back. Synthetic closure means open strings, arrays, and objects close themselves in the snapshot, so it round-trips through `JSON.parse(JSON.stringify(...))` cleanly. Render it. Persist it. Diff two of them.

```ts
import { JsonStreamParser } from '@mukundakatta/streamparse';

const p = new JsonStreamParser();
p.push('{"name":"Cl');
p.snapshot().value;   // { name: 'Cl' }

p.push('aude","tools":[1,2');
p.snapshot().value;   // { name: 'Claude', tools: [1, 2] }

p.push(']}');
p.end();
p.snapshot().complete; // true
```

Lenient mode handles the LLM-isms by default. Strict mode is RFC 8259 compliant. Path tracking, per-leaf events, partial events on every push.

Zero runtime deps, ESM, Node 18+, browser-safe. 64 tests. ~6.8x slower than `JSON.parse` on full docs, faster than naive try/catch on streaming and gives a usable tree from chunk one.

There's a Python port too: `pip install partial-json-stream`. Same algorithm, same API.

And an MCP server so any AI assistant can call it directly: `npm install -g @mukundakatta/streamparse-mcp`. Drop into Claude Desktop's config and Claude can parse partial JSON on demand.

- npm: https://www.npmjs.com/package/@mukundakatta/streamparse
- pypi: https://pypi.org/project/partial-json-stream
- mcp: https://www.npmjs.com/package/@mukundakatta/streamparse-mcp
- github: https://github.com/MukundaKatta/streamparse

---

## X (Twitter) thread version

1/

every agent framework reinvents partial JSON parsing and most do it badly.

i shipped streamparse: streaming JSON parser that yields valid trees as tokens arrive.

push bytes, take snapshot, get a tree you can render mid-stream.

https://github.com/MukundaKatta/streamparse

2/

```ts
const p = new JsonStreamParser();
p.push('{"name":"Cl');
p.snapshot().value;   // { name: 'Cl' }

p.push('aude","tools":[1,2');
p.snapshot().value;   // { name: 'Claude', tools: [1, 2] }
```

every snapshot is valid JSON. open strings/arrays close themselves. round-trippable.

3/

lenient mode handles the LLM-isms by default:

- trailing commas
- single quotes
- unquoted keys
- ```json fences
- // and /* */ comments
- prose padding

strict mode is RFC 8259 compliant.

4/

zero deps. ESM. node 18+. browser-safe. 64 tests passing.

~6.8x slower than JSON.parse on full docs.
faster than naive try/catch on streaming.
gives a usable tree from chunk one.

5/

shipped 3 things together:

- npm: @mukundakatta/streamparse
- pypi: partial-json-stream (python port, same API)
- mcp: @mukundakatta/streamparse-mcp (so Claude/Cursor/Cline/Windsurf/Zed can use it directly)

drop the MCP into claude_desktop_config.json and Claude can parse partial JSON on demand.

---

## README diff for the README badge row

Update the badges row to include:

```markdown
[![python port](https://img.shields.io/badge/python-partial--json--stream-blue.svg)](https://pypi.org/project/partial-json-stream/)
[![mcp server](https://img.shields.io/badge/MCP-streamparse--mcp-blueviolet.svg)](https://www.npmjs.com/package/@mukundakatta/streamparse-mcp)
```

---

## Submit list

- [ ] HN: Show HN with the long-form text above
- [ ] X: thread version, pin for a week
- [ ] Reddit: r/LocalLLaMA, r/programming
- [ ] dev.to / Hashnode: long-form post
- [ ] MCP registry: submit streamparse-mcp
- [ ] awesome-mcp-servers: PR
- [ ] awesome-claude-skills: link from your own list
- [ ] Anthropic Discord #showcase
- [ ] OpenAI dev forum
- [ ] LangChain Discord
- [ ] Vercel AI SDK Discord
