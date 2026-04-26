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
let simulation, linkSel, nodeSel, labelSel
let activeFilter = 'all'

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

  setupMenu()
  setupGraph()
  setupQuery()
  setupFiles()
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

  const g = root.append('g')

  root.call(d3.zoom().scaleExtent([0.15, 5]).on('zoom', e => g.attr('transform', e.transform)))

  const simNodes = nodes.map(n => ({ ...n }))
  const idx = Object.fromEntries(simNodes.map(n => [n.id, n]))

  const simEdges = edges
    .filter(e => idx[e.source?.id ?? e.source] && idx[e.target?.id ?? e.target])
    .map(e => ({ source: e.source?.id ?? e.source, target: e.target?.id ?? e.target }))

  const radius = Math.min(width, height) * 0.38
  simulation = d3.forceSimulation(simNodes)
    .force('link', d3.forceLink(simEdges).id(d => d.id).distance(80).strength(0.5))
    .force('charge', d3.forceManyBody().strength(-320))
    .force('center', d3.forceCenter(width / 2, height / 2).strength(0.08))
    .force('radial', d3.forceRadial(radius, width / 2, height / 2).strength(0.07))
    .force('collision', d3.forceCollide().radius(d => (NODE_R[d.type] || 6) + 10))

  linkSel = g.append('g').selectAll('line').data(simEdges).join('line')
    .attr('stroke', '#2d3148').attr('stroke-width', 1.5)

  nodeSel = g.append('g').selectAll('circle').data(simNodes).join('circle')
    .attr('r', d => NODE_R[d.type] || 6)
    .attr('fill', d => NODE_COLOR[d.type] || NODE_COLOR.unknown)
    .attr('stroke', '#0f1117').attr('stroke-width', 2)
    .attr('cursor', 'pointer')
    .on('mouseover', onHover)
    .on('mouseout',  onHoverOut)
    .on('click',     onNodeClick)
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y })
      .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y })
      .on('end',   (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null })
    )

  labelSel = g.append('g').selectAll('text').data(simNodes).join('text')
    .text(d => d.title.length > 16 ? d.title.slice(0, 16) + '…' : d.title)
    .attr('font-size', 10.5)
    .attr('fill', '#64748b')
    .attr('pointer-events', 'none')
    .attr('dx', d => (NODE_R[d.type] || 6) + 5)
    .attr('dy', 4)

  simulation.on('tick', () => {
    linkSel.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x).attr('y2', d => d.target.y)
    nodeSel.attr('cx', d => d.x).attr('cy', d => d.y)
    labelSel.attr('x', d => d.x).attr('y', d => d.y)
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

  nodeSel.attr('opacity', n => neighbors.has(n.id) ? 1 : 0.12)
  linkSel.attr('opacity', e =>
    (e.source.id ?? e.source) === d.id || (e.target.id ?? e.target) === d.id ? 1 : 0.04
  ).attr('stroke', e =>
    (e.source.id ?? e.source) === d.id || (e.target.id ?? e.target) === d.id
      ? NODE_COLOR[d.type] : '#2d3148'
  )
  labelSel.attr('opacity', n => neighbors.has(n.id) ? 1 : 0.08)
}

function onHoverOut() {
  document.getElementById('tooltip').style.opacity = 0
  if (nodeSel) { nodeSel.attr('opacity', 1); linkSel.attr('opacity', 1).attr('stroke', '#2d3148'); labelSel.attr('opacity', 1) }
}

async function onNodeClick(event, d) {
  const panel = document.getElementById('node-panel')
  panel.classList.add('open')

  const b = BADGE[d.type] || BADGE.unknown
  const badge = document.getElementById('node-type-badge')
  badge.textContent = d.type
  badge.style.background = b.bg
  badge.style.color = b.color

  document.getElementById('node-title').textContent = d.title
  document.getElementById('node-content').innerHTML = '<span class="cursor"></span>'

  const data = await fetch(`/api/page/${encodeURIComponent(d.file.replace('.md', ''))}`).then(r => r.json())
  document.getElementById('node-content').innerHTML = data.html
}

function highlightNodes(matchedIds) {
  if (!nodeSel) return
  if (!matchedIds) {
    nodeSel.attr('opacity', 1); labelSel.attr('opacity', 1); linkSel.attr('opacity', 1)
    return
  }
  nodeSel.attr('opacity', n => matchedIds.has(n.id) ? 1 : 0.08)
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

  // auto-resize textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 160) + 'px'
  })

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doQuery() }
  })

  btn.addEventListener('click', doQuery)

  // suggestion chips
  document.querySelectorAll('.suggestion').forEach(s => {
    s.addEventListener('click', () => {
      input.value = s.dataset.q
      input.dispatchEvent(new Event('input'))
      doQuery()
    })
  })
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
    <div class="msg-body"><span class="cursor"></span></div>
  `
  messages.appendChild(aMsg)
  messages.scrollTop = messages.scrollHeight

  const body = aMsg.querySelector('.msg-body')
  let raw = ''

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
            // show which pages were selected
            sourcesEl = document.createElement('div')
            sourcesEl.className = 'msg-sources'
            sourcesEl.innerHTML = `<span class="sources-label">参考页面：</span>` +
              parsed.sources.map(s => `<span class="source-chip">${s.replace(/^.*\//, '').replace(/\.md$/, '')}</span>`).join('')
            aMsg.querySelector('.msg-assistant-header').after(sourcesEl)
          }
          if (parsed.error) { raw += `\n\n**错误：** ${parsed.error}`; break }
          if (parsed.text)  raw += parsed.text
        } catch {}
      }
      body.innerHTML = marked.parse(raw) + '<span class="cursor"></span>'
      messages.scrollTop = messages.scrollHeight
    }
  } catch (e) {
    raw = `请求失败：${e.message}`
  }

  body.innerHTML = marked.parse(raw)
  messages.scrollTop = messages.scrollHeight
  document.getElementById('send-btn').disabled = false
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
      btn.style.display = !q || btn.textContent.toLowerCase().includes(q) ? '' : 'none'
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

// ── Ingest View ──────────────────────────────────────────────────────────────

function setupIngest() {
  const dropZone = document.getElementById('drop-zone')
  const fileInput = document.getElementById('file-input')
  let selectedFiles = []

  dropZone.addEventListener('click', (e) => {
    if (e.target.closest('label')) return
    fileInput.click()
  })
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over') })
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
  dropZone.addEventListener('drop', e => {
    e.preventDefault()
    dropZone.classList.remove('drag-over')
    setFiles([...e.dataTransfer.files])
  })

  fileInput.addEventListener('change', () => setFiles([...fileInput.files]))

  function setFiles(files) {
    selectedFiles = files.filter(f => f.name.endsWith('.md') || f.name.endsWith('.txt'))
    if (!selectedFiles.length) return
    document.getElementById('drop-label').textContent = selectedFiles.map(f => f.name).join(', ')
    document.getElementById('drop-sub').textContent = `${selectedFiles.length} 个文件已选择`
    const btn = document.getElementById('ingest-file-btn')
    btn.style.display = 'block'
    btn.textContent = `上传 ${selectedFiles.length} 个文件`
  }

  document.getElementById('ingest-file-btn').addEventListener('click', () => {
    if (!selectedFiles.length) return
    runUpload(selectedFiles)
  })

}

async function runUpload(files) {
  const btn = document.getElementById('ingest-file-btn')
  btn.disabled = true
  const fd = new FormData()
  files.forEach(f => fd.append('files', f))

  const logWrap = document.getElementById('ingest-log-wrap')
  const logEl = document.getElementById('ingest-log')
  logWrap.style.display = 'block'
  logEl.innerHTML = ''

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
  } catch (e) {
    const err = document.createElement('div')
    err.className = 'log-item error'
    err.innerHTML = `<span>✕</span><span>${e.message}</span>`
    logEl.appendChild(err)
  }
  btn.disabled = false
}


// ── Lint View ─────────────────────────────────────────────────────────────────

function setupLint() {
  document.getElementById('lint-btn').addEventListener('click', runLint)
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

  // show fix button if there are errors or warnings (both are fixable)
  if (errors > 0 || warnings > 0) {
    let fixBtn = document.getElementById('lint-fix-btn')
    if (!fixBtn) {
      fixBtn = document.createElement('button')
      fixBtn.id = 'lint-fix-btn'
      fixBtn.className = 'lint-fix-btn'
      fixBtn.textContent = `自动修复断链 + 孤岛 (${errors + warnings} 项)`
      document.getElementById('lint-header').appendChild(fixBtn)
      fixBtn.addEventListener('click', runLintFix)
    } else {
      fixBtn.textContent = `自动修复断链 + 孤岛 (${errors + warnings} 项)`
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
