# Wiki Graph

个人知识库系统。将 Markdown 文件通过 LLM 自动转化为结构化 Wiki，并以知识图谱方式可视化。

## 快速启动

```bash
npm install
cp .env.example .env   # 填写 LLM 配置
node server.js
```

浏览器访问 `http://localhost:3000`

---

## 目录结构

```
WIKI_ROOT/              # RAW_PATH 的父目录
├── wiki/               # WIKI_PATH：生成的知识库页面
│   ├── index.md        # ⚠️ 必须手动创建（唯一硬性要求）
│   ├── concepts/       # 自动创建
│   ├── entities/       # 自动创建
│   ├── sources/        # 自动创建
│   └── ...
├── raw/                # RAW_PATH：原始文件
│   ├── ingest/         # 上传文件的默认落地目录（自动创建）
│   └── ...             # 其他自定义子目录（可被定时任务扫描）
└── log.md              # 处理日志（自动创建）
```

### 新建知识库

只需创建两个目录和一个文件：

```bash
mkdir -p /path/to/new-wiki/wiki
mkdir -p /path/to/new-wiki/raw
echo "# Index" > /path/to/new-wiki/wiki/index.md
```

然后在 `.env` 中指定路径和端口，启动即可：

```
WIKI_PATH=/path/to/new-wiki/wiki
RAW_PATH=/path/to/new-wiki/raw
PORT=3001
```

多个知识库同时运行只需各自使用不同端口。

---

## 环境变量（.env）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WIKI_PATH` | `./wiki/wiki` | 知识库页面目录 |
| `RAW_PATH` | `./wiki/raw` | 原始文件目录（`log.md` 存于其父目录） |
| `PORT` | `3000` | HTTP 监听端口 |
| `LLM_PROVIDER` | `anthropic` | LLM 提供商，`anthropic` 或 `openai` |
| `ANTHROPIC_API_KEY` | — | Anthropic API Key |
| `ANTHROPIC_BASE_URL` | — | 自定义 Anthropic 接入点（可选） |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | 使用的模型 |
| `OPENAI_API_KEY` | — | OpenAI API Key |
| `OPENAI_BASE_URL` | — | 自定义 OpenAI 接入点（可选） |
| `OPENAI_MODEL` | `gpt-4o` | 使用的模型 |
| `INGEST_ENABLED` | `true` | 是否启用定时摄入，`false` 关闭 |
| `INGEST_CRON` | `*/30 * * * *` | 定时扫描频率（cron 表达式） |
| `INGEST_EXCLUDE` | — | 逗号分隔，排除 `raw/` 下不需要扫描的子目录，如 `notes,assets` |
| `INGEST_LANG` | `zh` | 生成内容的语言：`zh` 中文 \| `en` 英文 \| `auto` 跟随原文 |
| `QUERY_LANG` | `zh` | 查询回答的语言：`zh` 中文 \| `en` 英文 \| `bilingual` 中英双语 |

修改 `.env` 后需重启 server 生效。

---

## HTTP API

Base URL: `http://localhost:3000`

### 知识图谱

#### `GET /api/graph`
返回所有节点和边，用于图谱渲染。

```jsonc
// Response
{
  "nodes": [{ "id": "concepts/value-investing", "title": "价值投资", "type": "concept", "tags": [...] }],
  "edges": [{ "source": "concepts/value-investing", "target": "entities/warren-buffett" }]
}
```

#### `GET /api/page/:id`
读取单个 Wiki 页面，返回 frontmatter 和渲染后的 HTML。

```
GET /api/page/concepts/value-investing
```

```jsonc
// Response
{
  "meta": { "title": "价值投资", "type": "concept", "tags": [...] },
  "html": "<h1>...</h1>"
}
```

---

### 查询

#### `POST /api/query` — 流式（SSE）
语义搜索 + LLM 回答，适合前端实时展示。

```bash
curl -N -X POST http://localhost:3000/api/query \
  -H 'Content-Type: application/json' \
  -d '{"question": "什么是价值投资"}'
```

```
data: {"sources": ["concepts/value-investing.md", ...]}
data: {"text": "价值投资是..."}
data: {"text": "..."}
data: [DONE]
```

#### `POST /api/query/sync` — 同步（JSON）
同上，等待 LLM 生成完毕后一次性返回，适合 Agent 调用。

```bash
curl -X POST http://localhost:3000/api/query/sync \
  -H 'Content-Type: application/json' \
  -d '{"question": "什么是价值投资"}'
```

```jsonc
// Response
{
  "answer": "价值投资是一种...",
  "sources": ["concepts/value-investing.md", "entities/warren-buffett.md"]
}
```

---

### 文件摄入

#### `POST /api/upload`
上传 `.md` 文件到 `raw/ingest/`，不触发 LLM 处理，由定时任务统一处理。

```bash
curl -X POST http://localhost:3000/api/upload \
  -F "files=@my-note.md" \
  -F "files=@another-note.md"
```

```jsonc
// Response
{
  "uploaded": [
    { "filename": "my-note.md", "size": 2048 }
  ]
}
```

#### `POST /api/ingest`
上传并**立即**触发 LLM 处理，以 SSE 流式返回进度。

```bash
curl -N -X POST http://localhost:3000/api/ingest \
  -F "files=@my-note.md"
```

```
data: {"type": "section", "msg": "处理文件: my-note.md"}
data: {"type": "log", "msg": "🤖 Claude 正在分析…"}
data: {"type": "created", "msg": "concepts/foo.md"}
data: {"type": "done", "msg": "✅ 完成！共创建/更新 3 个页面"}
```

#### `GET /api/ingest/status`
查看定时任务状态和待处理文件列表。

```jsonc
// Response
{
  "enabled": true,
  "schedule": "*/30 * * * *",
  "running": false,
  "lastRun": "2026-04-26T10:00:00.000Z",
  "lastResult": "✅ 2 个文件，6 个页面",
  "pending": ["my-note.md"],
  "log": [{ "type": "done", "msg": "...", "ts": "..." }]
}
```

#### `POST /api/ingest/config`
动态修改定时任务配置（重启后以 `.env` 为准）。

```bash
curl -X POST http://localhost:3000/api/ingest/config \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true, "schedule": "*/10 * * * *"}'
```

#### `POST /api/ingest/run-now`
立即触发一次扫描处理，无需等待定时触发。

```bash
curl -X POST http://localhost:3000/api/ingest/run-now
# → {"ok": true}
```

---

### 原始文件

#### `GET /api/raw/tree`
列出 `raw/` 目录下所有 `.md` 文件，按子目录分组。

#### `GET /api/raw/file/:path`
渲染并返回 `raw/` 下的原始 Markdown 文件。

```
GET /api/raw/file/ingest/my-note.md
```

---

### 健康检查

#### `GET /api/lint`
扫描知识库，检查断链、缺失 frontmatter、孤岛页面、空文件（SSE 流式输出）。

```bash
curl -N http://localhost:3000/api/lint
```

#### `POST /api/lint/fix`
自动修复断链（添加 aliases）和孤岛页面（添加 See Also 桥接）。

```bash
curl -X POST http://localhost:3000/api/lint/fix
# → {"fixed": 3, "details": [...]}
```

---

## MCP 接口

用于接入 Claude Desktop、Claude Code 或其他 MCP 兼容的 Agent。

**Endpoint:** `http://localhost:3000/mcp/sse`（SSE transport）

### 接入方式

**Claude Desktop** — 在 `claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "wiki-graph": {
      "url": "http://localhost:3000/mcp/sse"
    }
  }
}
```

**Claude Code** — 命令行添加：

```bash
claude mcp add wiki-graph --transport sse http://localhost:3000/mcp/sse
```

### 工具列表

#### `query_wiki`
语义搜索知识库并由 LLM 综合回答。

| 参数 | 类型 | 说明 |
|---|---|---|
| `question` | string | 要提问的问题 |

返回：LLM 生成的回答 + 来源页面列表。

#### `get_page`
读取指定 Wiki 页面的完整 Markdown 内容。

| 参数 | 类型 | 说明 |
|---|---|---|
| `id` | string | 页面 ID，如 `concepts/value-investing`、`entities/nvda` |

#### `list_pages`
列出知识库中的所有页面，可按类型筛选。

| 参数 | 类型 | 说明 |
|---|---|---|
| `type` | string（可选） | `concept`、`entity`、`source`、`topic`、`unknown` |

返回格式：
```
- concepts/value-investing: 价值投资 [concept]
- entities/warren-buffett: 沃伦·巴菲特 [entity]
```

---

## Claude Code Skill（/wiki）

`skill/SKILL.md` 是一个 Claude Code 自定义技能，安装后可在 Claude Code 中直接用 `/wiki` 命令查询知识库，无需手动调用 curl。

### 安装

```bash
# 将 skill 复制到 Claude Code 技能目录
cp skill/SKILL.md ~/.claude/skills/wiki/SKILL.md
```

然后在 `~/.claude/CLAUDE.md` 中注册：

```markdown
# wiki
- **wiki** (`~/.claude/skills/wiki/SKILL.md`) - 查询本地 wiki-graph 知识库。Trigger: `/wiki`
When the user types `/wiki`, invoke the Skill tool with `skill: "wiki"` before doing anything else.
```

### 使用

```
/wiki 什么是价值投资
/wiki 巴菲特的投资原则是什么
/wiki --url http://localhost:3001 <问题>    # 指定非默认端口
/wiki --list                               # 列出所有页面
/wiki --list concept                       # 按类型筛选
/wiki --page concepts/value-investing      # 读取指定页面
```
