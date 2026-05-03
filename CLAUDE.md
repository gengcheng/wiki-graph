# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies
node server.js       # start the server (reads .env automatically)
npm start            # alias for node server.js
```

No build step, no test suite. The entire application is a single `server.js` file served on the configured `PORT` (default `3000`).

To set up a new knowledge base instance, create the directory structure:

```bash
mkdir -p /path/to/wiki/wiki /path/to/wiki/raw
```

`index.md` is auto-created on first ingest if absent. You can also create it manually beforehand to pre-populate sections.

Then configure `.env` (copy from `.env.example`) with `WIKI_PATH`, `RAW_PATH`, and an LLM API key.

## Architecture

This is a **single-file Node.js application** (`server.js`) — all routes, LLM logic, MCP server, and scheduler live in one file. There is no database; the filesystem is the data store.

### Directory layout (runtime, not repo)

```
WIKI_ROOT/          # parent of RAW_PATH
├── wiki/           # WIKI_PATH — LLM-generated structured Markdown pages
│   ├── index.md    # auto-created on first ingest if absent; used as cross-linking context
│   ├── concepts/   # auto-created by ingest
│   ├── entities/
│   └── sources/
├── raw/            # RAW_PATH — original user-uploaded files
│   └── ingest/     # default drop zone for /api/upload
├── conversations.json  # Redis fallback for conversation history
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
- **`safeMatter`**: thin wrapper around `gray-matter` that never throws — LLM-generated files with special characters in frontmatter produce invalid YAML. All frontmatter reads must go through `safeMatter`, not `matter` directly.
- **`fixSourcesField`**: called after every LLM file write to re-serialize the `sources:` field as single-quoted YAML, preventing future parse errors from filenames with quotes or colons.
- **LLM response format**: ingest uses `===FILE:path/to/page.md===` and `===INDEX:SectionName===` delimiters (not JSON) to parse multiple output files from a single LLM call.

### Query tuning

Four env vars control retrieval and answer quality:

- `QUERY_TOP_K` (default `10`): number of pages passed to the LLM as context.
- `QUERY_PAGE_CHARS` (default `8000`): characters taken from each page. Longer pages are truncated.
- `QUERY_MIN_SCORE` (default `0`): minimum relevance score to include a page. Raise to filter weakly-related pages (try `5`–`20` for large knowledge bases).
- `QUERY_MAX_TOKENS` (default `2048`): max tokens in the LLM answer. Raise for more detailed responses.

### Language configuration

Two env vars meaningfully change LLM behavior at runtime:

- `INGEST_LANG` (`zh` | `en` | `auto`, default `zh`): language for generated wiki page content.
- `QUERY_LANG` (`zh` | `en` | `bilingual`, default `zh`): language for query answers.

### Redis and conversation history

Conversation history uses **Redis** (optional) with transparent fallback to `conversations.json` in `WIKI_ROOT`. Redis is attempted at startup via `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` env vars; connection errors are silently swallowed. `redisReady()` checks live connection status before every read/write. Keys: `wiki:conv:<id>` (list, 30-day TTL) and `wiki:conversations` (sorted set for listing). Conversation API: `GET/DELETE /api/conversation/:id`, `GET /api/conversations`, `POST /api/conversation/save`.

### Scheduler

Automatic ingest runs on a cron schedule (`INGEST_CRON`, default `*/30 * * * *`). `INGEST_ENABLED=false` disables it. `INGEST_EXCLUDE` is a comma-separated list of `raw/` subdirectories to skip. The scheduler can also be controlled at runtime via `POST /api/ingest/config` and `POST /api/ingest/run-now`.

### Frontend (`public/`)

Static files served by Express. `graph.js` uses D3.js (v7) to render the force-directed graph. `marked.min.js` renders Markdown in the page detail panel.

### Additional API endpoints

- `GET /api/backlinks/:id` — returns pages that link to the given page ID.
- `GET /api/raw/tree` — raw file tree grouped by subdirectory.
- `GET /api/raw/file/*` — render a raw file as HTML.

### MCP integration

Connect via:
```bash
claude mcp add wiki-graph --transport sse http://localhost:3000/mcp/sse
```

Or add to `claude_desktop_config.json` under `mcpServers`.

### `/wiki` Claude Code skill

`skill/SKILL.md` defines a Claude Code skill for querying the knowledge base. Install by copying to `~/.claude/skills/wiki/SKILL.md` and registering in `~/.claude/CLAUDE.md`.
