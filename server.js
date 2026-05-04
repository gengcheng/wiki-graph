try { require('fs').readFileSync('.env','utf8').split('\n').forEach(l => { const m = l.match(/^\s*([^#\s][^=]*?)\s*=\s*(.*?)\s*$/); if (!m) return; const k = m[1], v = m[2].replace(/^(['"])(.*)\1$/, '$2'); if (k && !process.env[k]) process.env[k] = v }) } catch {}
const express = require('express')
const fs = require('fs')
const path = require('path')
const matter = require('gray-matter')
const { marked } = require('marked')
const { globSync } = require('glob')
const Anthropic = require('@anthropic-ai/sdk')
const OpenAI = require('openai')
const multer = require('multer')
const upload = multer({ storage: multer.memoryStorage() })
const cron = require('node-cron')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js')
const { z } = require('zod')
const Redis = require('ioredis')
const crypto = require('crypto')

let redis = null
try {
  redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: true,
    enableOfflineQueue: false
  })
  redis.on('error', () => {})
  redis.connect().catch(() => {})
} catch {}

const app = express()
const WIKI_PATH = process.env.WIKI_PATH || path.join(process.cwd(), 'wiki', 'wiki')
const INGEST_LANG        = process.env.INGEST_LANG         || 'zh'
const INGEST_MAX_CHARS   = parseInt(process.env.INGEST_MAX_CHARS   || '50000', 10)
const INGEST_MAX_TOKENS  = parseInt(process.env.INGEST_MAX_TOKENS  || '8192',  10)
const INGEST_INDEX_CHARS = parseInt(process.env.INGEST_INDEX_CHARS || '3000',  10)
const QUERY_LANG        = process.env.QUERY_LANG         || 'zh'
const QUERY_TOP_K       = parseInt(process.env.QUERY_TOP_K       || '10', 10)
const QUERY_PAGE_CHARS  = parseInt(process.env.QUERY_PAGE_CHARS  || '8000', 10)
const QUERY_MIN_SCORE   = parseFloat(process.env.QUERY_MIN_SCORE || '0')
const QUERY_MAX_TOKENS  = parseInt(process.env.QUERY_MAX_TOKENS  || '2048', 10)
const QUERY_LANG_INSTRUCTION = {
  zh:        '回答用中文，结构清晰。',
  en:        'Answer in English, with clear structure.',
  bilingual: '用中英双语回答：先给出中文回答，再附上对应的英文翻译，两部分用 "---" 分隔。'
}[QUERY_LANG] || '回答用中文，结构清晰。'

// ── Auth ─────────────────────────────────────────────────────────────────────
const AUTH_USERNAME = process.env.AUTH_USERNAME || ''
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || ''
const authEnabled = !!(AUTH_USERNAME && AUTH_PASSWORD)
const sessions = new Set()

function parseCookies(req) {
  const out = {}
  const header = req.headers.cookie || ''
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=')
    if (idx < 0) return
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim())
  })
  return out
}

const SKILL_PATHS = new Set(['/api/query/sync', '/api/graph'])

function requireAuth(req, res, next) {
  if (!authEnabled) return next()
  if (req.path === '/login' || req.path === '/login.html' || req.path === '/api/login') return next()
  if (req.path.startsWith('/mcp/') || req.path.startsWith('/api/page/')) return next()
  if (SKILL_PATHS.has(req.path)) return next()
  const token = parseCookies(req).wiki_session
  if (token && sessions.has(token)) return next()
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' })
  return res.redirect('/login')
}

app.use(requireAuth)
app.use(express.static('public'))

app.get('/login', (req, res) => {
  if (authEnabled) {
    const token = parseCookies(req).wiki_session
    if (token && sessions.has(token)) return res.redirect('/')
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'))
})

app.post('/api/login', express.json(), (req, res) => {
  if (!authEnabled) return res.json({ ok: true })
  const { username, password } = req.body || {}
  if (username === AUTH_USERNAME && password === AUTH_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex')
    sessions.add(token)
    res.cookie('wiki_session', token, { httpOnly: true, sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 * 1000 })
    return res.json({ ok: true })
  }
  res.status(401).json({ error: '用户名或密码错误' })
})

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).wiki_session
  if (token) sessions.delete(token)
  res.clearCookie('wiki_session')
  res.json({ ok: true })
})

app.get('/api/auth/status', (req, res) => {
  res.json({ authEnabled })
})

// gray-matter wrapper that never throws — filenames with quotes produce invalid YAML frontmatter
function safeMatter(raw) {
  try {
    return matter(raw)
  } catch {
    // return bare content with no frontmatter
    const stripped = raw.replace(/^---[\s\S]*?---\n?/, '')
    return { data: {}, content: stripped }
  }
}

// Merge user-supplied tags into a wiki page's frontmatter without overwriting LLM-generated tags.
function mergeUserTags(filePath, userTags) {
  if (!userTags || !userTags.length) return
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = safeMatter(raw)
    const existing = Array.isArray(parsed.data.tags)
      ? parsed.data.tags.map(String)
      : (parsed.data.tags ? [String(parsed.data.tags)] : [])
    const merged = [...new Set([...existing, ...userTags])]
    if (merged.length === existing.length && userTags.every(t => existing.includes(t))) return
    parsed.data.tags = merged
    fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data))
  } catch {}
}

// After LLM writes a file, re-serialize the sources field so special chars are safe YAML.
// Uses single-quoted YAML scalars which accept any char except bare single-quotes (which are doubled).
function fixSourcesField(filePath, rawFileName) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    try { matter(raw); return } catch {}  // already valid, nothing to do
    const singleQuoted = rawFileName.replace(/'/g, "''")
    const fixed = raw.replace(
      /^sources\s*:.*$/m,
      `sources:\n  - 'raw/${singleQuoted}'`
    )
    fs.writeFileSync(filePath, fixed)
  } catch {}
}

// strip parentheticals: "Agile Development (敏捷开发)" → "agile development"
function normText(text) {
  return text.replace(/\s*[\(（][^)）]*[\)）]/g, '').trim().toLowerCase()
}

function buildTitleMap(files, cwd) {
  const map = {}
  for (const file of files) {
    const raw = fs.readFileSync(path.join(cwd, file), 'utf8')
    const { data } = safeMatter(raw)
    const id = file.replace(/\.md$/, '')
    const title = data.title != null ? String(data.title) : path.basename(id)
    map[title.toLowerCase()] = id
    const nt = normText(title)
    if (nt !== title.toLowerCase()) map[nt] = id
    if (data.aliases) for (const a of data.aliases) {
      map[String(a).toLowerCase()] = id
      map[normText(String(a))] = id
    }
    const stem = path.basename(id).toLowerCase()
    map[stem] = id
    map[stem.replace(/-/g, ' ')] = id  // "agile-development" → "agile development"
  }
  return map
}

function resolveLink(text, titleMap) {
  const lower = text.toLowerCase()
  if (titleMap[lower]) return titleMap[lower]
  // also try stripping parens from the link text: "[[Futu (富途)]]" → "futu"
  const noParens = normText(text)
  return (noParens && noParens !== lower) ? (titleMap[noParens] || null) : null
}

// Build undirected adjacency list and find connected components.
// Nav pages (index, overview) are excluded — their links would make everything
// appear connected, just like Obsidian's graph shows index as a central hub.
function buildComponents(pageData, titleMap) {
  const navIds = new Set(['index', 'overview'])
  const adj = {}
  for (const id of Object.keys(pageData)) {
    if (!navIds.has(id)) adj[id] = new Set()
  }

  for (const [id, page] of Object.entries(pageData)) {
    if (navIds.has(id)) continue   // don't follow links FROM nav pages
    const links = [...page.content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)]
    for (const m of links) {
      const t = resolveLink(m[1].trim(), titleMap)
      if (t && t !== id && !navIds.has(t)) {
        if (!adj[t]) adj[t] = new Set()
        adj[id].add(t)
        adj[t].add(id)
      }
    }
  }

  const visited = new Set()
  const components = []
  for (const startId of Object.keys(adj)) {
    if (visited.has(startId)) continue
    const component = []
    const queue = [startId]
    while (queue.length > 0) {
      const cur = queue.shift()
      if (visited.has(cur)) continue
      visited.add(cur)
      component.push(cur)
      for (const nb of (adj[cur] || new Set())) {
        if (!visited.has(nb)) queue.push(nb)
      }
    }
    components.push(component)
  }

  components.sort((a, b) => b.length - a.length)
  return { components, adj }
}

// ── Unified LLM streaming ────────────────────────────────────────────────────
async function* streamLLM(system, userMsg, maxTokens = 4096) {
  const provider = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase()
  if (provider === 'openai') {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      ...(process.env.OPENAI_BASE_URL && { baseURL: process.env.OPENAI_BASE_URL })
    })
    const stream = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      max_tokens: maxTokens,
      stream: true,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg }
      ]
    })
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || ''
      if (text) yield text
    }
  } else {
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      ...(process.env.ANTHROPIC_BASE_URL && { baseURL: process.env.ANTHROPIC_BASE_URL })
    })
    const s = client.messages.stream({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMsg }]
    })
    for await (const chunk of s) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        yield chunk.delta.text
      }
    }
  }
}

function buildGraph() {
  const files = globSync('**/*.md', { cwd: WIKI_PATH, ignore: ['index.md', 'overview.md'] })
  const nodes = []
  const edges = []
  const titleMap = buildTitleMap(files, WIKI_PATH)

  for (const file of files) {
    const fullPath = path.join(WIKI_PATH, file)
    const content = fs.readFileSync(fullPath, 'utf8')
    const { data } = safeMatter(content)
    const id = file.replace(/\.md$/, '')
    const title = data.title != null ? String(data.title) : path.basename(id)

    nodes.push({
      id,
      title,
      type: data.type || 'unknown',
      tags: data.tags || [],
      file
    })
  }

  for (const file of files) {
    const fullPath = path.join(WIKI_PATH, file)
    const content = fs.readFileSync(fullPath, 'utf8')
    const sourceId = file.replace(/\.md$/, '')
    const links = [...content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)]
    const seen = new Set()

    for (const match of links) {
      const targetId = resolveLink(match[1].trim(), titleMap)
      if (targetId && targetId !== sourceId) {
        const key = `${sourceId}→${targetId}`
        if (!seen.has(key)) {
          seen.add(key)
          edges.push({ source: sourceId, target: targetId })
        }
      }
    }
  }

  return { nodes, edges }
}

app.get('/api/tags', (req, res) => {
  const counts = {}
  try {
    for (const file of globSync('**/*.md', { cwd: WIKI_PATH })) {
      const { data } = safeMatter(fs.readFileSync(path.join(WIKI_PATH, file), 'utf8'))
      const tags = Array.isArray(data.tags) ? data.tags : (data.tags ? [data.tags] : [])
      tags.forEach(t => { if (t) counts[String(t)] = (counts[String(t)] || 0) + 1 })
    }
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
  const tags = Object.entries(counts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  res.json({ tags })
})

function updateTagInFiles(oldTag, newTag) {
  const updated = []
  for (const file of globSync('**/*.md', { cwd: WIKI_PATH })) {
    const filePath = path.join(WIKI_PATH, file)
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = safeMatter(raw)
    const tags = Array.isArray(parsed.data.tags)
      ? parsed.data.tags.map(String)
      : (parsed.data.tags ? [String(parsed.data.tags)] : [])
    if (!tags.includes(oldTag)) continue
    parsed.data.tags = newTag
      ? tags.map(t => t === oldTag ? newTag : t)
      : tags.filter(t => t !== oldTag)
    try {
      fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data))
      updated.push(file)
    } catch {}
  }
  return updated
}

app.delete('/api/tags/:tag', (req, res) => {
  try {
    const updated = updateTagInFiles(req.params.tag, null)
    res.json({ ok: true, updated: updated.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.put('/api/tags/:tag', express.json(), (req, res) => {
  const { newTag } = req.body
  if (!newTag || !newTag.trim()) return res.status(400).json({ error: 'newTag required' })
  try {
    const updated = updateTagInFiles(req.params.tag, newTag.trim())
    res.json({ ok: true, updated: updated.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/graph', (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    res.json(buildGraph())
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/page/*', (req, res) => {
  const filePath = path.join(WIKI_PATH, req.params[0] + '.md')
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' })
  const raw = fs.readFileSync(filePath, 'utf8')
  const { data, content } = safeMatter(raw)
  const files = globSync('**/*.md', { cwd: WIKI_PATH })
  const titleMap = buildTitleMap(files, WIKI_PATH)
  const cleaned = content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => {
    const text = (label || target).trim()
    const resolved = resolveLink(target.trim(), titleMap)
    return resolved ? `[${text}](wiki:${resolved})` : `**${text}**`
  })
  res.json({ meta: data, html: marked(cleaned) })
})

app.get('/api/backlinks/*', (req, res) => {
  const id = req.params[0]
  try {
    const { nodes, edges } = buildGraph()
    const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]))
    const backlinks = edges
      .filter(e => e.target === id)
      .map(e => nodeMap[e.source])
      .filter(Boolean)
      .filter((n, i, arr) => arr.findIndex(x => x.id === n.id) === i)
    res.json({ backlinks })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

const RAW_PATH = process.env.RAW_PATH || path.join(process.cwd(), 'wiki', 'raw')
const WIKI_ROOT = path.dirname(RAW_PATH)

// API: raw file tree grouped by top-level folder
app.get('/api/raw/tree', (req, res) => {
  const files = globSync('**/*.md', { cwd: RAW_PATH })
  const tree = {}
  for (const file of files) {
    const parts = file.split('/')
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '/'
    if (!tree[folder]) tree[folder] = []
    tree[folder].push({ file, name: path.basename(file, '.md') })
  }
  res.json(tree)
})

// API: serve a raw file rendered as HTML
app.get('/api/raw/file/*', (req, res) => {
  const filePath = path.join(RAW_PATH, req.params[0])
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' })
  const content = fs.readFileSync(filePath, 'utf8')
  res.json({ html: marked(content) })
})

// ── Ingest ──────────────────────────────────────────────────────────────────

const RAW_INGEST_PATH = path.join(RAW_PATH, 'ingest')

// normalize curly/smart quotes to ASCII so LLM-generated sources fields match real filenames
function normalizeQuotes(s) {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
}

function getExistingTags() {
  const tags = new Set()
  try {
    for (const file of globSync('**/*.md', { cwd: WIKI_PATH })) {
      const { data } = safeMatter(fs.readFileSync(path.join(WIKI_PATH, file), 'utf8'))
      const t = Array.isArray(data.tags) ? data.tags : (data.tags ? [data.tags] : [])
      t.forEach(tag => { if (tag) tags.add(String(tag)) })
    }
  } catch {}
  return [...tags].sort()
}

function getProcessedIngestFiles() {
  const processed = new Set()
  try {
    const files = globSync('**/*.md', { cwd: WIKI_PATH })
    for (const file of files) {
      const raw = fs.readFileSync(path.join(WIKI_PATH, file), 'utf8')
      const { data } = safeMatter(raw)
      const sources = Array.isArray(data.sources) ? data.sources : (data.sources ? [data.sources] : [])
      for (const src of sources) {
        const s = String(src)
        if (s.startsWith('raw/')) processed.add(normalizeQuotes(s.slice('raw/'.length)))
      }
    }
  } catch {}
  return processed
}

function getPendingIngestFiles() {
  if (!fs.existsSync(RAW_PATH)) return []
  const excluded = new Set((process.env.INGEST_EXCLUDE || '').split(',').map(s => s.trim()).filter(Boolean))
  const processed = getProcessedIngestFiles()
  return globSync('**/*.md', { cwd: RAW_PATH }).filter(f => {
    const topDir = f.split('/')[0]
    if (excluded.has(topDir)) return false
    const stem = normalizeQuotes(f).replace(/\.md$/, '')
    if (processed.has(stem + '.md')) return false
    // prefix match: handles truncated filenames stored in older wiki sources
    for (const p of processed) {
      const pStem = p.replace(/\.md$/, '')
      if (pStem.length >= 10 && stem.startsWith(pStem)) return false
    }
    return true
  })
}

const schedulerState = {
  enabled: process.env.INGEST_ENABLED !== 'false',
  schedule: process.env.INGEST_CRON || '*/30 * * * *',
  running: false,
  lastRun: null,
  lastResult: null,
  log: [],
  cronJob: null
}

const lintSchedulerState = {
  enabled: process.env.LINT_ENABLED === 'true',
  schedule: process.env.LINT_CRON || '0 0 * * *',
  running: false,
  lastRun: null,
  lastResult: null,
  cronJob: null
}

async function processContent(content, sourceName, rawFileName, send, userTags = []) {
  const today = new Date().toISOString().split('T')[0]
  send('log', `🤖 Claude 正在分析…`)

  let existingIndex = ''
  try {
    existingIndex = fs.readFileSync(path.join(WIKI_PATH, 'index.md'), 'utf8').slice(0, INGEST_INDEX_CHARS)
  } catch {}

  const existingTags = getExistingTags()

  const systemPrompt = `你是 Karpathy LLM Wiki 知识库构建助手。分析内容，生成结构化 Wiki 页面。
使用以下分隔符格式输出（不要用 JSON）：

===FILE:sources/source-{kebab-case}.md===
完整 markdown 内容（含 frontmatter）

===FILE:concepts/{kebab-case}.md===
完整 markdown 内容（含 frontmatter）

===FILE:entities/{kebab-case}.md===
完整 markdown 内容（含 frontmatter）

===INDEX:Concepts===
- [[概念名]] — 一行描述

===INDEX:Sources===
- [[源名]] — 一行描述

规则：
- Frontmatter 必须包含: title, type, tags, created(${today}), updated(${today}), sources(["raw/${rawFileName}"])${existingTags.length ? `\n- tags 字段优先复用知识库已有标签，避免同义词重复（已有标签: ${existingTags.join(', ')}）；内容确实涉及新概念时才创建新标签` : ''}
- 交叉引用：在新页面内容中，用 [[wikilinks]] 链接到下方已有知识库页面中相关的条目，使新节点融入知识图谱
- 只创建有实质内容的页面
- ${{ zh: '所有页面内容（标题、正文、描述）一律用中文', en: 'All page content (titles, body, descriptions) must be in English', auto: '内容语言跟随原文语言' }[INGEST_LANG] || '内容语言跟随原文语言'}${userTags.length ? `\n- 每个页面的 tags 字段必须包含以下用户指定标签: ${userTags.join(', ')}` : ''}
- 每个 ===FILE:=== 块之间不要有额外分隔符
- 严禁将文件内容包裹在 \`\`\`markdown 或任何代码块中，直接输出原始 Markdown 文本（frontmatter 的 --- 必须是文件的第一行）

已有知识库页面（请在新页面中引用相关条目）：
${existingIndex}`

  let fullText = ''
  let charsSinceUpdate = 0
  for await (const text of streamLLM(systemPrompt, `来源: ${sourceName}\n\n${content.slice(0, INGEST_MAX_CHARS)}`, INGEST_MAX_TOKENS)) {
    fullText += text
    charsSinceUpdate += text.length
    if (charsSinceUpdate >= 300) {
      send('log', `✍ 生成中… (${fullText.length} 字符)`)
      charsSinceUpdate = 0
    }
  }
  send('log', `✓ 生成完成 (${fullText.length} 字符)，写入文件…`)

  const created = []
  const indexEntries = {}

  const blockRe = /===FILE:([^\s=]+\.md)===([\s\S]*?)(?====|$)/g
  const indexRe = /===INDEX:(\w+)===([\s\S]*?)(?====|$)/g

  let fileMatch
  while ((fileMatch = blockRe.exec(fullText)) !== null) {
    const relPath = fileMatch[1].trim()
    let fileContent = fileMatch[2].trim()
    if (!fileContent) continue
    fileContent = fileContent.replace(/^```(?:markdown)?\n([\s\S]*?)```\s*$/, '$1').trim()
    const fullFilePath = path.join(WIKI_PATH, relPath)
    const dir = path.dirname(fullFilePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const existed = fs.existsSync(fullFilePath)
    fs.writeFileSync(fullFilePath, fileContent)
    fixSourcesField(fullFilePath, rawFileName)
    mergeUserTags(fullFilePath, userTags)
    created.push(relPath)
    send(existed ? 'updated' : 'created', relPath)
  }

  let idxMatch
  while ((idxMatch = indexRe.exec(fullText)) !== null) {
    const section = idxMatch[1].trim()
    const lines = idxMatch[2].trim().split('\n').filter(l => l.trim().startsWith('-'))
    if (!indexEntries[section]) indexEntries[section] = []
    indexEntries[section].push(...lines)
  }

  const allEntries = Object.entries(indexEntries)
  if (allEntries.length > 0) {
    const indexFilePath = path.join(WIKI_PATH, 'index.md')
    if (!fs.existsSync(indexFilePath)) fs.writeFileSync(indexFilePath, '# Index\n')
    let idx = fs.readFileSync(indexFilePath, 'utf8')
    for (const [section, lines] of allEntries) {
      const header = `## ${section}`
      const pos = idx.indexOf(header)
      if (pos !== -1) {
        const next = idx.indexOf('\n## ', pos + header.length)
        const ins = next !== -1 ? next : idx.length
        idx = idx.slice(0, ins) + '\n' + lines.join('\n') + idx.slice(ins)
      } else {
        idx += `\n${header}\n${lines.join('\n')}\n`
      }
    }
    fs.writeFileSync(path.join(WIKI_PATH, 'index.md'), idx)
    send('log', `📋 index.md 已更新`)
  }

  const logLine = `\n## [${today}] ingest | ${sourceName}\n- Raw: raw/${rawFileName}\n- Pages: ${created.join(', ')}\n`
  fs.appendFileSync(path.join(WIKI_ROOT, 'log.md'), logLine)

  return created.length
}

async function runScheduledIngest() {
  if (schedulerState.running) return
  const pending = getPendingIngestFiles()
  if (pending.length === 0) return

  schedulerState.running = true
  schedulerState.lastRun = new Date().toISOString()
  const slog = (type, msg) => {
    schedulerState.log.push({ type, msg, ts: new Date().toISOString() })
    if (schedulerState.log.length > 200) schedulerState.log.shift()
  }

  const logPath = path.join(WIKI_ROOT, 'log.md')
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 16)
  fs.appendFileSync(logPath, `\n## [${ts}] scheduler | 发现 ${pending.length} 个待处理文件\n`)

  let total = 0
  try {
    for (const filename of pending) {
      slog('section', `处理: ${filename}`)
      const content = fs.readFileSync(path.join(RAW_PATH, filename), 'utf8')
      const name = path.basename(filename, path.extname(filename))
      let userTags = []
      const sidecarPath = path.join(RAW_PATH, filename + '.tags.json')
      try { userTags = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) } catch {}
      const count = await processContent(content, name, filename, slog, userTags)
      total += count
      try { if (userTags.length) fs.unlinkSync(sidecarPath) } catch {}
    }
    schedulerState.lastResult = `✅ ${pending.length} 个文件，${total} 个页面`
    slog('done', schedulerState.lastResult)
    fs.appendFileSync(logPath, `- 结果: ${schedulerState.lastResult}\n`)
  } catch (e) {
    schedulerState.lastResult = `❌ ${e.message}`
    slog('error', schedulerState.lastResult)
    fs.appendFileSync(logPath, `- 错误: ${e.message}\n`)
  }
  schedulerState.running = false
}

function initScheduler() {
  if (schedulerState.cronJob) schedulerState.cronJob.destroy()
  if (schedulerState.enabled) {
    schedulerState.cronJob = cron.schedule(schedulerState.schedule, runScheduledIngest)
  }
}
initScheduler()

app.post('/api/upload', upload.array('files', 20), (req, res) => {
  if (!fs.existsSync(RAW_INGEST_PATH)) fs.mkdirSync(RAW_INGEST_PATH, { recursive: true })
  const uploaded = []
  let userTags = []
  try { userTags = JSON.parse(req.body.tags || '[]') } catch {}
  for (const file of (req.files || [])) {
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8')
    fs.writeFileSync(path.join(RAW_INGEST_PATH, name), file.buffer)
    if (userTags.length) {
      fs.writeFileSync(path.join(RAW_INGEST_PATH, name + '.tags.json'), JSON.stringify(userTags))
    }
    uploaded.push({ filename: name, size: file.size })
  }
  res.json({ uploaded })
})

app.get('/api/ingest/status', (req, res) => {
  res.json({
    enabled: schedulerState.enabled,
    schedule: schedulerState.schedule,
    running: schedulerState.running,
    lastRun: schedulerState.lastRun,
    lastResult: schedulerState.lastResult,
    pending: getPendingIngestFiles(),
    log: schedulerState.log.slice(-50)
  })
})

app.post('/api/ingest/config', express.json(), (req, res) => {
  const { enabled, schedule } = req.body
  if (typeof enabled === 'boolean') schedulerState.enabled = enabled
  if (schedule && cron.validate(schedule)) schedulerState.schedule = schedule
  initScheduler()
  res.json({ ok: true, enabled: schedulerState.enabled, schedule: schedulerState.schedule })
})

app.post('/api/ingest/run-now', (req, res) => {
  if (schedulerState.running) return res.json({ ok: false, reason: 'already running' })
  runScheduledIngest()
  res.json({ ok: true })
})

// ── Lint Scheduler ────────────────────────────────────────────────────────────

async function runScheduledLint() {
  if (lintSchedulerState.running) return
  lintSchedulerState.running = true
  lintSchedulerState.lastRun = new Date().toISOString()
  try {
    const files = globSync('**/*.md', { cwd: WIKI_PATH })
    const titleMap = buildTitleMap(files, WIKI_PATH)
    const pageData = {}
    for (const file of files) {
      const raw = fs.readFileSync(path.join(WIKI_PATH, file), 'utf8')
      const { data, content } = safeMatter(raw)
      const id = file.replace(/\.md$/, '')
      pageData[id] = { file, content, data }
    }
    let errors = 0, warnings = 0

    // broken links
    for (const [, page] of Object.entries(pageData)) {
      const links = [...page.content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)]
      for (const m of links) { if (!resolveLink(m[1].trim(), titleMap)) errors++ }
    }
    // duplicate frontmatter keys
    for (const [, page] of Object.entries(pageData)) {
      const raw = fs.readFileSync(path.join(WIKI_PATH, page.file), 'utf8')
      if (findDuplicateFMKeys(raw).length) errors++
    }
    // missing required frontmatter
    const REQUIRED = ['title', 'type', 'tags', 'created']
    const skip = new Set(['index', 'overview'])
    for (const [id, page] of Object.entries(pageData)) {
      if (skip.has(path.basename(id))) continue
      if (REQUIRED.some(f => !page.data[f])) warnings++
    }
    // orphan pages
    const { components } = buildComponents(pageData, titleMap)
    const navIds = new Set(['index', 'overview'])
    for (const component of components.slice(1)) {
      for (const id of component) { if (!navIds.has(id)) warnings++ }
    }

    let fixedCount = 0
    if (errors > 0) {
      const { fixes } = fixErrors()
      fixedCount = fixes.length
    }
    const summary = `${errors} 个错误 · ${warnings} 个警告${fixedCount ? ` · 已修复 ${fixedCount} 项` : ''}`
    lintSchedulerState.lastResult = summary
    fs.appendFileSync(logPath, `\n## [${lintSchedulerState.lastRun}] lint | ${summary}\n`)
  } catch (e) {
    lintSchedulerState.lastResult = `❌ ${e.message}`
  }
  lintSchedulerState.running = false
}

function initLintScheduler() {
  if (lintSchedulerState.cronJob) lintSchedulerState.cronJob.destroy()
  if (lintSchedulerState.enabled) {
    lintSchedulerState.cronJob = cron.schedule(lintSchedulerState.schedule, runScheduledLint)
  }
}
initLintScheduler()

app.get('/api/lint/status', (req, res) => {
  res.json({
    enabled: lintSchedulerState.enabled,
    schedule: lintSchedulerState.schedule,
    running: lintSchedulerState.running,
    lastRun: lintSchedulerState.lastRun,
    lastResult: lintSchedulerState.lastResult
  })
})

app.post('/api/lint/config', express.json(), (req, res) => {
  const { enabled, schedule } = req.body
  if (typeof enabled === 'boolean') lintSchedulerState.enabled = enabled
  if (schedule && cron.validate(schedule)) lintSchedulerState.schedule = schedule
  initLintScheduler()
  res.json({ ok: true, enabled: lintSchedulerState.enabled, schedule: lintSchedulerState.schedule })
})

app.post('/api/lint/run-now', (req, res) => {
  if (lintSchedulerState.running) return res.json({ ok: false, reason: 'already running' })
  runScheduledLint()
  res.json({ ok: true })
})

app.post('/api/ingest', upload.array('files', 20), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const send = (type, msg) => res.write(`data: ${JSON.stringify({ type, msg })}\n\n`)

  if (!fs.existsSync(RAW_INGEST_PATH)) fs.mkdirSync(RAW_INGEST_PATH, { recursive: true })

  let userTags = []
  try { userTags = JSON.parse(req.body.tags || '[]') } catch {}

  try {
    if (req.files && req.files.length > 0) {
      let total = 0
      for (const file of req.files) {
        const originalname = Buffer.from(file.originalname, 'latin1').toString('utf8')
        send('section', `处理文件: ${originalname}`)
        send('log', `💾 保存原始文件 → raw/ingest/${originalname}`)
        fs.writeFileSync(path.join(RAW_INGEST_PATH, originalname), file.buffer)
        const content = file.buffer.toString('utf8')
        const name = path.basename(originalname, path.extname(originalname))
        const count = await processContent(content, name, `ingest/${originalname}`, send, userTags)
        total += count
      }
      send('done', `✅ 完成！共创建/更新 ${total} 个页面`)
    } else {
      send('error', '请提供上传文件')
    }
  } catch (e) {
    send('error', `❌ ${e.message}`)
  }

  res.end()
})

// ── Lint ─────────────────────────────────────────────────────────────────────

app.get('/api/lint', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const send = (type, msg) => res.write(`data: ${JSON.stringify({ type, msg })}\n\n`)

  const files = globSync('**/*.md', { cwd: WIKI_PATH })
  send('log', `扫描 ${files.length} 个页面`)

  // build maps
  const titleMap = buildTitleMap(files, WIKI_PATH)
  const pageData = {}
  for (const file of files) {
    const raw = fs.readFileSync(path.join(WIKI_PATH, file), 'utf8')
    const { data, content } = safeMatter(raw)
    const id = file.replace(/\.md$/, '')
    const title = data.title != null ? String(data.title) : id
    pageData[id] = { file, title, content, data, type: data.type }
  }

  let errors = 0, warnings = 0

  // 1. broken links
  send('section', '检查断链')
  for (const [, page] of Object.entries(pageData)) {
    const links = [...page.content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)]
    for (const m of links) {
      if (!resolveLink(m[1].trim(), titleMap)) {
        errors++
        send('error', `断链 [[${m[1]}]] ← ${page.file}`)
      }
    }
  }
  send('check', `断链检查完成`)

  // 2. frontmatter
  send('section', '检查 Frontmatter')
  const REQUIRED = ['title', 'type', 'tags', 'created']
  const skip = new Set(['index', 'overview'])
  for (const [id, page] of Object.entries(pageData)) {
    if (skip.has(path.basename(id))) continue
    const missing = REQUIRED.filter(f => !page.data[f])
    if (missing.length) { warnings++; send('warning', `${page.file} 缺少: ${missing.join(', ')}`) }
  }
  send('check', `Frontmatter 检查完成`)

  // 2b. duplicate frontmatter keys
  for (const [, page] of Object.entries(pageData)) {
    const raw = fs.readFileSync(path.join(WIKI_PATH, page.file), 'utf8')
    const dupes = findDuplicateFMKeys(raw)
    if (dupes.length) {
      errors++
      send('error', `重复的 Frontmatter 字段 [${dupes.join(', ')}] ← ${page.file}`)
    }
  }

  // 3. orphan pages — connected component analysis (undirected graph)
  // A cluster that only links within itself is just as broken as a lone orphan
  send('section', '检查孤岛页面')
  const navIds = new Set(['index', 'overview'])
  const { components } = buildComponents(pageData, titleMap)
  // largest component = main graph; everything else is isolated
  const mainSet = new Set(components[0] || [])
  let orphanCount = 0
  for (const component of components.slice(1)) {
    for (const id of component) {
      if (navIds.has(id)) continue
      const page = pageData[id]
      if (!page) continue
      warnings++
      orphanCount++
      send('warning', `孤岛页面 (独立子图, ${component.length}个节点): ${page.file}`)
    }
  }
  send('log', `共检查 ${Object.keys(pageData).length - navIds.size} 个页面，发现 ${orphanCount} 个孤岛`)
  send('check', `孤岛检查完成`)

  // 4. ghost files
  send('section', '检查 Ghost 文件')
  const wikiRoot = globSync('*.md', { cwd: WIKI_PATH }).filter(f => !['index.md','overview.md'].includes(f))
  for (const f of wikiRoot) {
    if (!fs.readFileSync(path.join(WIKI_PATH, f), 'utf8').trim()) {
      warnings++; send('warning', `Ghost 文件: wiki/${f}`)
    }
  }
  const repoRoot = globSync('*.md', { cwd: WIKI_ROOT }).filter(f => f !== 'log.md')
  for (const f of repoRoot) {
    if (!fs.readFileSync(path.join(WIKI_ROOT, f), 'utf8').trim()) {
      warnings++; send('warning', `Ghost 文件 (根目录): ${f}`)
    }
  }
  send('check', `Ghost 文件检查完成`)

  // 5. tag checks
  send('section', '检查标签')
  const tagFreqMap = {}
  for (const [, page] of Object.entries(pageData)) {
    const tags = Array.isArray(page.data.tags) ? page.data.tags : []
    const strTags = tags.map(t => String(t).trim())
    if (tags.length > 0 && strTags.some(t => t.length === 0)) {
      warnings++
      send('warning', `${page.file} 含空标签条目`)
    }
    for (const t of strTags.filter(t => t.length > 0)) {
      if (!tagFreqMap[t]) tagFreqMap[t] = []
      tagFreqMap[t].push(page.file)
    }
  }

  // singleton tags
  for (const [tag, pages] of Object.entries(tagFreqMap)) {
    if (pages.length === 1) {
      warnings++
      send('warning', `单次出现的标签 "${tag}" ← ${pages[0]}`)
    }
  }

  // case-variant duplicates
  const lcVariants = {}
  for (const tag of Object.keys(tagFreqMap)) {
    const lc = tag.toLowerCase()
    if (!lcVariants[lc]) lcVariants[lc] = []
    lcVariants[lc].push(tag)
  }
  for (const [, variants] of Object.entries(lcVariants)) {
    if (variants.length > 1) {
      warnings++
      send('warning', `大小写变体标签: ${variants.join(' / ')}`)
    }
  }


  send('check', `标签检查完成 (共 ${Object.keys(tagFreqMap).length} 个标签)`)

  send('done', `${errors} 个错误 · ${warnings} 个警告`)
  res.end()
})

// shared helper: rebuild pageData + inbound map (mirrors lint logic)
function buildPageData() {
  const files = globSync('**/*.md', { cwd: WIKI_PATH })
  const titleMap = buildTitleMap(files, WIKI_PATH)
  const pageData = {}
  for (const file of files) {
    const raw = fs.readFileSync(path.join(WIKI_PATH, file), 'utf8')
    const { data, content } = safeMatter(raw)
    const id = file.replace(/\.md$/, '')
    pageData[id] = { file, content, data, title: data.title != null ? String(data.title) : path.basename(id) }
  }
  return { files, titleMap, pageData }
}

// Detect duplicate top-level YAML keys in frontmatter
function findDuplicateFMKeys(rawText) {
  const m = rawText.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return []
  const seen = [], dupes = new Set()
  for (const line of m[1].split('\n')) {
    const km = line.match(/^([a-zA-Z_][\w-]*):/)
    if (km) { if (seen.includes(km[1])) dupes.add(km[1]); else seen.push(km[1]) }
  }
  return [...dupes]
}

// Merge duplicate frontmatter keys: list values are unioned, scalars keep last
function mergeDuplicateFMKeys(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  const dupes = findDuplicateFMKeys(raw)
  if (dupes.length === 0) return false
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return false

  // Walk raw YAML lines and collect all values for each duplicate key
  const collected = {}
  for (const key of dupes) collected[key] = new Set()
  let currentKey = null
  for (const line of fmMatch[1].split('\n')) {
    const km = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)/)
    if (km) {
      currentKey = km[1]
      const inline = km[2].trim().replace(/^["']|["']$/g, '')
      if (dupes.includes(currentKey) && inline) collected[currentKey].add(inline)
    } else if (currentKey && dupes.includes(currentKey) && /^\s+-\s+/.test(line)) {
      const val = line.replace(/^\s+-\s+/, '').replace(/^["']|["']$/g, '').trim()
      if (val) collected[currentKey].add(val)
    }
  }
  // gray-matter keeps last-occurrence value; union with collected
  const { data, content } = safeMatter(raw)
  for (const key of dupes) {
    const existing = Array.isArray(data[key]) ? data[key] : (data[key] ? [String(data[key])] : [])
    existing.forEach(v => collected[key].add(String(v)))
    if (collected[key].size > 0) data[key] = [...collected[key]]
  }
  fs.writeFileSync(filePath, matter.stringify(content, data))
  fixSourcesField(filePath)
  return true
}

// word-overlap score between two text blobs (Chinese-aware)
function overlapScore(a, b) {
  const tokens = a.toLowerCase().split(/[\s，。！？,.!?、:：；;]+/).filter(w => w.length > 1)
  const bt = b.toLowerCase()
  return tokens.reduce((s, w) => s + (bt.includes(w) ? w.length : 0), 0)
}

// Lint Fix: fix broken links (aliases) + orphan pages (See Also links)
// Fix error-level issues only: duplicate FM keys + broken wikilinks
function fixErrors() {
  let { files, titleMap, pageData } = buildPageData()
  const fixes = []

  // 0. Duplicate frontmatter keys
  for (const file of files) {
    if (mergeDuplicateFMKeys(path.join(WIKI_PATH, file)))
      fixes.push({ type: 'fm-dedup', detail: `合并重复 Frontmatter 键 ← ${file}` })
  }
  // Rebuild after frontmatter fixes so link resolution uses fresh aliases
  const rebuilt = buildPageData()
  files = rebuilt.files; Object.assign(titleMap, rebuilt.titleMap); Object.assign(pageData, rebuilt.pageData)

  // 1. Broken wikilinks → add alias to best-matching page
  const alreadyFixed = new Set()
  for (const [, page] of Object.entries(pageData)) {
    const links = [...page.content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)]
    for (const m of links) {
      const text = m[1].trim()
      if (resolveLink(text, titleMap)) continue
      const key = text.toLowerCase()
      if (alreadyFixed.has(key)) continue
      const noParens = normText(text)
      let best = null
      for (const file of files) {
        const id = file.replace(/\.md$/, '')
        const stem = path.basename(id).replace(/-/g, ' ').toLowerCase()
        const { data } = safeMatter(fs.readFileSync(path.join(WIKI_PATH, file), 'utf8'))
        const title = normText(data.title != null ? String(data.title) : '')
        if (stem.includes(noParens) || noParens.includes(stem) ||
            title.includes(noParens) || noParens.includes(title)) {
          best = { id, file, data }; break
        }
      }
      if (!best) continue
      const aliases = best.data.aliases ? [...best.data.aliases] : []
      if (!aliases.map(a => String(a).toLowerCase()).includes(key)) {
        aliases.push(text)
        const fullPath = path.join(WIKI_PATH, best.file)
        const parsed = safeMatter(fs.readFileSync(fullPath, 'utf8'))
        parsed.data.aliases = aliases
        fs.writeFileSync(fullPath, matter.stringify(parsed.content, parsed.data))
        alreadyFixed.add(key)
        fixes.push({ type: 'alias', detail: `"${text}" → ${best.file}` })
      }
    }
  }
  return { fixes, files, titleMap, pageData }
}

app.post('/api/lint/fix', (req, res) => {
  const { fixes, titleMap, pageData } = fixErrors()
  const navIds = new Set(['index', 'overview'])

  // ── Also fix isolated components (warning, but included in manual fix) ──
  const { components: comps } = buildComponents(pageData, titleMap)
  const mainSet = new Set(comps[0] || [])
  for (const component of comps.slice(1)) {
    const { adj: adjComp } = buildComponents(
      Object.fromEntries(component.map(id => [id, pageData[id]])), titleMap
    )
    const rep = component.reduce((best, id) =>
      (adjComp[id]?.size || 0) > (adjComp[best]?.size || 0) ? id : best, component[0])
    const repPage = pageData[rep]
    if (!repPage) continue
    const repText = repPage.title + ' ' + repPage.content
    let bestId = null, bestScore = 0
    for (const mainId of mainSet) {
      if (navIds.has(mainId) || mainId.startsWith('sources/')) continue
      const mp = pageData[mainId]
      if (!mp) continue
      const score = overlapScore(repText, mp.title + ' ' + mp.content)
      if (score > bestScore) { bestScore = score; bestId = mainId }
    }
    if (!bestId) bestId = [...mainSet].find(id => !navIds.has(id) && !id.startsWith('sources/'))
    if (!bestId) continue
    const linkStr = `[[${repPage.title}]]`
    const targetPath = path.join(WIKI_PATH, pageData[bestId].file)
    let targetContent = fs.readFileSync(targetPath, 'utf8')
    if (targetContent.includes(linkStr)) continue
    if (targetContent.includes('\n## See Also\n')) {
      targetContent = targetContent.replace('\n## See Also\n', `\n## See Also\n- ${linkStr}\n`)
    } else {
      targetContent = targetContent.trimEnd() + `\n\n## See Also\n- ${linkStr}\n`
    }
    fs.writeFileSync(targetPath, targetContent)
    pageData[bestId].content = targetContent
    fixes.push({ type: 'orphan', detail: `集群(${component.length}节点) ${repPage.file} → 桥接到 ${pageData[bestId].file}` })
  }

  res.json({ fixed: fixes.length, details: fixes })
})

// ── Query ─────────────────────────────────────────────────────────────────────

// Score a page against a Chinese/English mixed query
function scoreRelevance(question, pageText) {
  const q = question.toLowerCase()
  const t = pageText.toLowerCase()

  // exact phrase anywhere: highest priority
  if (t.includes(q)) return 100000

  // tokenize: split on spaces + CJK/latin punctuation
  const tokens = q.split(/[\s，。！？,.!?、:：；;"'"'【】()（）\-_]+/).filter(w => w.length > 0)

  let score = 0
  for (const token of tokens) {
    let idx = 0, count = 0
    while ((idx = t.indexOf(token, idx)) !== -1) { count++; idx++ }
    score += count * token.length  // longer tokens weighted more

    // extract bigrams from each token (catches partial Chinese word matches)
    for (let i = 0; i < token.length - 1; i++) {
      const bg = token.slice(i, i + 2)
      let bi = 0, bc = 0
      while ((bi = t.indexOf(bg, bi)) !== -1) { bc++; bi++ }
      score += bc * 0.4
    }
  }
  return score
}

async function queryWiki(question) {
  const files = globSync('**/*.md', { cwd: WIKI_PATH, ignore: ['index.md'] })
  const pages = files.map(file => {
    const raw = fs.readFileSync(path.join(WIKI_PATH, file), 'utf8')
    const { data, content } = safeMatter(raw)
    const tags = Array.isArray(data.tags) ? data.tags.join(' ') : (data.tags || '')
    return { file, title: data.title != null ? String(data.title) : file, tags, content }
  })
  const scored = pages.map(p => ({
    ...p,
    score: scoreRelevance(question, p.title + ' ' + p.tags + ' ' + p.content)
  })).sort((a, b) => b.score - a.score)
  const top = scored.slice(0, QUERY_TOP_K).filter(p => p.score > QUERY_MIN_SCORE)
  const sources = top.map(p => p.file)
  const context = top.map(p =>
    `## ${p.title} [${p.file}]\n${p.content.slice(0, QUERY_PAGE_CHARS)}`
  ).join('\n\n---\n\n')
  const sysPrompt = `你是一个个人知识库助手。以下是知识库中与问题最相关的页面（按相关度排序）。
请优先基于这些页面内容回答，尤其是页面中与问题直接相关的具体内容、观点和建议。
如果某个页面包含直接相关内容，请明确引用它（如：根据《页面标题》…）。
若知识库中确实没有相关信息，再结合自身知识回答，但需注明"以下来自通用知识"。
${QUERY_LANG_INSTRUCTION}

${context}`
  let answer = ''
  for await (const text of streamLLM(sysPrompt, question, QUERY_MAX_TOKENS)) answer += text
  return { answer, sources }
}

app.post('/api/query', express.json(), async (req, res) => {
  const { question } = req.body
  if (!question) return res.status(400).json({ error: 'Missing question' })

  const files = globSync('**/*.md', { cwd: WIKI_PATH, ignore: ['index.md'] })
  const pages = files.map(file => {
    const raw = fs.readFileSync(path.join(WIKI_PATH, file), 'utf8')
    const { data, content } = safeMatter(raw)
    const tags = Array.isArray(data.tags) ? data.tags.join(' ') : (data.tags || '')
    return { file, title: data.title != null ? String(data.title) : file, tags, content }
  })
  const scored = pages.map(p => ({
    ...p,
    score: scoreRelevance(question, p.title + ' ' + p.tags + ' ' + p.content)
  })).sort((a, b) => b.score - a.score)
  const top = scored.slice(0, QUERY_TOP_K).filter(p => p.score > QUERY_MIN_SCORE)
  const selected = top.map(p => p.file)
  const context = top.map(p =>
    `## ${p.title} [${p.file}]\n${p.content.slice(0, QUERY_PAGE_CHARS)}`
  ).join('\n\n---\n\n')

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.write(`data: ${JSON.stringify({ sources: selected })}\n\n`)

  const sysPrompt = `你是一个个人知识库助手。以下是知识库中与问题最相关的页面（按相关度排序）。
请优先基于这些页面内容回答，尤其是页面中与问题直接相关的具体内容、观点和建议。
如果某个页面包含直接相关内容，请明确引用它（如：根据《页面标题》…）。
若知识库中确实没有相关信息，再结合自身知识回答，但需注明"以下来自通用知识"。
${QUERY_LANG_INSTRUCTION}

${context}`

  try {
    for await (const text of streamLLM(sysPrompt, question, QUERY_MAX_TOKENS)) {
      res.write(`data: ${JSON.stringify({ text })}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`)
    res.end()
  }
})

app.post('/api/query/sync', express.json(), async (req, res) => {
  const { question } = req.body
  if (!question) return res.status(400).json({ error: 'Missing question' })
  try {
    res.json(await queryWiki(question))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Conversation history (Redis → file fallback) ──────────────────────────────

const CONV_TTL = 60 * 60 * 24 * 30  // 30 days
const CONV_FILE = path.join(WIKI_ROOT, 'conversations.json')

function redisReady() { return redis && redis.status === 'ready' }

function loadConvFile() {
  try { return JSON.parse(fs.readFileSync(CONV_FILE, 'utf8')) } catch { return {} }
}

function saveConvFile(data) {
  try { fs.writeFileSync(CONV_FILE, JSON.stringify(data)) } catch {}
}

app.post('/api/conversation/save', express.json(), async (req, res) => {
  const { conversationId, question, answer, sources } = req.body
  if (!conversationId || !question) return res.status(400).json({ error: 'Missing fields' })
  try {
    if (redisReady()) {
      const key = `wiki:conv:${conversationId}`
      const entry = JSON.stringify({ question, answer: answer || '', sources: sources || [], timestamp: Date.now() })
      await redis.rpush(key, entry)
      await redis.expire(key, CONV_TTL)
      await redis.zadd('wiki:conversations', Date.now(), conversationId)
      await redis.expire('wiki:conversations', CONV_TTL)
    } else {
      const data = loadConvFile()
      if (!data[conversationId]) data[conversationId] = { timestamp: Date.now(), messages: [] }
      data[conversationId].messages.push({ question, answer: answer || '', sources: sources || [], timestamp: Date.now() })
      data[conversationId].timestamp = Date.now()
      saveConvFile(data)
    }
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/conversation/:id', async (req, res) => {
  try {
    if (redisReady()) {
      const items = await redis.lrange(`wiki:conv:${req.params.id}`, 0, -1)
      return res.json({ messages: items.map(i => JSON.parse(i)) })
    }
    const data = loadConvFile()
    res.json({ messages: (data[req.params.id]?.messages) || [] })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/conversation/:id', async (req, res) => {
  try {
    if (redisReady()) {
      await redis.del(`wiki:conv:${req.params.id}`)
      await redis.zrem('wiki:conversations', req.params.id)
    } else {
      const data = loadConvFile()
      delete data[req.params.id]
      saveConvFile(data)
    }
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/conversations', async (req, res) => {
  try {
    if (redisReady()) {
      const ids = await redis.zrevrange('wiki:conversations', 0, 29, 'WITHSCORES')
      const conversations = []
      for (let i = 0; i < ids.length; i += 2) {
        const id = ids[i]
        const timestamp = parseInt(ids[i + 1])
        let preview = ''
        try {
          const first = await redis.lindex(`wiki:conv:${id}`, 0)
          if (first) preview = (JSON.parse(first).question || '').slice(0, 60)
        } catch {}
        if (preview) conversations.push({ id, timestamp, preview })
      }
      return res.json({ conversations })
    }
    const data = loadConvFile()
    const conversations = Object.entries(data)
      .map(([id, conv]) => ({ id, timestamp: conv.timestamp, preview: (conv.messages[0]?.question || '').slice(0, 60) }))
      .filter(c => c.preview)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 30)
    res.json({ conversations })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── MCP Server ───────────────────────────────────────────────────────────────

const mcpServer = new McpServer({ name: 'wiki-graph', version: '1.0.0' })

mcpServer.tool(
  'query_wiki',
  '在个人知识库中语义搜索并回答问题',
  { question: z.string().describe('要提问的问题') },
  async ({ question }) => {
    const { answer, sources } = await queryWiki(question)
    const text = sources.length
      ? `${answer}\n\n**来源：** ${sources.join(', ')}`
      : answer
    return { content: [{ type: 'text', text }] }
  }
)

mcpServer.tool(
  'get_page',
  '获取知识库中指定页面的完整内容',
  { id: z.string().describe('页面 ID，如 concepts/value-investing 或 entities/nvda') },
  async ({ id }) => {
    const filePath = path.join(WIKI_PATH, id.replace(/\.md$/, '') + '.md')
    if (!fs.existsSync(filePath)) {
      return { content: [{ type: 'text', text: `页面不存在: ${id}` }], isError: true }
    }
    return { content: [{ type: 'text', text: fs.readFileSync(filePath, 'utf8') }] }
  }
)

mcpServer.tool(
  'list_pages',
  '列出知识库所有页面，可按类型筛选',
  { type: z.enum(['concept', 'entity', 'source', 'topic', 'unknown']).optional().describe('页面类型，不填则返回全部') },
  async ({ type }) => {
    const { nodes } = buildGraph()
    const filtered = type ? nodes.filter(n => n.type === type) : nodes
    const text = filtered.map(n => `- ${n.id}: ${n.title} [${n.type}]`).join('\n')
    return { content: [{ type: 'text', text: text || '知识库为空' }] }
  }
)

const mcpTransports = {}

app.get('/mcp/sse', async (req, res) => {
  const transport = new SSEServerTransport('/mcp/messages', res)
  mcpTransports[transport.sessionId] = transport
  res.on('close', () => delete mcpTransports[transport.sessionId])
  await mcpServer.connect(transport)
})

app.post('/mcp/messages', async (req, res) => {
  const transport = mcpTransports[req.query.sessionId]
  if (!transport) return res.status(400).send('Session not found')
  await transport.handlePostMessage(req, res)
})

const PORT = parseInt(process.env.PORT || '3000', 10)
app.listen(PORT, () => {
  console.log(`Wiki Graph running at http://localhost:${PORT}`)
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp/sse`)
  console.log(`WIKI_PATH: ${WIKI_PATH}`)
  console.log(`RAW_PATH:  ${RAW_PATH}`)
})
