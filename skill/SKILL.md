---
name: wiki
description: 查询本地 wiki-graph 知识库，语义搜索并由 LLM 综合回答
trigger: /wiki
---

# /wiki

向本地运行的 wiki-graph 知识库提问，返回 LLM 基于知识库内容的综合回答和来源页面。

## Usage

```
/wiki <问题>
/wiki 什么是价值投资
/wiki 巴菲特的投资原则是什么
/wiki --url http://localhost:3001 <问题>    # 指定非默认端口的实例
/wiki --list                               # 列出所有知识库页面
/wiki --list concept                       # 按类型列出（concept/entity/source/topic）
/wiki --page concepts/value-investing      # 读取指定页面完整内容
```

## What You Must Do When Invoked

### Step 1 - 解析参数

从用户输入中提取：
- `BASE_URL`：若用户传了 `--url <url>` 则使用该值，否则默认 `http://localhost:3000`
- 子命令：`--list`、`--page <id>`，或普通问题文本

### Step 2 - 执行请求

**普通提问**（默认）：

```bash
curl -s -X POST BASE_URL/api/query/sync \
  -H 'Content-Type: application/json' \
  -d '{"question": "用户的问题"}'
```

响应格式：
```json
{"answer": "...", "sources": ["concepts/foo.md", "entities/bar.md"]}
```

**列出页面** (`--list [type]`)：

```bash
curl -s BASE_URL/api/graph
```

响应中 `nodes` 数组包含 `id`、`title`、`type` 字段，按用户指定的 type 筛选后展示。

**读取页面** (`--page <id>`)：

```bash
curl -s BASE_URL/api/page/PAGE_ID
```

响应包含 `meta`（frontmatter）和 `html`，将 html 转为可读文本输出给用户。

### Step 3 - 处理错误

若 curl 返回空响应或连接失败，输出：

> ⚠️ 无法连接到 wiki-graph（BASE_URL）。请确认 server 已启动：`node server.js`

### Step 4 - 格式化输出

**普通提问**结果按以下格式输出：

```
{answer 内容}

---
**来源：**
- concepts/value-investing （根据 BASE_URL/api/page/concepts/value-investing 可查看完整页面）
- entities/warren-buffett
```

**列出页面**结果按类型分组输出，每行格式：`- id: 标题`

**读取页面**直接输出 frontmatter 关键字段（title、type、tags、sources）和页面正文。

### 注意事项

- 问题直接传给 API，不要修改或翻译用户原文
- sources 路径不含 `.md` 后缀时 API 会自动处理，直接传即可
- `--list` 和 `--page` 无需 LLM，直接展示 API 返回数据即可，保持简洁
