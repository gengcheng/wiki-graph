// ── Constants ───────────────────────────────────────────────────────────────

const NODE_COLOR = {
  entity:  '#4e9af1',
  concept: '#f1a84e',
  topic:   '#4ef1a0',
  source:  '#c084fc',
  unknown: '#94a3b8'
}

const NODE_R = { entity: 9, concept: 8, topic: 8, source: 6, unknown: 6 }

const BADGE = {
  entity:  { bg: '#1e3a5f', color: '#4e9af1' },
  concept: { bg: '#3d2e10', color: '#f1a84e' },
  topic:   { bg: '#0e3320', color: '#4ef1a0' },
  source:  { bg: '#2e1a4a', color: '#c084fc' },
  unknown: { bg: '#1a1d27', color: '#94a3b8' }
}

const GROUP_LABEL = { entity: '实体', concept: '概念', topic: '主题', source: '源', unknown: '其他' }

// ── State ───────────────────────────────────────────────────────────────────

let allNodes = [], allEdges = []
let simulation, linkSel, nodeSel, labelSel, glowSel
let activeFilter = 'all'
let currentConversationId = null

function genConvId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function initConversation() {
  currentConversationId = genConvId()
}

// ── Init ────────────────────────────────────────────────────────────────────

async function fetchData() {
  const { nodes, edges } = await fetch('/api/graph?t=' + Date.now()).then(r => r.json())
  allNodes = nodes
  allEdges = edges
  document.getElementById('kb-stats').innerHTML =
    `${nodes.length} 个页面<br>${edges.length} 条连接`
}

async function init() {
  await fetchData()
  initConversation()

  setupMenu()
  setupGraph()
  setupQuery()
  setupFiles()
  setupTags()
  setupIngest()
  setupLint()
}

// ── Menu ────────────────────────────────────────────────────────────────────

function setupMenu() {
  document.querySelectorAll('.menu-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.menu-item').forEach(b => b.classList.remove('active'))
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'))
      btn.classList.add('active')
      document.getElementById('view-' + btn.dataset.view).classList.add('active')
      if (btn.dataset.view === 'graph') fetchData().then(redrawGraph)
    })
  })
}

// ── Graph View ───────────────────────────────────────────────────────────────

function setupGraph() {
  // filters
  document.querySelectorAll('.filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      activeFilter = btn.dataset.type
      redrawGraph()
    })
  })

  // search
  document.getElementById('graph-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim()
    highlightNodes(q ? new Set(allNodes.filter(n => n.title.toLowerCase().includes(q)).map(n => n.id)) : null)
  })

  // close panel
  document.getElementById('node-panel-close').addEventListener('click', () => {
    document.getElementById('node-panel').classList.remove('open')
  })

  if (document.getElementById('view-graph').classList.contains('active')) redrawGraph()
}

function redrawGraph() {
  const filtered = activeFilter === 'all' ? allNodes : allNodes.filter(n => n.type === activeFilter)
  const filteredIds = new Set(filtered.map(n => n.id))
  const filteredEdges = allEdges.filter(e =>
    filteredIds.has(e.source?.id ?? e.source) && filteredIds.has(e.target?.id ?? e.target)
  )
  drawGraph(filtered, filteredEdges)
}

function drawGraph(nodes, edges) {
  if (simulation) simulation.stop()

  const svg = document.getElementById('graph')
  const width = svg.clientWidth || svg.parentElement.clientWidth
  const height = svg.clientHeight || svg.parentElement.clientHeight

  d3.select('#graph').selectAll('*').remove()

  const root = d3.select('#graph')
    .attr('width', width)
    .attr('height', height)

  // Subtle depth gradient background
  const defs = root.append('defs')
  const bgGrad = defs.append('radialGradient').attr('id', 'graph-bg')
  bgGrad.append('stop').attr('offset', '0%').attr('stop-color', '#161929')
  bgGrad.append('stop').attr('offset', '100%').attr('stop-color', '#0f1117')
  root.append('rect')
    .attr('width', width).attr('height', height)
    .attr('fill', 'url(#graph-bg)').attr('pointer-events', 'none')

  const g = root.append('g')
  root.call(d3.zoom().scaleExtent([0.15, 5]).on('zoom', e => g.attr('transform', e.transform)))

  const simNodes = nodes.map(n => ({ ...n }))
  const idx = Object.fromEntries(simNodes.map(n => [n.id, n]))

  // Compute per-node degree for size scaling
  const degree = {}
  for (const n of simNodes) degree[n.id] = 0
  const simEdges = edges
    .filter(e => idx[e.source?.id ?? e.source] && idx[e.target?.id ?? e.target])
    .map(e => {
      const s = e.source?.id ?? e.source
      const t = e.target?.id ?? e.target
      degree[s] = (degree[s] || 0) + 1
      degree[t] = (degree[t] || 0) + 1
      return { source: s, target: t }
    })

  // Hub nodes grow up to 2× base size
  function nodeR(d) {
    return (NODE_R[d.type] || 6) + Math.min(Math.sqrt(degree[d.id] || 0) * 1.6, 10)
  }

  const radius = Math.min(width, height) * 0.36
  simulation = d3.forceSimulation(simNodes)
    .force('link', d3.forceLink(simEdges).id(d => d.id).distance(90).strength(0.4))
    .force('charge', d3.forceManyBody().strength(d => -300 - (degree[d.id] || 0) * 18))
    .force('center', d3.forceCenter(width / 2, height / 2).strength(0.07))
    .force('radial', d3.forceRadial(radius, width / 2, height / 2).strength(0.06))
    .force('collision', d3.forceCollide().radius(d => nodeR(d) + 14))

  // Curved links (quadratic bezier, 15% perpendicular offset)
  linkSel = g.append('g').selectAll('path').data(simEdges).join('path')
    .attr('fill', 'none')
    .attr('stroke', 'rgba(90,110,175,0.28)')
    .attr('stroke-width', 1)

  // Glow halos behind nodes
  glowSel = g.append('g').selectAll('circle').data(simNodes).join('circle')
    .attr('r', d => nodeR(d) + 8)
    .attr('fill', d => NODE_COLOR[d.type] || NODE_COLOR.unknown)
    .attr('opacity', 0.1)
    .attr('pointer-events', 'none')

  // Main nodes
  nodeSel = g.append('g').selectAll('circle').data(simNodes).join('circle')
    .attr('r', d => nodeR(d))
    .attr('fill', d => NODE_COLOR[d.type] || NODE_COLOR.unknown)
    .attr('stroke', d => (NODE_COLOR[d.type] || NODE_COLOR.unknown) + '50')
    .attr('stroke-width', 2.5)
    .attr('cursor', 'pointer')
    .on('mouseover', onHover)
    .on('mouseout',  onHoverOut)
    .on('click',     onNodeClick)
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y })
      .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y })
      .on('end',   (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null })
    )

  // Labels — dark outline (paint-order: stroke) prevents overlap clutter
  labelSel = g.append('g').selectAll('text').data(simNodes).join('text')
    .text(d => d.title.length > 14 ? d.title.slice(0, 14) + '…' : d.title)
    .attr('font-size', 10)
    .attr('fill', '#8a97ae')
    .attr('pointer-events', 'none')

  function linkPath(d) {
    const sx = d.source.x, sy = d.source.y
    const tx = d.target.x, ty = d.target.y
    const cx = (sx + tx) / 2 - (ty - sy) * 0.15
    const cy = (sy + ty) / 2 + (tx - sx) * 0.15
    return `M${sx},${sy} Q${cx},${cy} ${tx},${ty}`
  }

  simulation.on('tick', () => {
    linkSel.attr('d', linkPath)
    glowSel.attr('cx', d => d.x).attr('cy', d => d.y)
    nodeSel.attr('cx', d => d.x).attr('cy', d => d.y)
    labelSel.attr('x', d => d.x + nodeR(d) + 4).attr('y', d => d.y + 3.5)
  })
}

function onHover(event, d) {
  const tip = document.getElementById('tooltip')
  tip.textContent = d.title
  tip.style.opacity = 1
  tip.style.left = (event.offsetX + 14) + 'px'
  tip.style.top  = (event.offsetY - 8)  + 'px'

  const neighbors = new Set([d.id])
  linkSel.each(e => {
    if ((e.source.id ?? e.source) === d.id) neighbors.add(e.target.id ?? e.target)
    if ((e.target.id ?? e.target) === d.id) neighbors.add(e.source.id ?? e.source)
  })

  nodeSel.attr('opacity', n => neighbors.has(n.id) ? 1 : 0.1)
  glowSel.attr('opacity', n => n.id === d.id ? 0.35 : neighbors.has(n.id) ? 0.18 : 0.02)
  linkSel.attr('opacity', e =>
    (e.source.id ?? e.source) === d.id || (e.target.id ?? e.target) === d.id ? 0.9 : 0.03
  ).attr('stroke', e =>
    (e.source.id ?? e.source) === d.id || (e.target.id ?? e.target) === d.id
      ? NODE_COLOR[d.type] + 'cc' : 'rgba(90,110,175,0.28)'
  ).attr('stroke-width', e =>
    (e.source.id ?? e.source) === d.id || (e.target.id ?? e.target) === d.id ? 1.5 : 1
  )
  labelSel.attr('opacity', n => neighbors.has(n.id) ? 1 : 0.06)
}

function onHoverOut() {
  document.getElementById('tooltip').style.opacity = 0
  if (nodeSel) {
    nodeSel.attr('opacity', 1)
    glowSel.attr('opacity', 0.1)
    linkSel.attr('opacity', 1).attr('stroke', 'rgba(90,110,175,0.28)').attr('stroke-width', 1)
    labelSel.attr('opacity', 1)
  }
}

async function openPageInPanel(pageId) {
  document.getElementById('node-panel').classList.add('open')

  const node = allNodes.find(n => n.id === pageId)
  const nodeType = node?.type || 'unknown'
  const b = BADGE[nodeType] || BADGE.unknown
  const badge = document.getElementById('node-type-badge')
  badge.textContent = nodeType
  badge.style.background = b.bg
  badge.style.color = b.color

  document.getElementById('node-title').textContent = node?.title || pageId.split('/').pop()
  document.getElementById('node-content').innerHTML = '<span class="cursor"></span>'

  const data = await fetch(`/api/page/${encodeURIComponent(pageId)}`).then(r => r.json())
  document.getElementById('node-content').innerHTML = data.html

  document.querySelectorAll('#node-content a[href^="wiki:"]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault()
      openPageInPanel(a.getAttribute('href').slice(5))
    })
  })
}

async function onNodeClick(event, d) {
  openPageInPanel(d.file.replace('.md', ''))
}

function highlightNodes(matchedIds) {
  if (!nodeSel) return
  if (!matchedIds) {
    nodeSel.attr('opacity', 1)
    glowSel.attr('opacity', 0.1)
    labelSel.attr('opacity', 1)
    linkSel.attr('opacity', 1)
    return
  }
  nodeSel.attr('opacity', n => matchedIds.has(n.id) ? 1 : 0.06)
  glowSel.attr('opacity', n => matchedIds.has(n.id) ? 0.22 : 0.02)
  labelSel.attr('opacity', n => matchedIds.has(n.id) ? 1 : 0.04)
  linkSel.attr('opacity', 0.04)
}

window.addEventListener('resize', () => {
  if (document.getElementById('view-graph').classList.contains('active')) redrawGraph()
})

// ── Query View ───────────────────────────────────────────────────────────────

function setupQuery() {
  const input = document.getElementById('query-input')
  const btn   = document.getElementById('send-btn')

  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 160) + 'px'
  })

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doQuery() }
  })

  btn.addEventListener('click', doQuery)

  document.getElementById('qpp-close').addEventListener('click', () => {
    document.getElementById('query-page-panel').classList.remove('open')
  })

  document.getElementById('query-main').addEventListener('click', e => {
    const panel = document.getElementById('query-page-panel')
    if (panel.classList.contains('open') && !panel.contains(e.target)) {
      panel.classList.remove('open')
    }
  })

  document.getElementById('new-chat-btn').addEventListener('click', () => {
    currentConversationId = genConvId()
    resetMessages()
    updateConvActiveState()
    document.getElementById('query-input').focus()
  })

  loadConversations()
}

function resetMessages() {
  document.getElementById('messages').innerHTML = `
    <div id="query-welcome">
      <div class="welcome-icon">✦</div>
      <h2>向知识库提问</h2>
      <p>基于你的 wiki 内容回答问题</p>
    </div>`
}

function convTimeLabel(ts) {
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function updateConvActiveState() {
  document.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === currentConversationId)
  })
}

async function loadConversations() {
  const list = document.getElementById('conv-list')
  if (!list) return
  try {
    const { conversations } = await fetch('/api/conversations').then(r => r.json())
    if (!conversations.length) {
      list.innerHTML = '<div class="conv-empty">暂无历史记录<br>开始提问后自动保存</div>'
      return
    }
    list.innerHTML = ''
    for (const conv of conversations) {
      const item = document.createElement('div')
      item.className = 'conv-item' + (conv.id === currentConversationId ? ' active' : '')
      item.dataset.id = conv.id
      item.style.display = 'flex'
      item.style.alignItems = 'center'
      item.style.gap = '6px'
      item.innerHTML = `
        <div class="conv-item-body">
          <div class="conv-preview">${escHtml(conv.preview)}</div>
          <div class="conv-time">${convTimeLabel(conv.timestamp)}</div>
        </div>
        <button class="conv-del" title="删除">✕</button>`
      item.querySelector('.conv-item-body').addEventListener('click', () => loadConversation(conv.id))
      item.querySelector('.conv-del').addEventListener('click', e => {
        e.stopPropagation()
        deleteConversation(conv.id, item)
      })
      list.appendChild(item)
    }
  } catch {
    list.innerHTML = '<div class="conv-empty">无法连接 Redis</div>'
  }
}

async function loadConversation(id) {
  currentConversationId = id
  updateConvActiveState()

  const messages = document.getElementById('messages')
  messages.innerHTML = '<div style="padding:24px;color:var(--muted);font-size:13px">加载中…</div>'

  try {
    const { messages: history } = await fetch(`/api/conversation/${id}`).then(r => r.json())
    messages.innerHTML = ''
    for (const entry of history) {
      const userMsg = document.createElement('div')
      userMsg.className = 'msg-user'
      userMsg.textContent = entry.question
      messages.appendChild(userMsg)

      const aMsg = document.createElement('div')
      aMsg.className = 'msg-assistant'
      aMsg.innerHTML = `
        <div class="msg-assistant-header"><span class="msg-assistant-icon">✦</span> Wiki Assistant</div>
        <div class="msg-body">${marked.parse(resolveWikilinks(entry.answer))}</div>`
      if (entry.sources && entry.sources.length) {
        const sourcesEl = document.createElement('div')
        sourcesEl.className = 'msg-sources'
        sourcesEl.innerHTML = `<span class="sources-label">参考页面：</span>` +
          entry.sources.map(s => {
            const id = s.replace(/\.md$/, '')
            const label = s.replace(/^.*\//, '').replace(/\.md$/, '')
            return `<span class="source-chip" data-id="${id}">${label}</span>`
          }).join('')
        sourcesEl.querySelectorAll('.source-chip[data-id]').forEach(chip => {
          chip.addEventListener('click', e => { e.stopPropagation(); openQueryPagePanel(chip.dataset.id) })
        })
        aMsg.querySelector('.msg-assistant-header').after(sourcesEl)
      }
      bindWikilinkClicks(aMsg.querySelector('.msg-body'))
      messages.appendChild(aMsg)
    }
    document.getElementById('messages-wrap').scrollTop = 999999
  } catch {
    messages.innerHTML = '<div style="padding:24px;color:#f87171;font-size:13px">加载失败</div>'
  }
}

async function deleteConversation(id, itemEl) {
  try {
    await fetch(`/api/conversation/${id}`, { method: 'DELETE' })
  } catch {}
  itemEl.remove()
  // if deleted conversation was active, start a new one
  if (id === currentConversationId) {
    currentConversationId = genConvId()
    resetMessages()
  }
  // show empty state if no items left
  const list = document.getElementById('conv-list')
  if (list && !list.querySelector('.conv-item')) {
    list.innerHTML = '<div class="conv-empty">暂无历史记录<br>开始提问后自动保存</div>'
  }
}

function resolveWikilinks(raw) {
  return raw.replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => {
    const text = (label || target).trim()
    const lc = target.trim().toLowerCase()
    const node = allNodes.find(n =>
      n.title.toLowerCase() === lc ||
      n.id.split('/').pop().toLowerCase().replace(/-/g, ' ') === lc ||
      n.id.toLowerCase() === lc
    )
    return node ? `[${text}](wiki:${node.id})` : `**${text}**`
  })
}

function bindWikilinkClicks(el) {
  el.querySelectorAll('a[href^="wiki:"]').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openQueryPagePanel(a.getAttribute('href').slice(5)) })
  })
}

async function openQueryPagePanel(pageId) {
  const panel = document.getElementById('query-page-panel')
  panel.classList.add('open')

  document.getElementById('qpp-badge').textContent = ''
  document.getElementById('qpp-title').textContent = pageId.split('/').pop()
  document.getElementById('qpp-content').innerHTML = '<span class="cursor"></span>'

  try {
    const data = await fetch(`/api/page/${encodeURIComponent(pageId)}`).then(r => r.json())
    const nodeType = data.meta?.type || 'unknown'
    const b = BADGE[nodeType] || BADGE.unknown
    const badge = document.getElementById('qpp-badge')
    badge.textContent = nodeType
    badge.style.background = b.bg
    badge.style.color = b.color
    document.getElementById('qpp-title').textContent = data.meta?.title || pageId.split('/').pop()
    document.getElementById('qpp-content').innerHTML = data.html
    document.querySelectorAll('#qpp-content a[href^="wiki:"]').forEach(a => {
      a.addEventListener('click', e => { e.preventDefault(); openQueryPagePanel(a.getAttribute('href').slice(5)) })
    })
  } catch {}
}

async function doQuery() {
  const input    = document.getElementById('query-input')
  const question = input.value.trim()
  if (!question) return

  input.value = ''
  input.style.height = 'auto'
  document.getElementById('send-btn').disabled = true

  // hide welcome
  const welcome = document.getElementById('query-welcome')
  if (welcome) welcome.style.display = 'none'

  const messages = document.getElementById('messages')

  // user bubble
  const userMsg = document.createElement('div')
  userMsg.className = 'msg-user'
  userMsg.textContent = question
  messages.appendChild(userMsg)

  // assistant bubble
  const aMsg = document.createElement('div')
  aMsg.className = 'msg-assistant'
  aMsg.innerHTML = `
    <div class="msg-assistant-header">
      <span class="msg-assistant-icon">✦</span> Wiki Assistant
    </div>
    <div class="msg-thinking"><span></span><span></span><span></span></div>
    <div class="msg-body" style="display:none"></div>
  `
  messages.appendChild(aMsg)
  messages.scrollTop = messages.scrollHeight

  const thinking = aMsg.querySelector('.msg-thinking')
  const body = aMsg.querySelector('.msg-body')
  let raw = ''
  let savedSources = []

  try {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question })
    })

    const reader  = res.body.getReader()
    const decoder = new TextDecoder()

    let sourcesEl = null
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') break
        try {
          const parsed = JSON.parse(data)
          if (parsed.sources) {
            savedSources = parsed.sources
            sourcesEl = document.createElement('div')
            sourcesEl.className = 'msg-sources'
            sourcesEl.innerHTML = `<span class="sources-label">参考页面：</span>` +
              parsed.sources.map(s => {
                const id = s.replace(/\.md$/, '')
                const label = s.replace(/^.*\//, '').replace(/\.md$/, '')
                return `<span class="source-chip" data-id="${id}">${label}</span>`
              }).join('')
            sourcesEl.querySelectorAll('.source-chip[data-id]').forEach(chip => {
              chip.addEventListener('click', e => { e.stopPropagation(); openQueryPagePanel(chip.dataset.id) })
            })
            aMsg.querySelector('.msg-assistant-header').after(sourcesEl)
          }
          if (parsed.error) { raw += `\n\n**错误：** ${parsed.error}`; break }
          if (parsed.text) {
            if (!raw) { thinking.style.display = 'none'; body.style.display = '' }
            raw += parsed.text
          }
        } catch {}
      }
      body.innerHTML = marked.parse(resolveWikilinks(raw)) + '<span class="cursor"></span>'
      messages.scrollTop = messages.scrollHeight
    }
  } catch (e) {
    raw = `请求失败：${e.message}`
  }

  thinking.style.display = 'none'
  body.style.display = ''
  body.innerHTML = marked.parse(resolveWikilinks(raw))
  bindWikilinkClicks(body)
  messages.scrollTop = messages.scrollHeight
  document.getElementById('send-btn').disabled = false

  if (currentConversationId && raw) {
    fetch('/api/conversation/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: currentConversationId, question, answer: raw, sources: savedSources })
    }).then(() => loadConversations()).catch(() => {})
  }
}

// ── Files View ───────────────────────────────────────────────────────────────

async function setupFiles() {
  const tree = document.getElementById('files-tree')

  // ── Wiki pages section ──────────────────────────────
  const wikiSection = document.createElement('div')
  wikiSection.className = 'files-section'
  wikiSection.innerHTML = '<div class="files-section-title">Wiki 页面</div>'

  const groups = {}
  for (const n of allNodes) {
    const g = n.type || 'unknown'
    if (!groups[g]) groups[g] = []
    groups[g].push(n)
  }

  for (const [type, nodes] of Object.entries(groups)) {
    wikiSection.appendChild(makeGroup(
      `<span class="dot ${type}"></span>${GROUP_LABEL[type] || type}`,
      nodes.sort((a, b) => a.title.localeCompare(b.title)).map(node => ({
        id: node.id,
        label: node.title,
        tags: node.tags || [],
        color: NODE_COLOR[type],
        onClick: btn => loadFile(node, btn)
      }))
    ))
  }

  tree.appendChild(wikiSection)

  // ── Raw files section ───────────────────────────────
  const rawSection = document.createElement('div')
  rawSection.className = 'files-section'
  rawSection.innerHTML = '<div class="files-section-title">原始文件</div>'

  const rawTree = await fetch('/api/raw/tree').then(r => r.json())

  for (const [folder, files] of Object.entries(rawTree).sort()) {
    const label = folder === '/' ? '根目录' : folder.split('/').pop()
    rawSection.appendChild(makeGroup(
      `<span style="font-size:11px;opacity:.6">◫</span> ${label}`,
      files.map(f => ({
        label: f.name,
        color: '#64748b',
        onClick: btn => loadRawFile(f.file, f.name, btn)
      })),
      true  // collapsed by default
    ))
  }

  tree.appendChild(rawSection)

  // ── Search ─────────────────────────────────────────
  document.getElementById('files-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim()
    document.querySelectorAll('.file-item').forEach(btn => {
      btn.style.display = !q || btn.textContent.toLowerCase().includes(q) || btn.dataset.tags.includes(q) ? '' : 'none'
    })
    document.querySelectorAll('.files-group').forEach(g => {
      const visible = [...g.querySelectorAll('.file-item')].some(b => b.style.display !== 'none')
      g.style.display = visible ? '' : 'none'
      if (q && visible) g.classList.remove('collapsed')
    })
    document.querySelectorAll('.files-section').forEach(s => {
      const visible = [...s.querySelectorAll('.file-item')].some(b => b.style.display !== 'none')
      s.style.display = visible ? '' : 'none'
    })
  })
}

function makeGroup(headerHTML, items, collapsed = false) {
  const group = document.createElement('div')
  group.className = 'files-group' + (collapsed ? ' collapsed' : '')

  const header = document.createElement('div')
  header.className = 'files-group-header'
  header.innerHTML = `<span class="files-group-arrow">▾</span>${headerHTML} <span style="color:#4a5070;margin-left:auto">${items.length}</span>`
  header.addEventListener('click', () => group.classList.toggle('collapsed'))

  const itemsEl = document.createElement('div')
  itemsEl.className = 'files-group-items'

  for (const item of items) {
    const btn = document.createElement('button')
    btn.className = 'file-item'
    btn.dataset.id = item.id || ''
    btn.dataset.tags = (item.tags || []).join(' ').toLowerCase()
    btn.innerHTML = `<span class="file-dot" style="background:${item.color}"></span>${item.label}`
    btn.title = item.label
    btn.addEventListener('click', () => item.onClick(btn))
    itemsEl.appendChild(btn)
  }

  group.appendChild(header)
  group.appendChild(itemsEl)
  return group
}

async function loadRawFile(filePath, name, btn) {
  document.querySelectorAll('.file-item').forEach(b => b.classList.remove('active'))
  btn.classList.add('active')

  document.getElementById('files-welcome').style.display = 'none'
  document.getElementById('file-header').style.display = 'flex'

  const badge = document.getElementById('file-type-badge')
  badge.textContent = 'raw'
  badge.style.background = '#1e2535'
  badge.style.color = '#64748b'

  document.getElementById('file-title').textContent = name
  document.getElementById('file-body').innerHTML = '<span class="cursor"></span>'

  const data = await fetch(`/api/raw/file/${encodeURIComponent(filePath)}`).then(r => r.json())
  document.getElementById('file-body').innerHTML = data.html || `<p style="color:#64748b">文件内容为空</p>`
}

async function loadFile(node, btn) {
  document.querySelectorAll('.file-item').forEach(b => b.classList.remove('active'))
  btn.classList.add('active')

  document.getElementById('files-welcome').style.display = 'none'
  document.getElementById('file-header').style.display = 'flex'

  const b = BADGE[node.type] || BADGE.unknown
  const badge = document.getElementById('file-type-badge')
  badge.textContent = node.type
  badge.style.background = b.bg
  badge.style.color = b.color

  document.getElementById('file-title').textContent = node.title
  document.getElementById('file-body').innerHTML = '<span class="cursor"></span>'

  const pageId = node.file.replace('.md', '')
  const [data, blData] = await Promise.all([
    fetch(`/api/page/${encodeURIComponent(pageId)}`).then(r => r.json()),
    fetch(`/api/backlinks/${encodeURIComponent(pageId)}`).then(r => r.json())
  ])

  let html = data.html

  if (blData.backlinks && blData.backlinks.length > 0) {
    const items = blData.backlinks.map(n => {
      const badge = BADGE[n.type] || BADGE.unknown
      return `<span class="bl-item" data-id="${n.id}" data-type="${n.type}">`
        + `<span class="bl-dot" style="background:${badge.bg};color:${badge.color}">${n.type[0].toUpperCase()}</span>`
        + `${n.title}</span>`
    }).join('')
    html += `<div id="backlinks-section"><span class="bl-label">← 被引用</span>${items}</div>`
  }

  document.getElementById('file-body').innerHTML = html

  document.querySelectorAll('.bl-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id
      const match = Array.from(document.querySelectorAll('.file-item'))
        .find(b => b.dataset.id === id)
      if (match) match.click()
    })
  })
}

// ── Tags View ────────────────────────────────────────────────────────────────

async function openTagsPagePanel(pageId) {
  const panel = document.getElementById('tags-page-panel')
  panel.classList.add('open')
  document.getElementById('tpp-badge').textContent = ''
  document.getElementById('tpp-title').textContent = pageId.split('/').pop()
  document.getElementById('tpp-content').innerHTML = '<span class="cursor"></span>'
  try {
    const data = await fetch(`/api/page/${encodeURIComponent(pageId)}`).then(r => r.json())
    const nodeType = data.meta?.type || 'unknown'
    const b = BADGE[nodeType] || BADGE.unknown
    const badge = document.getElementById('tpp-badge')
    badge.textContent = nodeType
    badge.style.background = b.bg
    badge.style.color = b.color
    document.getElementById('tpp-title').textContent = data.meta?.title || pageId.split('/').pop()
    document.getElementById('tpp-content').innerHTML = data.html
    document.querySelectorAll('#tpp-content a[href^="wiki:"]').forEach(a => {
      a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openTagsPagePanel(a.getAttribute('href').slice(5)) })
    })
  } catch {}
}

async function setupTags() {
  document.getElementById('tpp-close').addEventListener('click', () => {
    document.getElementById('tags-page-panel').classList.remove('open')
  })

  document.getElementById('tags-main').addEventListener('click', e => {
    const panel = document.getElementById('tags-page-panel')
    if (panel.classList.contains('open') && !panel.contains(e.target)) {
      panel.classList.remove('open')
    }
  })

  let allTags = []
  try {
    const res = await fetch('/api/tags').then(r => r.json())
    allTags = res.tags
  } catch { return }

  const listEl = document.getElementById('tags-list')

  function renderTagList(filter = '') {
    listEl.innerHTML = ''
    const filtered = filter ? allTags.filter(({ tag }) => tag.toLowerCase().includes(filter)) : allTags
    for (const { tag, count } of filtered) {
      const item = document.createElement('div')
      item.className = 'tags-list-item'
      item.innerHTML = `
        <span class="tags-list-name">${tag}</span>
        <span class="tags-list-actions">
          <button class="tags-list-action rename" title="重命名">✎</button>
          <button class="tags-list-action delete" title="删除">✕</button>
        </span>
        <span class="tags-list-count">${count}</span>
      `
      item.querySelector('.tags-list-name').addEventListener('click', () => selectTag(tag, item))
      item.querySelector('.tags-list-count').addEventListener('click', () => selectTag(tag, item))

      item.querySelector('.rename').addEventListener('click', e => {
        e.stopPropagation()
        startRename(item, tag)
      })

      item.querySelector('.delete').addEventListener('click', async e => {
        e.stopPropagation()
        if (!confirm(`删除标签「${tag}」？将从 ${count} 个页面中移除。`)) return
        await fetch(`/api/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' })
        allTags = allTags.filter(t => t.tag !== tag)
        allNodes.forEach(n => { if (n.tags) n.tags = n.tags.filter(t => t !== tag) })
        renderTagList(document.getElementById('tags-sidebar-search').value.toLowerCase().trim())
      })

      listEl.appendChild(item)
    }
  }

  function startRename(item, oldTag) {
    const nameEl = item.querySelector('.tags-list-name')
    const countEl = item.querySelector('.tags-list-count')
    const actionsEl = item.querySelector('.tags-list-actions')
    nameEl.style.display = 'none'
    countEl.style.display = 'none'
    actionsEl.style.display = 'none'

    const input = document.createElement('input')
    input.className = 'tags-list-rename'
    input.value = oldTag
    item.insertBefore(input, nameEl)
    input.focus()
    input.select()

    async function commitRename() {
      const newTag = input.value.trim()
      input.remove()
      nameEl.style.display = ''
      countEl.style.display = ''
      actionsEl.style.display = ''
      if (!newTag || newTag === oldTag) return
      await fetch(`/api/tags/${encodeURIComponent(oldTag)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newTag })
      })
      allTags = allTags.map(t => t.tag === oldTag ? { ...t, tag: newTag } : t)
      allNodes.forEach(n => {
        if (n.tags) n.tags = n.tags.map(t => t === oldTag ? newTag : t)
      })
      renderTagList(document.getElementById('tags-sidebar-search').value.toLowerCase().trim())
    }

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) commitRename()
      if (e.key === 'Escape') {
        input.remove()
        nameEl.style.display = ''
        countEl.style.display = ''
        actionsEl.style.display = ''
      }
    })
    input.addEventListener('blur', commitRename)
  }

  function selectTag(tag, itemEl) {
    document.querySelectorAll('.tags-list-item').forEach(i => i.classList.remove('active'))
    itemEl.classList.add('active')
    document.getElementById('tags-page-panel').classList.remove('open')

    const pages = allNodes.filter(n => (n.tags || []).map(String).includes(tag))
    const welcome = document.getElementById('tags-welcome')
    const pagesEl = document.getElementById('tags-pages')

    welcome.style.display = 'none'
    pagesEl.style.display = 'flex'
    pagesEl.innerHTML = `<div id="tags-pages-header">${tag} · ${pages.length} 个页面</div>`

    for (const node of pages.sort((a, b) => a.title.localeCompare(b.title))) {
      const b = BADGE[node.type] || BADGE.unknown
      const card = document.createElement('div')
      card.className = 'tag-page-card'
      const otherTags = (node.tags || []).filter(t => t !== tag).slice(0, 3)
      card.innerHTML = `
        <span class="tag-page-card-badge" style="background:${b.bg};color:${b.color}">${node.type || 'unknown'}</span>
        <span class="tag-page-card-title">${node.title}</span>
        <span class="tag-page-card-tags">${otherTags.map(t => `<span class="tag-page-card-tag">${t}</span>`).join('')}</span>
      `
      card.addEventListener('click', e => { e.stopPropagation(); openTagsPagePanel(node.id) })
      pagesEl.appendChild(card)
    }
  }

  renderTagList()

  document.getElementById('tags-sidebar-search').addEventListener('input', e => {
    renderTagList(e.target.value.toLowerCase().trim())
  })
}

// ── Ingest View ──────────────────────────────────────────────────────────────

function setupIngest() {
  const dropZone = document.getElementById('drop-zone')
  const fileInput = document.getElementById('file-input')
  let selectedFiles = []
  let ingestTags = []

  // ── Tag input ──────────────────────────────────────────────────────────────
  const tagsWrap = document.getElementById('tags-chips-wrap')
  const tagsInput = document.getElementById('tags-input')

  function addTag(raw) {
    const tag = raw.trim().replace(/,+$/, '').trim()
    if (!tag || ingestTags.includes(tag)) return
    ingestTags.push(tag)
    renderTags()
  }

  function removeTag(tag) {
    ingestTags = ingestTags.filter(t => t !== tag)
    renderTags()
  }

  function renderTags() {
    const chips = document.getElementById('tags-chips')
    chips.innerHTML = ingestTags.map(t => `
      <span class="tag-chip">
        ${t}
        <button class="tag-chip-remove" data-tag="${t}">✕</button>
      </span>
    `).join('')
    chips.querySelectorAll('.tag-chip-remove').forEach(b => {
      b.addEventListener('click', e => { e.stopPropagation(); removeTag(b.dataset.tag) })
    })
  }

  tagsInput.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ',') && !e.isComposing) {
      e.preventDefault()
      addTag(tagsInput.value)
      tagsInput.value = ''
    } else if (e.key === 'Backspace' && tagsInput.value === '' && ingestTags.length) {
      removeTag(ingestTags[ingestTags.length - 1])
    }
  })

  tagsInput.addEventListener('blur', () => {
    if (tagsInput.value.trim()) { addTag(tagsInput.value); tagsInput.value = '' }
  })

  tagsWrap.addEventListener('click', () => tagsInput.focus())

  // ── File drop ──────────────────────────────────────────────────────────────
  dropZone.addEventListener('click', e => { if (!e.target.closest('label')) fileInput.click() })
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over') })
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
  dropZone.addEventListener('drop', e => {
    e.preventDefault()
    dropZone.classList.remove('drag-over')
    addFiles([...e.dataTransfer.files])
  })
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = '' })

  function addFiles(files) {
    const valid = files.filter(f => f.name.endsWith('.md') || f.name.endsWith('.txt'))
    const existing = new Set(selectedFiles.map(f => f.name))
    for (const f of valid) if (!existing.has(f.name)) selectedFiles.push(f)
    renderFileList()
  }

  function removeFile(i) {
    selectedFiles.splice(i, 1)
    renderFileList()
  }

  function renderFileList() {
    const list = document.getElementById('file-list')
    const btn = document.getElementById('ingest-file-btn')
    list.innerHTML = selectedFiles.map((f, i) => `
      <div class="file-entry">
        <span class="file-entry-name">${f.name}</span>
        <span class="file-entry-size">${(f.size / 1024).toFixed(1)} KB</span>
        <button class="file-entry-remove" data-i="${i}">✕</button>
      </div>
    `).join('')
    list.querySelectorAll('.file-entry-remove').forEach(b => {
      b.addEventListener('click', () => removeFile(+b.dataset.i))
    })
    btn.disabled = selectedFiles.length === 0
    btn.textContent = selectedFiles.length > 0 ? `上传 ${selectedFiles.length} 个文件` : '上传文件'
  }

  document.getElementById('ingest-file-btn').addEventListener('click', () => {
    if (!selectedFiles.length) return
    const toUpload = [...selectedFiles]
    const tagsSnapshot = [...ingestTags]
    selectedFiles = []
    ingestTags = []
    renderFileList()
    renderTags()
    runUpload(toUpload, tagsSnapshot)
  })

  document.getElementById('run-now-btn').addEventListener('click', async () => {
    const btn = document.getElementById('run-now-btn')
    btn.disabled = true
    btn.textContent = '已触发'
    await fetch('/api/ingest/run-now', { method: 'POST' }).catch(() => {})
    setTimeout(() => pollIngestStatus(), 1500)
  })

  loadIngestStatus()
}

async function runUpload(files, tags = []) {
  const btn = document.getElementById('ingest-file-btn')
  btn.disabled = true

  const logWrap = document.getElementById('ingest-log-wrap')
  const logEl = document.getElementById('ingest-log')
  logWrap.style.display = 'block'
  logEl.innerHTML = ''
  document.getElementById('ingest-log-title').textContent = '上传结果'

  const fd = new FormData()
  files.forEach(f => fd.append('files', f))
  if (tags.length) fd.append('tags', JSON.stringify(tags))

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd }).then(r => r.json())
    for (const f of res.uploaded) {
      const item = document.createElement('div')
      item.className = 'log-item created'
      item.innerHTML = `<span>+</span><span>${f.filename} (${(f.size / 1024).toFixed(1)} KB)</span>`
      logEl.appendChild(item)
    }
    const done = document.createElement('div')
    done.className = 'log-item done'
    done.innerHTML = `<span>✓</span><span>${res.uploaded.length} 个文件已上传，等待自动处理</span>`
    logEl.appendChild(done)
    document.getElementById('ingest-log-title').textContent = '上传完成'
    loadIngestStatus()
  } catch (e) {
    const err = document.createElement('div')
    err.className = 'log-item error'
    err.innerHTML = `<span>✕</span><span>${e.message}</span>`
    logEl.appendChild(err)
  }
  btn.disabled = false
}

async function loadIngestStatus() {
  const info = document.getElementById('scheduler-info')
  const pendingSection = document.getElementById('pending-section')
  const pendingList = document.getElementById('pending-list')
  const runBtn = document.getElementById('run-now-btn')
  if (!info) return false
  try {
    const s = await fetch('/api/ingest/status').then(r => r.json())
    const lastRun = s.lastRun
      ? new Date(s.lastRun).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : null
    info.innerHTML = `
      <div class="sched-row">
        <span class="sched-dot ${s.running ? 'running' : s.enabled ? 'on' : 'off'}"></span>
        <span>${s.running ? '处理中' : s.enabled ? '已启用' : '已禁用'}</span>
        <span class="sched-cron">${s.schedule}</span>
      </div>
      ${lastRun && s.lastResult ? `<div class="sched-last">上次 ${lastRun} · ${s.lastResult}</div>` : ''}
    `
    runBtn.disabled = s.running
    runBtn.textContent = s.running ? '处理中…' : '立即处理'
    if (s.pending?.length) {
      pendingSection.style.display = ''
      pendingList.innerHTML = s.pending.map(f =>
        `<div class="pending-item"><span>◦</span><span>${f}</span></div>`
      ).join('')
    } else {
      pendingSection.style.display = 'none'
    }
    return s.running
  } catch {
    info.innerHTML = `<span class="sched-offline">服务未启动</span>`
    return false
  }
}

async function pollIngestStatus() {
  const running = await loadIngestStatus()
  if (running) setTimeout(pollIngestStatus, 2000)
}


// ── Lint View ─────────────────────────────────────────────────────────────────

async function loadLintSchedulerStatus() {
  const info = document.getElementById('lint-sched-info')
  try {
    const s = await fetch('/api/lint/status').then(r => r.json())
    document.getElementById('lint-sched-enabled').checked = s.enabled
    document.getElementById('lint-cron-input').value = s.schedule
    const lastRun = s.lastRun
      ? new Date(s.lastRun).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : null
    info.innerHTML = `
      <div class="sched-row">
        <span class="sched-dot ${s.running ? 'running' : s.enabled ? 'on' : 'off'}"></span>
        <span>${s.running ? '检查中' : s.enabled ? '已启用' : '已禁用'}</span>
        <span class="sched-cron">${s.schedule}</span>
      </div>
      ${lastRun && s.lastResult ? `<div class="sched-last">上次 ${lastRun} · ${s.lastResult}</div>` : ''}
    `
  } catch {
    info.innerHTML = `<span class="sched-offline">状态不可用</span>`
  }
}

function setupLint() {
  document.getElementById('lint-btn').addEventListener('click', runLint)
  loadLintSchedulerStatus()

  document.getElementById('lint-sched-enabled').addEventListener('change', async e => {
    await fetch('/api/lint/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: e.target.checked })
    })
    loadLintSchedulerStatus()
  })

  document.getElementById('lint-cron-save').addEventListener('click', async () => {
    const schedule = document.getElementById('lint-cron-input').value.trim()
    if (!schedule) return
    await fetch('/api/lint/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule })
    })
    loadLintSchedulerStatus()
  })
}

async function runLint() {
  const btn = document.getElementById('lint-btn')
  btn.disabled = true
  btn.textContent = '检查中…'

  const results = document.getElementById('lint-results')
  const stats = document.getElementById('lint-stats')
  results.innerHTML = ''
  stats.style.display = 'none'
  document.getElementById('stat-errors').textContent   = '0'
  document.getElementById('stat-warnings').textContent = '0'
  document.getElementById('stat-checks').textContent   = '0'

  let errors = 0, warnings = 0, checks = 0

  const addItem = (type, msg) => {
    const cfg = {
      log:     { icon: '·',  cls: 'lint-log' },
      section: { icon: '▸',  cls: 'lint-log' },
      error:   { icon: '✕',  cls: 'lint-error' },
      warning: { icon: '⚠',  cls: 'lint-warning' },
      check:   { icon: '✓',  cls: 'lint-check' },
      done:    { icon: '◈',  cls: 'lint-done' }
    }[type] || { icon: '·', cls: 'lint-log' }

    if (type === 'section') {
      const sep = document.createElement('div')
      sep.className = 'lint-section-header'
      sep.innerHTML = `<span>▸</span>${msg}`
      results.appendChild(sep)
      return
    }

    const item = document.createElement('div')
    item.className = `lint-item ${cfg.cls}`
    item.innerHTML = `<span class="lint-icon">${cfg.icon}</span><span>${msg}</span>`
    results.appendChild(item)
    results.scrollTop = results.scrollHeight

    if (type === 'error')   { errors++;   document.getElementById('stat-errors').textContent   = errors }
    if (type === 'warning') { warnings++; document.getElementById('stat-warnings').textContent = warnings }
    if (type === 'check')   { checks++;   document.getElementById('stat-checks').textContent   = checks }
    if (type === 'error' || type === 'warning' || type === 'check') {
      stats.style.display = 'flex'
    }
  }

  try {
    const res = await fetch('/api/lint')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.startsWith('data: ')) continue
        try {
          const { type, msg } = JSON.parse(line.slice(6))
          addItem(type, msg)
        } catch {}
      }
    }
  } catch (e) {
    addItem('error', e.message)
  }

  btn.disabled = false
  btn.textContent = '重新检查'

  // show fix button only when there are errors (warnings are informational only)
  if (errors > 0) {
    let fixBtn = document.getElementById('lint-fix-btn')
    if (!fixBtn) {
      fixBtn = document.createElement('button')
      fixBtn.id = 'lint-fix-btn'
      fixBtn.className = 'lint-fix-btn'
      fixBtn.textContent = `自动修复断链 + 孤岛 (${errors} 项)`
      document.getElementById('lint-header').appendChild(fixBtn)
      fixBtn.addEventListener('click', runLintFix)
    } else {
      fixBtn.textContent = `自动修复断链 + 孤岛 (${errors} 项)`
      fixBtn.style.display = ''
    }
  } else {
    const fixBtn = document.getElementById('lint-fix-btn')
    if (fixBtn) fixBtn.style.display = 'none'
  }
}

async function runLintFix() {
  const fixBtn = document.getElementById('lint-fix-btn')
  fixBtn.disabled = true
  fixBtn.textContent = '修复中…'
  try {
    const res = await fetch('/api/lint/fix', { method: 'POST' })
    const { fixed, details } = await res.json()
    const results = document.getElementById('lint-results')
    const sep = document.createElement('div')
    sep.className = 'lint-section-header'
    sep.innerHTML = `<span>▸</span>自动修复结果`
    results.appendChild(sep)
    if (fixed === 0) {
      const item = document.createElement('div')
      item.className = 'lint-item lint-log'
      item.innerHTML = `<span class="lint-icon">·</span><span>无可自动修复项（剩余断链需手动处理）</span>`
      results.appendChild(item)
    } else {
      for (const d of details) {
        const item = document.createElement('div')
        item.className = 'lint-item lint-check'
        const label = d.type === 'orphan'
          ? `孤岛修复: ${d.detail}`
          : `别名修复: ${d.detail}`
        item.innerHTML = `<span class="lint-icon">✓</span><span>${label}</span>`
        results.appendChild(item)
      }
    }
    results.scrollTop = results.scrollHeight
    fixBtn.textContent = `已修复 ${fixed} 项，重新检查`
    fixBtn.disabled = false
    fixBtn.onclick = runLint
    // refresh graph data so new edges are visible immediately
    fetchData()
  } catch (e) {
    fixBtn.textContent = `修复失败: ${e.message}`
    fixBtn.disabled = false
  }
}

// ── Start ────────────────────────────────────────────────────────────────────
init()
