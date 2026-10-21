<script>
  import { createEventDispatcher, onMount, onDestroy, tick } from 'svelte'
  import * as d3 from 'd3'
  import { UndirectedGraph } from 'graphology'
  import forceAtlas2 from 'graphology-layout-forceatlas2'
  import { api } from '../api.js'
  import { currentProjectId, filters } from '../stores/app.js'
  import { searchGraphNodes } from '../lib/graphSearch.js'
  import VizMiniItem from './VizMiniItem.svelte'

  // This surface is intentionally a Saved-only analysis tool.
  export let status = 'saved'

  const dispatch = createEventDispatcher()

  // ── state ──────────────────────────────────────────────────────────────────
  let canvas, container
  let loading = false
  let loadingMessage = 'Loading items…'
  let error = null
  let hovered = null
  let selectedNode = null
  let simulation = null
  let graphNodes = []
  let graphLinks = []
  let itemsByEntity = new Map()   // entityId → VizItem[]
  let width = 0, height = 0, dpr = 1
  let transform = d3.zoomIdentity
  let zoomBehavior = null
  let activeType = null
  let itemCount = 0
  let loadSeq = 0
  let allGraphItems = []
  let latestCreatedAt = null
  let refreshing = false
  let refreshMessage = ''
  let layout = 'forceatlas2'
  let searchQuery = ''
  let searchExpanded = false
  let activeSearchIndex = 0
  let forceAtlasIterations = 0
  let forceAtlasApplied = false

  const TYPE_COLOR = {
    article:  '#64748b',
    person:   '#3b82f6',
    org:      '#f59e0b',
    location: '#10b981',
    theme:    '#8b5cf6',
  }
  const TYPE_LABEL = { article: 'Articles', person: 'People', org: 'Organisations', location: 'Locations', theme: 'Themes' }

  // ── entity extraction ──────────────────────────────────────────────────────

  function extractGraph(items) {
    const nodeMap = new Map()   // id → { id, name, type, count }
    const linkMap = new Map()   // "a||b" → { source, target, weight }
    const itemMap = new Map()   // entityId → Set of item indices

    function add(name, type) {
      if (!name || name.trim().length < 2) return null
      const id = `${type}:${name.trim()}`
      if (!nodeMap.has(id)) nodeMap.set(id, { id, name: name.trim(), type, count: 0 })
      nodeMap.get(id).count++
      return id
    }

    function addLink(source, target) {
      const [a, b] = [source, target].sort()
      const key = `${a}||${b}`
      if (!linkMap.has(key)) linkMap.set(key, { source: a, target: b, weight: 0 })
      linkMap.get(key).weight++
    }

    items.forEach(item => {
      const norm = item.normalized || {}
      const ids = []
      const articleId = `article:${item.item_id}`
      const articleName = item.title_or_summary || item.url || item.item_id
      nodeMap.set(articleId, { id: articleId, name: articleName, type: 'article', count: 1 })
      itemMap.set(articleId, [item])

      ;(norm.persons || []).forEach(p => { const k = add(p, 'person'); if (k) ids.push(k) })
      ;(norm.organizations || []).forEach(o => { const k = add(o, 'org'); if (k) ids.push(k) })
      ;(norm.locations || []).forEach(loc => {
        const name = loc?.name || loc?.adm1 || ''
        const k = add(name, 'location'); if (k) ids.push(k)
      })
      ;(norm.themes || []).forEach(th => {
        const cat = th.split('_')[0]
        if (cat && cat.length >= 3 && cat !== 'TAX') { const k = add(cat, 'theme'); if (k) ids.push(k) }
      })

      const uniqueIds = [...new Set(ids)]

      // Every saved article has its own node. Its links make the source item
      // visible even when it carries no extracted entities.
      uniqueIds.forEach(id => {
        if (!itemMap.has(id)) itemMap.set(id, [])
        itemMap.get(id).push(item)
        addLink(articleId, id)
      })
    })

    return { nodeMap, linkMap, itemMap }
  }

  // ── load ───────────────────────────────────────────────────────────────────

  function maxCreatedAt(list) {
    return list.reduce((max, item) => {
      if (!item.created_at) return max
      return !max || new Date(item.created_at) > new Date(max) ? item.created_at : max
    }, null)
  }

  function rebuildGraph(vizItems, preservePositions = false) {
    const previous = preservePositions ? new Map(graphNodes.map(n => [n.id, n])) : new Map()
    const { nodeMap, linkMap, itemMap } = extractGraph(vizItems)

    const allNodes = [...nodeMap.values()].sort((a, b) => b.count - a.count)
    const allLinks = [...linkMap.values()].sort((a, b) => b.weight - a.weight)

    const cx = width / 2 || 400, cy = height / 2 || 300
    graphNodes = allNodes.map(n => {
      const old = previous.get(n.id)
      return {
        ...n,
        x: old?.x ?? cx + (Math.random() - 0.5) * 300,
        y: old?.y ?? cy + (Math.random() - 0.5) * 300,
        vx: old?.vx ?? 0,
        vy: old?.vy ?? 0,
      }
    })
    graphLinks = allLinks
    itemsByEntity = itemMap
    forceAtlasApplied = false
  }

  async function load() {
    if (!$currentProjectId) return
    const seq = ++loadSeq
    loading = true; error = null; selectedNode = null; hovered = null
    try {
      loadingMessage = `Loading ${status} items…`
      const r = await api.getAllVizData($currentProjectId, status, {
        onProgress: ({ loaded, total }) => {
          if (seq === loadSeq) loadingMessage = `Loading ${loaded.toLocaleString()} of ${total.toLocaleString()} ${status} items…`
        },
      })
      if (seq !== loadSeq) return
      if (!r.ok) { error = r.error; return }
      const items = r.data.items
      itemCount = r.data.total
      if (items.length === 0) { graphNodes = []; graphLinks = []; draw(); return }
      allGraphItems = items
      latestCreatedAt = maxCreatedAt(items)
      rebuildGraph(items)
      await tick()
      resize()
    } catch (e) {
      if (seq === loadSeq) error = e?.message || 'Entity graph failed'
    } finally {
      if (seq === loadSeq) loading = false
    }
  }

  function fitGraphToViewport() {
    if (graphNodes.length === 0) return
    const xs = graphNodes.map(node => node.x)
    const ys = graphNodes.map(node => node.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    const padding = 70
    const scale = Math.min(
      Math.max(1, width - padding * 2) / Math.max(1, maxX - minX),
      Math.max(1, height - padding * 2) / Math.max(1, maxY - minY),
    )
    for (const node of graphNodes) {
      node.x = padding + (node.x - minX) * scale
      node.y = padding + (node.y - minY) * scale
      node.vx = 0
      node.vy = 0
    }
  }

  function applyForceAtlas2Layout() {
    const graph = new UndirectedGraph({ allowSelfLoops: false })
    for (const node of graphNodes) {
      graph.addNode(node.id, { x: node.x, y: node.y, size: nodeR(node) })
    }
    graphLinks.forEach((link, index) => {
      const source = typeof link.source === 'object' ? link.source.id : link.source
      const target = typeof link.target === 'object' ? link.target.id : link.target
      if (source !== target && graph.hasNode(source) && graph.hasNode(target)) {
        graph.addUndirectedEdgeWithKey(`edge:${index}`, source, target, { weight: link.weight })
      }
    })

    forceAtlasIterations = graph.order <= 200 ? 250 : graph.order <= 1000 ? 140 : graph.order <= 5000 ? 80 : 40
    const inferred = forceAtlas2.inferSettings(graph)
    const positions = forceAtlas2(graph, {
      iterations: forceAtlasIterations,
      getEdgeWeight: 'weight',
      settings: {
        ...inferred,
        adjustSizes: true,
        barnesHutOptimize: graph.order > 100,
        edgeWeightInfluence: 1,
        gravity: 1,
      },
    })
    for (const node of graphNodes) {
      const position = positions[node.id]
      if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
        node.x = position.x
        node.y = position.y
      }
    }
    fitGraphToViewport()
    forceAtlasApplied = true
    transform = d3.zoomIdentity
    if (zoomBehavior && canvas) d3.select(canvas).call(zoomBehavior.transform, transform)
  }

  function startSimulation() {
    if (simulation) simulation.stop()
    simulation = null
    const centerX = width / 2 || 400
    const centerY = height / 2 || 300
    if (layout === 'forceatlas2') {
      applyForceAtlas2Layout()
      draw()
    } else {
      simulation = d3.forceSimulation(graphNodes)
        .force('link', d3.forceLink(graphLinks).id(d => d.id).distance(60).strength(d => Math.min(1, d.weight * 0.15)))
        .force('charge', d3.forceManyBody().strength(-80))
        .force('center', d3.forceCenter(centerX, centerY))
        .force('collide', d3.forceCollide(d => nodeR(d) + 4))
        .alphaDecay(0.025)
        .on('tick', draw)
    }
  }

  function setLayout(nextLayout) {
    if (layout === nextLayout) return
    layout = nextLayout
    if (layout === 'forceatlas2') forceAtlasApplied = false
    startSimulation()
  }

  function nodeR(n) {
    if (n.type === 'article') return 4
    return Math.max(5, Math.min(18, 4 + Math.sqrt(n.count) * 2.5))
  }

  // ── zoom ───────────────────────────────────────────────────────────────────

  function initZoom() {
    if (!canvas) return
    zoomBehavior = d3.zoom()
      .scaleExtent([0.1, 10])
      .filter(e => {
        if (e.type === 'wheel') return true
        if (e.type === 'pointerdown' || e.type === 'mousedown') return e.button === 0 && !e.metaKey
        return false
      })
      .on('zoom', e => { transform = e.transform; draw() })
    d3.select(canvas).call(zoomBehavior)
  }

  function resetZoom() {
    if (zoomBehavior && canvas) d3.select(canvas).call(zoomBehavior.transform, d3.zoomIdentity)
  }

  function centerOnNode(node) {
    const scale = Math.max(transform.k, 1.5)
    const next = d3.zoomIdentity
      .translate(width / 2 - node.x * scale, height / 2 - node.y * scale)
      .scale(scale)
    if (zoomBehavior && canvas) d3.select(canvas).call(zoomBehavior.transform, next)
    else { transform = next; draw() }
  }

  function focusNode(node) {
    selectedNode = node
    hovered = null
    activeType = null
    searchQuery = node.name
    searchExpanded = false
    tick().then(() => {
      resize()
      if (selectedNode?.id === node.id) centerOnNode(node)
    })
  }

  function onSearchInput(event) {
    searchQuery = event.target.value
    activeSearchIndex = 0
    searchExpanded = true
  }

  function onSearchKeydown(event) {
    if (event.key === 'Escape') {
      searchQuery = ''
      searchExpanded = false
      return
    }
    if (searchResults.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      activeSearchIndex = (activeSearchIndex + 1) % searchResults.length
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      activeSearchIndex = (activeSearchIndex - 1 + searchResults.length) % searchResults.length
    } else if (event.key === 'Enter') {
      event.preventDefault()
      focusNode(searchResults[activeSearchIndex] || searchResults[0])
    }
  }

  function screenToWorld(sx, sy) {
    return { x: (sx - transform.x) / transform.k, y: (sy - transform.y) / transform.k }
  }

  // ── draw ───────────────────────────────────────────────────────────────────

  function vNodes() { return graphNodes }
  function vLinks() {
    if (!activeType) return graphLinks
    const ids = new Set(graphNodes.filter(n => n.type === activeType).map(n => n.id))
    return graphLinks.filter(l => {
      const s = typeof l.source === 'object' ? l.source.id : l.source
      const t = typeof l.target === 'object' ? l.target.id : l.target
      return ids.has(s) || ids.has(t)
    })
  }

  function draw() {
    if (!canvas || width === 0 || height === 0) return
    const ctx = canvas.getContext('2d')
    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)

    // World-space (zoomed)
    ctx.save()
    ctx.translate(transform.x, transform.y)
    ctx.scale(transform.k, transform.k)

    const nodes = vNodes()
    const links = vLinks()
    const nodeById = new Map(graphNodes.map(n => [n.id, n]))

    // Links
    for (const lk of links) {
      const s = typeof lk.source === 'object' ? lk.source : nodeById.get(lk.source)
      const t = typeof lk.target === 'object' ? lk.target : nodeById.get(lk.target)
      if (!s || !t) continue
      const isSel = selectedNode && (s.id === selectedNode.id || t.id === selectedNode.id)
      ctx.globalAlpha = isSel ? 0.7 : Math.min(0.5, 0.1 + lk.weight * 0.05)
      ctx.strokeStyle = isSel ? '#94a3b8' : '#1e3a5f'
      ctx.lineWidth = isSel ? 1.5 / transform.k : 1 / transform.k
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke()
    }
    ctx.globalAlpha = 1

    // Nodes
    for (const nd of nodes) {
      const r = nodeR(nd)
      const col = TYPE_COLOR[nd.type] || '#94a3b8'
      const isHov = nd === hovered
      const isSel = nd === selectedNode
      ctx.globalAlpha = activeType && nd.type !== activeType ? 0.18 : 1
      if (isSel) {
        ctx.strokeStyle = col + '55'
        ctx.lineWidth = 6 / transform.k
        ctx.beginPath(); ctx.arc(nd.x, nd.y, r + 5 / transform.k, 0, 2 * Math.PI); ctx.stroke()
      }
      ctx.beginPath(); ctx.arc(nd.x, nd.y, r, 0, 2 * Math.PI)
      ctx.fillStyle = isSel ? '#ffffff' : isHov ? col + 'ee' : col + '99'
      ctx.strokeStyle = isSel ? '#ffffff' : col
      ctx.lineWidth = (isSel ? 2.5 : 1) / transform.k
      ctx.fill(); ctx.stroke()

      // Label for larger or selected/hovered nodes
      if ((nd.type !== 'article' && r >= 9) || isHov || isSel) {
        const fontSize = Math.max(9, Math.min(12, r - 1))
        ctx.font = `${isSel || isHov ? 'bold ' : ''}${fontSize}px system-ui`
        ctx.fillStyle = '#e2e8f0'
        ctx.textAlign = 'center'
        ctx.fillText(nd.name.slice(0, 24), nd.x, nd.y + r + 11 / transform.k)
      }
    }
    ctx.globalAlpha = 1
    ctx.restore()

    // Screen-space tooltip
    if (hovered && hovered !== selectedNode) {
      const sx = hovered.x * transform.k + transform.x
      const sy = hovered.y * transform.k + transform.y
      const col = TYPE_COLOR[hovered.type] || '#94a3b8'
      const lines = [hovered.name, `${TYPE_LABEL[hovered.type]} · ${hovered.count} mention${hovered.count !== 1 ? 's' : ''}`]
      const maxW = 200; const bh = lines.length * 17 + 12
      let bx = sx + nodeR(hovered) * transform.k + 6
      let by = sy - bh / 2
      if (bx + maxW > width) bx = sx - maxW - nodeR(hovered) * transform.k - 6
      if (by < 4) by = 4
      ctx.fillStyle = '#1e293b'; ctx.strokeStyle = col; ctx.lineWidth = 1.5
      roundRect(ctx, bx, by, maxW, bh, 6); ctx.fill(); ctx.stroke()
      ctx.textAlign = 'left'
      ctx.fillStyle = '#f1f5f9'; ctx.font = 'bold 12px system-ui'
      ctx.fillText(lines[0].slice(0, 28), bx + 8, by + 16)
      ctx.fillStyle = '#94a3b8'; ctx.font = '11px system-ui'
      ctx.fillText(lines[1], bx + 8, by + 32)
    }

    ctx.restore()
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r)
    ctx.lineTo(x+w,y+h-r); ctx.arcTo(x+w,y+h,x+w-r,y+h,r)
    ctx.lineTo(x+r,y+h); ctx.arcTo(x,y+h,x,y+h-r,r)
    ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r); ctx.closePath()
  }

  // ── interaction ─────────────────────────────────────────────────────────────

  let dragMoved = false
  let pointerDown = null
  function onMouseDown(e) {
    dragMoved = false
    pointerDown = { x: e.clientX, y: e.clientY }
  }
  function onMouseMove(e) {
    if (pointerDown && Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) > 4) {
      dragMoved = true
    }
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const { x: wx, y: wy } = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
    let closest = null, minD = 16 / transform.k
    for (const nd of vNodes()) {
      const d = Math.hypot(nd.x - wx, nd.y - wy)
      if (d < minD) { minD = d; closest = nd }
    }
    if (closest !== hovered) { hovered = closest; draw() }
  }
  function onMouseLeave() { hovered = null; pointerDown = null; draw() }

  function onClick(e) {
    if (dragMoved) { pointerDown = null; return }
    pointerDown = null
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const { x: wx, y: wy } = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
    let hit = null, minD = 16 / transform.k
    for (const nd of vNodes()) {
      const d = Math.hypot(nd.x - wx, nd.y - wy)
      if (d < minD) { minD = d; hit = nd }
    }
    if (hit) {
      selectedNode = hit === selectedNode ? null : hit
      if (selectedNode) applyFilter(selectedNode)
    } else {
      selectedNode = null
    }
    draw()
  }

  function applyFilter(nd) {
    if (!nd) return
    if (nd.type === 'person') filters.update(f => ({
      ...f,
      person: nd.name,
      organization: '',
      locationText: '',
      offset: 0,
      vizItemIds: [],
      vizFilterLabel: '',
    }))
    else if (nd.type === 'org') filters.update(f => ({
      ...f,
      person: '',
      organization: nd.name,
      locationText: '',
      offset: 0,
      vizItemIds: [],
      vizFilterLabel: '',
    }))
    else if (nd.type === 'location') filters.update(f => ({
      ...f,
      person: '',
      organization: '',
      locationText: nd.name,
      offset: 0,
      vizItemIds: [],
      vizFilterLabel: '',
    }))
    else if (nd.type === 'theme') {
      const ids = (itemsByEntity.get(nd.id) || []).map(item => item.item_id)
      dispatch('filter', { itemIds: ids, label: `graph theme: ${nd.name}` })
      return
    } else return
    dispatch('filter')
  }

  // ── resize ─────────────────────────────────────────────────────────────────

  let ro
  function resize() {
    if (!container || !canvas) return false
    dpr = window.devicePixelRatio || 1
    const newW = container.clientWidth, newH = container.clientHeight
    if (newW === 0 || newH === 0) return false
    width = newW; height = newH
    canvas.width = width * dpr; canvas.height = height * dpr
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px'
    if (layout === 'forceatlas2') {
      if (!forceAtlasApplied && graphNodes.length > 0) startSimulation()
      else draw()
    } else if (simulation) {
      simulation.force('center', d3.forceCenter(width / 2, height / 2))
      simulation.alpha(0.3).restart()
    }
    else if (graphNodes.length > 0) startSimulation()
    else draw()
    return true
  }

  async function refreshViz() {
    if (refreshing || !$currentProjectId) return
    if (!latestCreatedAt) {
      load()
      return
    }
    const seq = ++loadSeq
    refreshing = true
    refreshMessage = 'Checking for new items…'
    try {
      const r = await api.getAllVizData($currentProjectId, status, { sinceCreatedAt: latestCreatedAt })
      if (seq !== loadSeq) return
      if (!r.ok) { error = r.error; return }
      const known = new Set(allGraphItems.map(item => item.item_id))
      const newItems = (r.data.items || []).filter(item => !known.has(item.item_id)).reverse()
      if (newItems.length === 0) {
        refreshMessage = 'No new items'
        return
      }
      allGraphItems = [...newItems, ...allGraphItems]
      itemCount = allGraphItems.length
      latestCreatedAt = maxCreatedAt(allGraphItems)
      rebuildGraph(allGraphItems, true)
      await tick()
      resize()
      refreshMessage = `Added ${newItems.length} item${newItems.length !== 1 ? 's' : ''}`
    } catch (e) {
      if (seq === loadSeq) error = e?.message || 'Refresh failed'
    } finally {
      if (seq === loadSeq) refreshing = false
    }
  }

  onMount(() => {
    ro = new ResizeObserver(resize)
    ro.observe(container)
  })

  onDestroy(() => { ro?.disconnect(); simulation?.stop() })

  let _loadedFor = null
  $: if ($currentProjectId && $currentProjectId !== _loadedFor) {
    _loadedFor = $currentProjectId
    load()
  }

  // Attach zoom only after canvas exists (inside {#if graphNodes.length > 0} block).
  $: if (!canvas) zoomBehavior = null
  $: if (canvas && !zoomBehavior) {
    tick().then(() => {
      if (canvas && !zoomBehavior && resize()) initZoom()
    })
  }

  $: activeType, draw()

  $: panelItems = selectedNode ? (itemsByEntity.get(selectedNode.id) || []) : []
  $: typeCounts = Object.keys(TYPE_COLOR).map(t => ({ type: t, count: graphNodes.filter(n => n.type === t).length })).filter(x => x.count > 0)
  $: searchResults = searchGraphNodes(graphNodes, searchQuery)
</script>

<div class="eg-outer">
  <div class="eg-canvas-wrap" bind:this={container}>
    {#if loading}
      <div class="overlay">{loadingMessage}</div>
    {:else if error}
      <div class="overlay error">{error}</div>
    {:else if graphNodes.length === 0}
      <div class="overlay muted">No entities found in {itemCount} item{itemCount !== 1 ? 's' : ''}.</div>
    {:else}
      <canvas
        bind:this={canvas}
        on:mousedown={onMouseDown}
        on:mousemove={onMouseMove}
        on:mouseleave={onMouseLeave}
        on:click={onClick}
      ></canvas>

      <!-- Type filter chips -->
      <div class="type-chips">
        <button class="chip" class:active={!activeType} on:click={() => { activeType = null; draw() }}>All</button>
        {#each typeCounts as { type, count }}
          <button
            class="chip"
            class:active={activeType === type}
            style="--col:{TYPE_COLOR[type]}"
            on:click={() => { activeType = activeType === type ? null : type; draw() }}
          >{TYPE_LABEL[type]} ({count})</button>
        {/each}
      </div>

      <div class="graph-tools">
        <div
          class="node-search"
          on:focusin={() => searchExpanded = true}
          on:focusout={event => {
            if (!event.currentTarget.contains(event.relatedTarget)) searchExpanded = false
          }}
        >
          <input
            type="search"
            placeholder="Find a node…"
            value={searchQuery}
            on:input={onSearchInput}
            on:keydown={onSearchKeydown}
            aria-label="Search graph nodes"
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-controls="graph-search-results"
            aria-expanded={searchExpanded && searchQuery.trim().length > 0}
            aria-activedescendant={searchExpanded && searchResults.length > 0 ? `graph-search-result-${activeSearchIndex}` : undefined}
          />
          {#if searchExpanded && searchQuery.trim()}
            <div class="search-results" id="graph-search-results" role="listbox" aria-label="Matching graph nodes">
              {#each searchResults as node, index (node.id)}
                <button
                  id="graph-search-result-{index}"
                  role="option"
                  aria-selected={index === activeSearchIndex}
                  class:active={index === activeSearchIndex}
                  on:click={() => focusNode(node)}
                >
                  <span class="result-name">{node.name}</span>
                  <span class="result-meta">{TYPE_LABEL[node.type]} · {node.count}</span>
                </button>
              {:else}
                <span class="no-results">No matching nodes</span>
              {/each}
            </div>
          {/if}
        </div>

        <div class="layout-control" role="group" aria-label="Graph layout">
          <span>Layout</span>
          <button class:active={layout === 'forceatlas2'} on:click={() => setLayout('forceatlas2')}>ForceAtlas2</button>
          <button class:active={layout === 'balanced'} on:click={() => setLayout('balanced')}>Balanced</button>
        </div>
      </div>

      <div class="hints">
        <span>{layout === 'forceatlas2' ? `ForceAtlas2 · ${forceAtlasIterations} iterations ·` : 'Balanced layout ·'} all {itemCount.toLocaleString()} saved articles · scroll to zoom · drag to pan · click node to inspect</span>
        <button class="reset-zoom" on:click={refreshViz} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        {#if refreshMessage}
          <span>{refreshMessage}</span>
        {/if}
        {#if transform.k !== 1 || transform.x !== 0 || transform.y !== 0}
          <button class="reset-zoom" on:click={resetZoom}>Reset view</button>
        {/if}
      </div>
    {/if}
  </div>

  {#if selectedNode}
    <div class="side-panel">
      <div class="panel-header">
        <div>
          <span class="panel-dot" style="background:{TYPE_COLOR[selectedNode.type]}"></span>
          <span class="panel-name">{selectedNode.name}</span>
          <span class="panel-meta">{TYPE_LABEL[selectedNode.type]} · {selectedNode.count} mention{selectedNode.count !== 1 ? 's' : ''}</span>
        </div>
        <button class="panel-close" on:click={() => { selectedNode = null; draw() }}>✕</button>
      </div>

      {#if selectedNode.type !== 'theme'}
        <button
          class="filter-btn"
          on:click={() => applyFilter(selectedNode)}
          title="Narrow the list view to items mentioning this entity"
        >Filter list by this {selectedNode.type}</button>
      {/if}

      <div class="panel-list">
        {#each panelItems as item}
          <VizMiniItem {item} {status} on:dismissed on:undismissed />
        {:else}
          <p class="empty-panel">No items cached for this entity.</p>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .eg-outer {
    display: flex;
    flex: 1;
    min-height: 0;
    width: 100%;
    background: #0f172a;
    border-radius: 8px;
    overflow: hidden;
  }
  .eg-canvas-wrap {
    flex: 1;
    min-width: 0;
    position: relative;
  }
  canvas { display: block; cursor: pointer; }
  .overlay {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    color: #94a3b8; font-size: 14px;
  }
  .overlay.error { color: #f87171; }
  .overlay.muted { color: #475569; }
  .type-chips {
    position: absolute; top: 10px; left: 10px;
    display: flex; gap: 6px; flex-wrap: wrap;
    max-width: calc(100% - 320px);
  }
  .chip {
    padding: 3px 10px; border-radius: 999px; border: 1px solid #334155;
    background: #1e293b; color: #94a3b8; font-size: 11px; cursor: pointer; transition: all 0.15s;
  }
  .chip:hover { border-color: #475569; color: #e2e8f0; }
  .chip.active { background: var(--col, #3b82f6); border-color: transparent; color: #fff; }
  .graph-tools {
    align-items: flex-end;
    display: flex;
    flex-direction: column;
    gap: 6px;
    position: absolute;
    right: 10px;
    top: 10px;
    width: min(286px, calc(100% - 20px));
    z-index: 1;
  }
  .node-search { position: relative; width: 100%; }
  .node-search input {
    background: #0d1826;
    border: 1px solid #475569;
    border-radius: 5px;
    color: #e2e8f0;
    font: inherit;
    font-size: 12px;
    outline: none;
    padding: 6px 9px;
    width: 100%;
  }
  .node-search input::placeholder { color: #94a3b8; }
  .node-search input:focus { border-color: #60a5fa; }
  .search-results {
    background: #0d1826;
    border: 1px solid #475569;
    border-radius: 5px;
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
    inset: calc(100% + 4px) 0 auto;
    max-height: 264px;
    overflow-y: auto;
    padding: 3px;
    position: absolute;
  }
  .search-results button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 3px;
    color: #cbd5e1;
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: 12px;
    gap: 8px;
    justify-content: space-between;
    padding: 6px 7px;
    text-align: left;
    width: 100%;
  }
  .search-results button:hover,
  .search-results button.active { background: #1e293b; color: #fff; }
  .result-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .result-meta { color: #94a3b8; flex: 0 0 auto; font-size: 11px; }
  .no-results { color: #94a3b8; display: block; font-size: 12px; padding: 7px; }
  .layout-control {
    align-items: center;
    background: #0d1826;
    border: 1px solid #334155;
    border-radius: 5px;
    display: flex;
    gap: 2px;
    padding: 3px;
    width: max-content;
  }
  .layout-control span { color: #64748b; font-size: 11px; padding: 0 4px; }
  .layout-control button {
    background: transparent;
    border: 0;
    border-radius: 3px;
    color: #94a3b8;
    cursor: pointer;
    font-size: 11px;
    padding: 3px 6px;
  }
  .layout-control button:hover { color: #e2e8f0; }
  .layout-control button.active { background: #2563eb; color: #fff; }
  .hints {
    position: absolute; bottom: 10px; left: 12px;
    font-size: 11px; color: #334155;
    display: flex; gap: 10px; align-items: center;
  }
  .reset-zoom {
    background: #1e293b; border: 1px solid #334155; color: #64748b;
    border-radius: 4px; padding: 2px 7px; font-size: 11px; cursor: pointer;
  }
  .reset-zoom:hover { color: #e2e8f0; border-color: #475569; }
  .reset-zoom:disabled { cursor: default; opacity: 0.55; }

  /* ── Side panel ─────────────────────────────────────────────────── */
  .side-panel {
    width: 300px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid #1e293b;
    background: #0d1826;
  }
  .panel-header {
    display: flex; align-items: flex-start; justify-content: space-between;
    padding: 12px; border-bottom: 1px solid #1e293b;
  }
  .panel-dot {
    display: inline-block; width: 8px; height: 8px;
    border-radius: 50%; margin-right: 6px; vertical-align: middle; flex-shrink: 0;
  }
  .panel-name { font-size: 13px; font-weight: 600; color: #e2e8f0; word-break: break-word; }
  .panel-meta { display: block; font-size: 11px; color: #64748b; margin-top: 2px; padding-left: 14px; }
  .panel-close {
    background: none; border: none; color: #475569; cursor: pointer;
    font-size: 14px; padding: 0 0 0 8px; flex-shrink: 0; line-height: 1;
  }
  .panel-close:hover { color: #e2e8f0; }
  .filter-btn {
    margin: 8px 10px; padding: 6px 10px;
    background: #1e293b; border: 1px solid #334155;
    border-radius: 5px; color: #94a3b8; font-size: 11px; cursor: pointer; text-align: left;
    transition: all 0.15s;
  }
  .filter-btn:hover { border-color: #3b82f6; color: #93c5fd; }
  .panel-list { flex: 1; overflow-y: auto; padding: 6px; }
  .empty-panel { font-size: 12px; color: #334155; padding: 12px 8px; }
</style>
