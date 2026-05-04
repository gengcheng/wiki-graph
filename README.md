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
│   ├── index.md        # 首次 ingest 时自动创建
│   ├── concepts/       # 自动创建
│   ├── entities/       # 自动创建
│   ├── sources/        # 自动创建
│   └── ...
├── raw/                # RAW_PATH：原始文件
│   ├── ingest/         # 上传文件的默认落地目录（自动创建）
│   └── ...             # 其他自定义子目录（可被定时任务扫描）
├── conversations.json  # 对话历史（Redis 不可用时的回退存储）
└── log.md              # 处理日志（自动创建）
```

### 新建知识库

```bash
mkdir -p /path/to/new-wiki/wiki /path/to/new-wiki/raw
```

然后在 `.env` 中指定路径，启动即可：

```
WIKI_PATH=/path/to/new-wiki/wiki
RAW_PATH=/path/to/new-wiki/raw
PORT=3001
```

多个知识库同时运行各自使用不同端口。`index.md` 会在首次 ingest 时自动生成，也可提前手动创建以预置章节结构。

---

## 环境变量（.env）

### 基础配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WIKI_PATH` | `./wiki/wiki` | 知识库页面目录 |
| `RAW_PATH` | `./wiki/raw` | 原始文件目录 |
| `PORT` | `3000` | HTTP 监听端口 |
| `AUTH_USERNAME` | — | 登录用户名（与 `AUTH_PASSWORD` 同时设置才生效） |
| `AUTH_PASSWORD` | — | 登录密码 |
| `LLM_PROVIDER` | `anthropic` | LLM 提供商：`anthropic` 或 `openai` |
| `ANTHROPIC_API_KEY` | — | Anthropic API Key |
| `ANTHROPIC_BASE_URL` | — | 自定义 Anthropic 接入点（可选） |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | 使用的模型 |
| `OPENAI_API_KEY` | — | OpenAI API Key |
| `OPENAI_BASE_URL` | — | 自定义 OpenAI 接入点（可选） |
| `OPENAI_MODEL` | `gpt-4o` | 使用的模型 |

### Ingest 定时任务

| 变量 | 默认值 | 说明 |
|---|---|---|
| `INGEST_ENABLED` | `true` | 是否启用定时摄入 |
| `INGEST_CRON` | `*/30 * * * *` | 定时扫描频率（cron 表达式） |
| `INGEST_EXCLUDE` | — | 逗号分隔，排除 `raw/` 下不扫描的子目录，如 `notes,assets` |
| `INGEST_LANG` | `zh` | 生成内容语言：`zh` / `en` / `auto`（跟随原文） |

### Ingest 质量调优

| 变量 | 默认值 | 单位 | 说明 |
|---|---|---|---|
| `INGEST_MAX_CHARS` | `50000` | 字符 | 发送给 LLM 的最大原文长度 |
| `INGEST_MAX_TOKENS` | `8192` | 输出 token | LLM 单次 ingest 最大输出 token |
| `INGEST_INDEX_CHARS` | `3000` | 字符 | 传给 LLM 的 index.md 上下文长度（用于交叉链接） |

### 查询配置

| 变量 | 默认值 | 单位 | 说明 |
|---|---|---|---|
| `QUERY_LANG` | `zh` | — | 回答语言：`zh` / `en` / `bilingual`（中英双语） |
| `QUERY_TOP_K` | `10` | 页面数 | 检索后传给 LLM 的最多页面数 |
| `QUERY_PAGE_CHARS` | `8000` | 字符 | 每个页面截取的最大字符数 |
| `QUERY_MIN_SCORE` | `0` | 无量纲分 | 页面最低相关性分数（大型知识库可设 5–20） |
| `QUERY_MAX_TOKENS` | `2048` | 输出 token | 回答的最大 token 数 |

### 健康检查定时任务

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LINT_ENABLED` | `false` | 是否启用定时健康检查 |
| `LINT_CRON` | `0 0 * * *` | 检查频率（cron 表达式，默认每天 0 点） |

定时健康检查发现 error 时会**自动修复**（合并重复 frontmatter 键、为断链添加 alias）。

### Redis（对话历史）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `REDIS_HOST` | `localhost` | Redis 主机 |
| `REDIS_PORT` | `6379` | Redis 端口 |
| `REDIS_PASSWORD` | — | Redis 密码（可选） |

Redis 不可用时自动回退到 `conversations.json`，不影响其他功能。

修改 `.env` 后需重启 server 生效。

---

## 功能说明

### 登录认证

可选的单用户密码保护。在 `.env` 中同时设置 `AUTH_USERNAME` 和 `AUTH_PASSWORD` 即可启用；任意一项未设置则跳过认证，与之前行为完全一致。

启用后：
- 浏览器访问主界面需先登录，登录态通过 httpOnly Cookie 保持 7 天
- 退出登录按钮出现在左侧菜单底部
- 以下接口**不需要登录**（供 Claude Code Skill 和 MCP 集成使用）：`GET /api/graph`、`GET /api/page/*`、`POST /api/query/sync`、`/mcp/*`

### 知识图谱

首页以力导向图可视化全部 Wiki 页面及其 `[[wikilink]]` 链接关系。节点按类型着色（concept / entity / source / topic），孤立节点会单独标识。点击节点可查看页面详情及反向链接。

### 智能问答

输入自然语言问题，系统通过关键词 + bigram 评分检索相关页面，再由 LLM 综合回答。回答中的 `[[wiki链接]]` 可点击，在右侧面板直接查看对应页面内容。每次打开页面默认开启新对话，历史对话可在左侧列表切换。

### 文件摄入（Ingest）

将 Markdown 文件放入 `raw/` 目录（或通过上传），LLM 自动解析并生成结构化 Wiki 页面（含 frontmatter、wikilink、分类）。支持两种触发方式：
- **定时任务**：每隔 N 分钟自动扫描 `raw/` 下未处理文件
- **立即处理**：上传时直接触发，流式返回进度

已处理文件通过 Wiki 页面的 `sources:` 字段追踪，不会重复处理。

### 标签系统

- **自动生成**：ingest 时 LLM 参考知识库现有标签，自动为每个页面生成一致的标签
- **手动指定**：上传文件时可附加标签，与 LLM 生成的标签合并
- **标签视图**（`#` 菜单）：查看所有标签及关联页面，支持内联重命名和删除
- **查询加权**：标签内容参与相关性评分，使检索更准确
- **文件浏览搜索**：可按标签名过滤文件列表

### 健康检查

检查知识库中的问题，分 error / warning 两级：

**Error（可自动修复）**
- 断链：`[[wikilink]]` 指向不存在的页面
- 重复 frontmatter 键：同一文件中重复的 YAML 字段（如多个 `aliases:`）

**Warning（仅提示）**
- 缺少必填 frontmatter 字段（`title` / `type` / `tags` / `created`）
- 孤岛页面：与主图谱无连接的孤立节点或子图
- 空文件（ghost files）
- 标签问题：空标签条目、单次出现的标签、大小写变体

手动点击"自动修复"会同时处理 error 和孤岛 warning。定时健康检查仅自动修复 error。

---

## HTTP API

Base URL: `http://localhost:3000`

> 启用登录后，大部分接口需携带有效的 `wiki_session` Cookie。以下接口始终公开：`GET /api/graph`、`GET /api/page/*`、`POST /api/query/sync`、`/mcp/*`。

### 认证

#### `POST /api/login`

```bash
curl -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username": "admin", "password": "changeme"}'
# → {"ok": true}  并在响应头中设置 wiki_session Cookie
```

#### `POST /api/logout`

```bash
curl -X POST http://localhost:3000/api/logout --cookie "wiki_session=..."
# → {"ok": true}
```

#### `GET /api/auth/status`

```jsonc
{ "authEnabled": true }
```

---

### 知识图谱

#### `GET /api/graph`
返回所有节点和边。

```jsonc
{
  "nodes": [{ "id": "concepts/value-investing", "title": "价值投资", "type": "concept", "tags": ["investment"] }],
  "edges": [{ "source": "concepts/value-investing", "target": "entities/warren-buffett" }]
}
```

#### `GET /api/page/:id`
读取单个 Wiki 页面。

```jsonc
{
  "meta": { "title": "价值投资", "type": "concept", "tags": ["investment"] },
  "html": "<h1>...</h1>"
}
```

#### `GET /api/backlinks/:id`
返回链接到指定页面的所有页面列表。

---

### 查询

#### `POST /api/query` — 流式（SSE）

```bash
curl -N -X POST http://localhost:3000/api/query \
  -H 'Content-Type: application/json' \
  -d '{"question": "什么是价值投资", "conversationId": "abc123"}'
```

```
data: {"sources": ["concepts/value-investing.md", ...]}
data: {"text": "价值投资是..."}
data: [DONE]
```

#### `POST /api/query/sync` — 同步（JSON）

```bash
curl -X POST http://localhost:3000/api/query/sync \
  -H 'Content-Type: application/json' \
  -d '{"question": "什么是价值投资"}'
```

```jsonc
{ "answer": "价值投资是一种...", "sources": ["concepts/value-investing.md"] }
```

---

### 文件摄入

#### `POST /api/upload`
上传文件到 `raw/ingest/`，等待定时任务处理。支持附带标签：

```bash
curl -X POST http://localhost:3000/api/upload \
  -F "files=@my-note.md" \
  -F 'tags=["投资", "读书笔记"]'
```

#### `POST /api/ingest`
上传并**立即**触发 LLM 处理（SSE 流式进度）。支持附带标签：

```bash
curl -N -X POST http://localhost:3000/api/ingest \
  -F "files=@my-note.md" \
  -F 'tags=["投资"]'
```

```
data: {"type": "log", "msg": "🤖 Claude 正在分析…"}
data: {"type": "created", "msg": "concepts/foo.md"}
data: {"type": "done", "msg": "✅ 完成！共创建/更新 3 个页面"}
```

#### `GET /api/ingest/status`

```jsonc
{
  "enabled": true,
  "schedule": "*/30 * * * *",
  "running": false,
  "lastRun": "2026-05-03T10:00:00.000Z",
  "lastResult": "✅ 2 个文件，6 个页面",
  "pending": ["my-note.md"]
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
立即触发一次扫描。

```bash
curl -X POST http://localhost:3000/api/ingest/run-now
# → {"ok": true}
```

---

### 标签

#### `GET /api/tags`
返回所有标签及出现次数，按频率降序。

```jsonc
{ "tags": [{ "tag": "investment", "count": 12 }, { "tag": "AI", "count": 8 }] }
```

#### `DELETE /api/tags/:tag`
删除指定标签（从所有页面移除）。

```bash
curl -X DELETE http://localhost:3000/api/tags/obsolete-tag
# → {"ok": true, "updated": 3}
```

#### `PUT /api/tags/:tag`
重命名标签。

```bash
curl -X PUT http://localhost:3000/api/tags/old-name \
  -H 'Content-Type: application/json' \
  -d '{"newTag": "new-name"}'
# → {"ok": true, "updated": 5}
```

---

### 健康检查

#### `GET /api/lint`
扫描知识库（SSE 流式输出），检查断链、重复 frontmatter 键、缺失字段、孤岛页面、空文件、标签问题。

```bash
curl -N http://localhost:3000/api/lint
```

```
data: {"type": "section", "msg": "检查断链"}
data: {"type": "error", "msg": "断链 [[foo]] ← concepts/bar.md"}
data: {"type": "done", "msg": "2 个错误 · 5 个警告"}
```

#### `POST /api/lint/fix`
自动修复 error（合并重复 frontmatter 键、为断链添加 alias）和孤岛页面（添加 See Also 桥接）。

```bash
curl -X POST http://localhost:3000/api/lint/fix
# → {"fixed": 4, "details": [{"type": "alias", "detail": "..."}, ...]}
```

#### `GET /api/lint/status`
查看健康检查定时任务状态。

```jsonc
{
  "enabled": false,
  "schedule": "0 0 * * *",
  "running": false,
  "lastRun": "2026-05-03T00:00:00.000Z",
  "lastResult": "0 个错误 · 12 个警告"
}
```

#### `POST /api/lint/config`
动态修改健康检查定时任务配置。

```bash
curl -X POST http://localhost:3000/api/lint/config \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true, "schedule": "0 8 * * *"}'
```

#### `POST /api/lint/run-now`
立即触发一次健康检查（含自动修复 error）。

```bash
curl -X POST http://localhost:3000/api/lint/run-now
# → {"ok": true}
```

---

### 原始文件

#### `GET /api/raw/tree`
列出 `raw/` 下所有 `.md` 文件，按子目录分组。

#### `GET /api/raw/file/*`
渲染并返回 `raw/` 下的原始 Markdown 文件。

```
GET /api/raw/file/ingest/my-note.md
```

---

### 对话历史

#### `GET /api/conversations`
列出所有对话。

#### `GET /api/conversation/:id`
获取指定对话的消息历史。

#### `DELETE /api/conversation/:id`
删除指定对话。

#### `POST /api/conversation/save`
保存对话。

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

#### `get_page`
读取指定 Wiki 页面的完整 Markdown 内容。

| 参数 | 类型 | 说明 |
|---|---|---|
| `id` | string | 页面 ID，如 `concepts/value-investing` |

#### `list_pages`
列出知识库中的所有页面，可按类型筛选。

| 参数 | 类型 | 说明 |
|---|---|---|
| `type` | string（可选） | `concept` / `entity` / `source` / `topic` |

---

## Claude Code Skill（/wiki）

`skill/SKILL.md` 是一个 Claude Code 自定义技能，安装后可在 Claude Code 中直接用 `/wiki` 命令查询知识库。

### 安装

```bash
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
