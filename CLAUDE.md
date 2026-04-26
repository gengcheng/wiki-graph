# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies
node server.js       # start the server (reads .env automatically)
npm start            # alias for node server.js
```

No build step, no test suite. The entire application is a single `server.js` file served on the configured `PORT` (default `3000`).

To set up a new knowledge base instance, create the directory structure and a mandatory `index.md`:

```bash
mkdir -p /path/to/wiki/wiki /path/to/wiki/raw
echo "# Index" > /path/to/wiki/wiki/index.md
```

Then configure `.env` (copy from `.env.example`) with `WIKI_PATH`, `RAW_PATH`, and an LLM API key.

## Architecture

This is a **single-file Node.js application** (`server.js`) — all routes, LLM logic, MCP server, and scheduler live in one file. There is no database; the filesystem is the data store.

### Directory layout (runtime, not repo)

```
WIKI_ROOT/          # parent of RAW_PATH
├── wiki/           # WIKI_PATH — LLM-generated structured Markdown pages
│   ├── index.md    # required; manually created; used by ingest for cross-linking context
│   ├── concepts/   # auto-created by ingest
│   ├── entities/
│   └── sources/
├── raw/            # RAW_PATH — original user-uploaded files
│   └── ingest/     # default drop zone for /api/upload
└── log.md          # append-only ingest log
```

### Core data flow

1. **Ingest** (`POST /api/ingest` or scheduled cron): reads `.md` files from `raw/`, sends them to the LLM with a custom system prompt, parses the `===FILE:path===` delimited response, and writes structured wiki pages. Already-processed files are tracked via the `sources:` frontmatter field in wiki pages.

2. **Graph** (`GET /api/graph`): scans all wiki `.md` files, parses `[[wikilink]]` syntax to build nodes and edges. `buildTitleMap` resolves links via title, aliases, and filename stem.

3. **Query** (`POST /api/query` SSE / `POST /api/query/sync`): keyword + bigram scoring (`scoreRelevance`) selects top-10 relevant pages, then streams an LLM response grounded in those pages.

4. **MCP server** (`/mcp/sse`): exposes `query_wiki`, `get_page`, and `list_pages` tools over SSE transport for use in Claude Desktop or Claude Code.

### Key implementation details

- **LLM abstraction**: `streamLLM(system, userMsg, maxTokens)` is an async generator that normalizes Anthropic and OpenAI streaming APIs. Provider is selected via `LLM_PROVIDER` env var.
- **Link resolution**: `buildTitleMap` + `resolveLink` handle aliases, parenthetical stripping (e.g. `"Agile (敏捷)"` → `"agile"`), and hyphen-to-space normalization.
- **Orphan detection**: `buildComponents` builds an undirected adjacency graph and finds connected components via BFS. Pages not in the largest component are flagged as isolated. Index/overview pages are excluded so they don't collapse everything into one component.
- **Ingest deduplication**: `getProcessedIngestFiles` scans wiki frontmatter `sources:` fields; `getPendingIngestFiles` returns only unprocessed raw files, with prefix-match fallback for truncated filenames.
- **Lint/fix**: `/api/lint` checks broken wikilinks, missing frontmatter fields, orphan components, and empty ghost files. `/api/lint/fix` patches broken links via aliases and bridges isolated clusters with `See Also` links.
- **Multipart upload encoding**: filenames from browser uploads need `Buffer.from(name, 'latin1').toString('utf8')` to handle non-ASCII characters correctly.

### Frontend (`public/`)

Static files served by Express. `graph.js` uses D3.js (v7) to render the force-directed graph. `marked.min.js` renders Markdown in the page detail panel.

### MCP integration

Connect via:
```bash
claude mcp add wiki-graph --transport sse http://localhost:3000/mcp/sse
```

Or add to `claude_desktop_config.json` under `mcpServers`.

### `/wiki` Claude Code skill

`skill/SKILL.md` defines a Claude Code skill for querying the knowledge base. Install by copying to `~/.claude/skills/wiki/SKILL.md` and registering in `~/.claude/CLAUDE.md`.
