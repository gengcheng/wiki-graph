try { require('fs').readFileSync('.env','utf8').split('\n').forEach(l => { const [k,v] = l.split('='); if(k&&v) process.env[k.trim()]=v.trim() }) } catch {}
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

const app = express()
const WIKI_PATH = process.env.WIKI_PATH || path.join(process.cwd(), 'wiki', 'wiki')
const INGEST_LANG = process.env.INGEST_LANG || 'zh'
const QUERY_LANG  = process.env.QUERY_LANG  || 'zh'
const QUERY_LANG_INSTRUCTION = {
  zh:        '回答用中文，结构清晰。',
  en:        'Answer in English, with clear structure.',
  bilingual: '用中英双语回答：先给出中文回答，再附上对应的英文翻译，两部分用 "---" 分隔。'
}[QUERY_LANG] || '回答用中文，结构清晰。'

app.use(express.static('public'))

// strip parentheticals: "Agile Development (敏捷开发)" → "agile development"
function normText(text) {
  return text.replace(/\s*[\(（][^)）]*[\)）]/g, '').trim().toLowerCase()
}

function buildTitleMap(files, cwd) {
  const map = {}
  for (const file of files) {
    const raw = fs.readFileSync(path.join(cwd, file), 'utf8')
    const { data } = matter(raw)
    const id = file.replace(/\.md$/, '')
    const title = data.title || path.basename(id)
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
    const { data } = matter(content)
    const id = file.replace(/\.md$/, '')
    const title = data.title || path.basename(id)

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
  const { data, content } = matter(raw)
  const cleaned = content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => `**${label || target}**`)
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

function getProcessedIngestFiles() {
  const processed = new Set()
  try {
    const files = globSync('**/*.md', { cwd: WIKI_PATH })
    for (const file of files) {
      const raw = fs.readFileSync(path.join(WIKI_PATH, file), 'utf8')
      const { data } = matter(raw)
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

async function processContent(content, sourceName, rawFileName, send) {
  const today = new Date().toISOString().split('T')[0]
  send('log', `🤖 Claude 正在分析…`)

  let existingIndex = ''
  try {
    existingIndex = fs.readFileSync(path.join(WIKI_PATH, 'index.md'), 'utf8').slice(0, 3000)
  } catch {}

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
- Frontmatter 必须包含: title, type, tags, created(${today}), updated(${today}), sources(["raw/${rawFileName}"])
- 交叉引用：在新页面内容中，用 [[wikilinks]] 链接到下方已有知识库页面中相关的条目，使新节点融入知识图谱
- 只创建有实质内容的页面
- ${{ zh: '所有页面内容（标题、正文、描述）一律用中文', en: 'All page content (titles, body, descriptions) must be in English', auto: '内容语言跟随原文语言' }[INGEST_LANG] || '内容语言跟随原文语言'}
- 每个 ===FILE:=== 块之间不要有额外分隔符
- 严禁将文件内容包裹在 \`\`\`markdown 或任何代码块中，直接输出原始 Markdown 文本（frontmatter 的 --- 必须是文件的第一行）

已有知识库页面（请在新页面中引用相关条目）：
${existingIndex}`

  let fullText = ''
  let charsSinceUpdate = 0
  for await (const text of streamLLM(systemPrompt, `来源: ${sourceName}\n\n${content.slice(0, 50000)}`, 8192)) {
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
    let idx = fs.readFileSync(path.join(WIKI_PATH, 'index.md'), 'utf8')
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
      const count = await processContent(content, name, filename, slog)
      total += count
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
  for (const file of (req.files || [])) {
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8')
    fs.writeFileSync(path.join(RAW_INGEST_PATH, name), file.buffer)
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

app.post('/api/ingest', upload.array('files', 20), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const send = (type, msg) => res.write(`data: ${JSON.stringify({ type, msg })}\n\n`)

  if (!fs.existsSync(RAW_INGEST_PATH)) fs.mkdirSync(RAW_INGEST_PATH, { recursive: true })

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
        const count = await processContent(content, name, `ingest/${originalname}`, send)
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
    const { data, content } = matter(raw)
    const id = file.replace(/\.md$/, '')
    const title = data.title || id
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
    const { data, content } = matter(raw)
    const id = file.replace(/\.md$/, '')
    pageData[id] = { file, content, data, title: data.title || path.basename(id) }
  }
  return { files, titleMap, pageData }
}

// word-overlap score between two text blobs (Chinese-aware)
function overlapScore(a, b) {
  const tokens = a.toLowerCase().split(/[\s，。！？,.!?、:：；;]+/).filter(w => w.length > 1)
  const bt = b.toLowerCase()
  return tokens.reduce((s, w) => s + (bt.includes(w) ? w.length : 0), 0)
}

// Lint Fix: fix broken links (aliases) + orphan pages (See Also links)
app.post('/api/lint/fix', (req, res) => {
  const { files, titleMap, pageData } = buildPageData()
  const navIds = new Set(['index', 'overview'])
  const fixes = []

  // ── 1. Fix broken wikilinks by adding aliases ────────────────────────────
  const alreadyFixed = new Set()
  for (const [, page] of Object.entries(pageData)) {
    const links = [...page.content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)]
    for (const m of links) {
      const text = m[1].trim()
      if (resolveLink(text, titleMap)) continue  // already resolves
      const key = text.toLowerCase()
      if (alreadyFixed.has(key)) continue
      const noParens = normText(text)
      let best = null
      for (const file of files) {
        const id = file.replace(/\.md$/, '')
        const stem = path.basename(id).replace(/-/g, ' ').toLowerCase()
        const { data } = matter(fs.readFileSync(path.join(WIKI_PATH, file), 'utf8'))
        const title = normText(data.title || '')
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
        const parsed = matter(fs.readFileSync(fullPath, 'utf8'))
        parsed.data.aliases = aliases
        fs.writeFileSync(fullPath, matter.stringify(parsed.content, parsed.data))
        alreadyFixed.add(key)
        fixes.push({ type: 'alias', detail: `"${text}" → ${best.file}` })
      }
    }
  }

  // ── 2. Fix isolated components by adding one bridge edge per cluster ────────
  // Detect components on the (potentially alias-fixed) pageData
  const { components: comps } = buildComponents(pageData, titleMap)
  const mainSet = new Set(comps[0] || [])

  for (const component of comps.slice(1)) {
    // pick the node with the most internal edges as representative
    const { adj: adjComp } = buildComponents(
      Object.fromEntries(component.map(id => [id, pageData[id]])), titleMap
    )
    const rep = component.reduce((best, id) =>
      (adjComp[id]?.size || 0) > (adjComp[best]?.size || 0) ? id : best, component[0])
    const repPage = pageData[rep]
    if (!repPage) continue

    // find best matching main-graph content page by word overlap
    const repText = repPage.title + ' ' + repPage.content
    let bestId = null, bestScore = 0
    for (const mainId of mainSet) {
      if (navIds.has(mainId) || mainId.startsWith('sources/')) continue
      const mp = pageData[mainId]
      if (!mp) continue
      const score = overlapScore(repText, mp.title + ' ' + mp.content)
      if (score > bestScore) { bestScore = score; bestId = mainId }
    }

    // if no overlap found, just pick the first non-nav main page
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
    const { data, content } = matter(raw)
    return { file, title: data.title || file, content }
  })
  const scored = pages.map(p => ({
    ...p,
    score: scoreRelevance(question, p.title + ' ' + p.content)
  })).sort((a, b) => b.score - a.score)
  const top = scored.slice(0, 10).filter(p => p.score > 0)
  const sources = top.map(p => p.file)
  const context = top.map(p =>
    `## ${p.title} [${p.file}]\n${p.content.slice(0, 4000)}`
  ).join('\n\n---\n\n')
  const sysPrompt = `你是一个个人知识库助手。以下是知识库中与问题最相关的页面（按相关度排序）。
请优先基于这些页面内容回答，尤其是页面中与问题直接相关的具体内容、观点和建议。
如果某个页面包含直接相关内容，请明确引用它（如：根据《页面标题》…）。
若知识库中确实没有相关信息，再结合自身知识回答，但需注明"以下来自通用知识"。
${QUERY_LANG_INSTRUCTION}

${context}`
  let answer = ''
  for await (const text of streamLLM(sysPrompt, question, 2048)) answer += text
  return { answer, sources }
}

app.post('/api/query', express.json(), async (req, res) => {
  const { question } = req.body
  if (!question) return res.status(400).json({ error: 'Missing question' })

  const files = globSync('**/*.md', { cwd: WIKI_PATH, ignore: ['index.md'] })
  const pages = files.map(file => {
    const raw = fs.readFileSync(path.join(WIKI_PATH, file), 'utf8')
    const { data, content } = matter(raw)
    return { file, title: data.title || file, content }
  })
  const scored = pages.map(p => ({
    ...p,
    score: scoreRelevance(question, p.title + ' ' + p.content)
  })).sort((a, b) => b.score - a.score)
  const top = scored.slice(0, 10).filter(p => p.score > 0)
  const selected = top.map(p => p.file)
  const context = top.map(p =>
    `## ${p.title} [${p.file}]\n${p.content.slice(0, 4000)}`
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
    for await (const text of streamLLM(sysPrompt, question, 2048)) {
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
