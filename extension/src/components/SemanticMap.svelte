<script>
  import { createEventDispatcher, onMount, onDestroy } from 'svelte'
  import * as d3 from 'd3'
  import { api } from '../api.js'
  import { currentProjectId } from '../stores/app.js'
  import { embed } from '../lib/embeddingClient.js'
  import VizMiniItem from './VizMiniItem.svelte'

  export let status = 'inbox'

  const dispatch = createEventDispatcher()
  const EMBEDDING_MODEL = 'canary-feature-hash-v1'
  const MAX_RENDERED_NODES = 1200

  // ── state ──────────────────────────────────────────────────────────────────
  let canvas, container
  let items = []
  let nodes = []
  // { id, label, color, count, items[] } — no position stored here
  let clusterDefs = []
  // { [id]: {x,y} } — recomputed on resize
  let clusterPos = {}
  let loading = false
  let loadingMessage = 'Building semantic map…'
  let error = null
  let hovered = null
  let selectedNode = null
  let selectedCluster = null  // cluster id
  let simulation = null
  let width = 0, height = 0, dpr = 1
  let transform = d3.zoomIdentity
  let zoomBehavior = null
  let loadSeq = 0
  let latestCreatedAt = null
  let refreshing = false
  let refreshMessage = ''
  let clusterCentroids = []

  const PALETTE = [
    '#3b82f6','#f59e0b','#10b981','#ef4444',
    '#8b5cf6','#ec4899','#06b6d4','#84cc16',
  ]
  const STOPWORDS = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with',
    'by','from','as','is','was','are','were','be','been','being','have',
    'has','had','do','does','did','will','would','could','should','may',
    'might','can','its','it','this','that','these','those','not','no',
    'after','before','during','over','under','about','into','through',
    'new','says','said','report','according','also','more','than','their',
    'his','her','him','she','he','they','we','us','our','you','your',
    'who','which','what','when','where','how','why','all','any','some',
    'one','two','three','four','five','year','years','day','days',
  ])

  // ── TF-IDF ─────────────────────────────────────────────────────────────────

  function tokenize(text) {
    if (!text) return []
    return text.toLowerCase().split(/[^a-z]+/).filter(t => t.length >= 3 && !STOPWORDS.has(t))
  }

  function buildTfidf(docs) {
    const N = docs.length
    const df = new Map()
    const tfs = docs.map(tokens => {
      const tf = new Map()
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1)
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1)
      return tf
    })
    const minDf = Math.max(2, Math.ceil(N * 0.02))
    const maxDf = Math.ceil(N * 0.75)
    const vocab = [...df.entries()]
      .filter(([, c]) => c >= minDf && c <= maxDf)
      .map(([t]) => t)
    if (vocab.length === 0) {
      // no useful shared vocabulary — return dummy uniform vecs
      return { vecs: docs.map(() => new Float32Array(1)), vocab: [] }
    }
    const vocabIdx = new Map(vocab.map((t, i) => [t, i]))
    const idf = vocab.map(t => Math.log((N + 1) / (df.get(t) + 1)) + 1)
    const V = vocab.length
    const vecs = tfs.map((tf, di) => {
      const total = docs[di].length || 1
      const vec = new Float32Array(V)
      for (const [t, cnt] of tf.entries()) {
        const idx = vocabIdx.get(t)
        if (idx !== undefined) vec[idx] = (cnt / total) * idf[idx]
      }
      let norm = 0; for (let i = 0; i < V; i++) norm += vec[i] * vec[i]
      norm = Math.sqrt(norm) || 1
      for (let i = 0; i < V; i++) vec[i] /= norm
      return vec
    })
    return { vecs, vocab }
  }

  function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }

  function kmeans(vecs, k) {
    const N = vecs.length
    k = Math.min(k, N)
    const V = vecs[0].length
    // k-means++ init
    const centroids = [vecs[Math.floor(Math.random() * N)].slice()]
    while (centroids.length < k) {
      const dists = vecs.map(v => { let mx = -Infinity; for (const c of centroids) mx = Math.max(mx, dot(v,c)); return Math.max(0, 1 - mx) })
      const total = dists.reduce((a,b) => a+b, 0) || 1
      let r = Math.random() * total, pick = 0
      for (let i = 0; i < N; i++) { r -= dists[i]; if (r <= 0) { pick = i; break } }
      centroids.push(vecs[pick].slice())
    }
    const assignments = new Int32Array(N)
    for (let iter = 0; iter < 40; iter++) {
      let changed = false
      for (let i = 0; i < N; i++) {
        let best = 0, bestS = -Infinity
        for (let ci = 0; ci < k; ci++) { const s = dot(vecs[i], centroids[ci]); if (s > bestS) { bestS = s; best = ci } }
        if (assignments[i] !== best) { assignments[i] = best; changed = true }
      }
      if (!changed) break
      for (let ci = 0; ci < k; ci++) {
        const c = new Float32Array(V); let cnt = 0
        for (let i = 0; i < N; i++) if (assignments[i] === ci) { for (let v = 0; v < V; v++) c[v] += vecs[i][v]; cnt++ }
        if (cnt > 0) { let norm = 0; for (let v = 0; v < V; v++) norm += c[v]*c[v]; norm = Math.sqrt(norm)||1; for (let v = 0; v < V; v++) centroids[ci][v] = c[v]/norm }
      }
    }
    return [...assignments]
  }

  function topTerms(vecs, assignments, cid, vocab, n = 4) {
    if (vocab.length === 0) return `Cluster ${cid + 1}`
    const scores = new Float32Array(vocab.length)
    let cnt = 0
    for (let i = 0; i < assignments.length; i++) {
      if (assignments[i] === cid) { for (let v = 0; v < vocab.length; v++) scores[v] += vecs[i][v]; cnt++ }
    }
    if (cnt === 0) return `Cluster ${cid + 1}`
    return [...scores.entries()].sort((a,b) => b[1]-a[1]).slice(0,n).map(([i]) => vocab[i]).join(' · ')
  }

  function sourceText(item) {
    return item.title_or_summary || item.url || ''
  }

  function maxCreatedAt(list) {
    return list.reduce((max, item) => {
      if (!item.created_at) return max
      return !max || new Date(item.created_at) > new Date(max) ? item.created_at : max
    }, null)
  }

  function renderedItemIndexes(itemCount) {
    if (itemCount <= MAX_RENDERED_NODES) return Array.from({ length: itemCount }, (_, index) => index)
    const step = itemCount / MAX_RENDERED_NODES
    return Array.from({ length: MAX_RENDERED_NODES }, (_, index) => Math.floor(index * step))
  }

  function clusterRadius(count) {
    return Math.sqrt(Math.min(count, 400)) * 12 + 28
  }

  function computeCentroids(vecs, assignments, clusterIds) {
    const centroids = []
    for (const cid of clusterIds) {
      const first = vecs.find((_, i) => assignments[i] === cid)
      if (!first) continue
      const sum = new Float32Array(first.length)
      let count = 0
      vecs.forEach((vec, i) => {
        if (assignments[i] !== cid) return
        for (let v = 0; v < vec.length; v++) sum[v] += vec[v]
        count++
      })
      if (count > 0) {
        let norm = 0
        for (let v = 0; v < sum.length; v++) {
          sum[v] /= count
          norm += sum[v] * sum[v]
        }
        norm = Math.sqrt(norm) || 1
        for (let v = 0; v < sum.length; v++) sum[v] /= norm
        centroids[cid] = sum
      }
    }
    return centroids
  }

  async function embeddingsForItems(targetItems, seq) {
    let embVecs = new Array(targetItems.length)
    const missing = []
    targetItems.forEach((item, i) => {
      if (Array.isArray(item.semantic_embedding) && item.semantic_embedding.length > 0) {
        embVecs[i] = new Float32Array(item.semantic_embedding)
      } else {
        missing.push({ item, index: i, text: sourceText(item) })
      }
    })

    try {
      if (missing.length > 0) {
        const chunkSize = 64
        for (let start = 0; start < missing.length; start += chunkSize) {
          const chunk = missing.slice(start, start + chunkSize)
          loadingMessage = `Computing embeddings ${start}/${missing.length}…`
          const rawVecs = await embed(chunk.map(m => m.text), msg => {
            if (seq === loadSeq) loadingMessage = `${msg} · ${Math.min(start + chunk.length, missing.length)}/${missing.length} queued`
          })
          if (seq !== loadSeq) return null
          chunk.forEach((m, i) => {
            embVecs[m.index] = new Float32Array(rawVecs[i])
          })
          api.saveEmbeddings($currentProjectId, chunk.map((m, i) => ({
            item_id: m.item.item_id,
            model: EMBEDDING_MODEL,
            source_text: m.text,
            embedding: rawVecs[i],
          }))).then(r => {
            if (!r.ok) console.warn('Failed to save semantic embeddings:', r.error)
          })
        }
      } else {
        loadingMessage = 'Loading cached embeddings…'
      }
      return embVecs
    } catch (e) {
      console.warn('Embedding model failed, falling back to TF-IDF:', e)
      const docs = targetItems.map(it => tokenize(it.title_or_summary || ''))
      const { vecs } = buildTfidf(docs)
      return vecs
    }
  }

  function nearestCluster(vec) {
    let best = clusterDefs[0]?.id ?? 0
    let bestScore = -Infinity
    for (const cl of clusterDefs) {
      const centroid = clusterCentroids[cl.id]
      if (!centroid || centroid.length !== vec.length) continue
      const score = dot(vec, centroid)
      if (score > bestScore) {
        bestScore = score
        best = cl.id
      }
    }
    return best
  }

  // ── cluster center layout (separated from load so resize can update it) ────

  function layoutClusters() {
    if (!clusterDefs.length || width === 0 || height === 0) return
    const R = Math.min(width, height) * 0.28
    const cx = width / 2, cy = height / 2
    clusterDefs.forEach((cl, i) => {
      const angle = (2 * Math.PI * i) / clusterDefs.length - Math.PI / 2
      clusterPos[cl.id] = { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) }
    })
    // Reset node positions toward cluster centers
    for (const nd of nodes) {
      const pos = clusterPos[nd.cluster]
      if (pos) { nd.x = pos.x + (Math.random() - 0.5) * 50; nd.y = pos.y + (Math.random() - 0.5) * 50 }
    }
  }

  // ── load ───────────────────────────────────────────────────────────────────

  async function load() {
    if (!$currentProjectId) return
    const seq = ++loadSeq
    loading = true; error = null; selectedCluster = null; selectedNode = null; hovered = null
    try {
      loadingMessage = `Loading ${status} items…`
      const r = await api.getAllVizData($currentProjectId, status, {
        onProgress: ({ loaded, total }) => {
          if (seq === loadSeq) loadingMessage = `Loading ${loaded.toLocaleString()} of ${total.toLocaleString()} ${status} items…`
        },
      })
      if (seq !== loadSeq) return
      if (!r.ok) { error = r.error; return }
      items = r.data.items
      if (items.length === 0) { nodes = []; clusterDefs = []; draw(); return }

      loadingMessage = 'Building semantic map…'
      const embVecs = await embeddingsForItems(items, seq)
      if (!embVecs) return

      if (seq !== loadSeq) return
      const k = Math.max(2, Math.min(8, Math.ceil(Math.sqrt(items.length / 3))))
      const assignments = kmeans(embVecs, k)

      // TF-IDF still used for human-readable cluster labels
      const docs = items.map(it => tokenize(it.title_or_summary || ''))
      const { vecs, vocab } = buildTfidf(docs)

      const activeClusters = [...new Set(assignments)].sort()

      // Group items by cluster
      const clusterItemMap = new Map()
      items.forEach((item, i) => {
        const cid = assignments[i]
        if (!clusterItemMap.has(cid)) clusterItemMap.set(cid, [])
        clusterItemMap.get(cid).push(item)
      })

      clusterDefs = activeClusters.map(cid => ({
        id: cid,
        label: topTerms(vecs, assignments, cid, vocab),
        color: PALETTE[cid % PALETTE.length],
        count: clusterItemMap.get(cid).length,
        items: clusterItemMap.get(cid),
      }))
      clusterCentroids = computeCentroids(embVecs, assignments, activeClusters)

      // Cluster definitions retain every item.  For large archives the canvas
      // draws an evenly distributed representative subset, keeping force
      // simulation responsive while counts and selection still use all items.
      nodes = renderedItemIndexes(items.length).map(i => ({
        item: items[i],
        cluster: assignments[i],
        embedding: embVecs[i],
        x: width / 2 + (Math.random() - 0.5) * 200,
        y: height / 2 + (Math.random() - 0.5) * 200,
        vx: 0, vy: 0,
      }))
      latestCreatedAt = maxCreatedAt(items)

      // If we have real dimensions already, layout and start now.
      // If not (canvas not yet rendered), the $: resize() + startSimulation()
      // will be triggered once the canvas appears and is measured.
      if (width > 0 && height > 0) {
        layoutClusters()
        startSimulation()
      }
    } catch (e) {
      if (seq === loadSeq) error = e?.message || 'Semantic map failed'
    } finally {
      if (seq === loadSeq) loading = false
    }
  }

  function startSimulation() {
    if (simulation) simulation.stop()
    simulation = d3.forceSimulation(nodes)
      .force('x', d3.forceX(d => (clusterPos[d.cluster] || {x: width/2}).x).strength(0.4))
      .force('y', d3.forceY(d => (clusterPos[d.cluster] || {y: height/2}).y).strength(0.4))
      .force('collide', d3.forceCollide(7))
      .force('charge', d3.forceManyBody().strength(-12))
      .alphaDecay(0.02)

    // Warm-start: tick synchronously so nodes appear at cluster positions on first frame
    simulation.stop()
    for (let i = 0; i < 80; i++) simulation.tick()
    simulation.on('tick', draw).restart()
  }

  // ── zoom ───────────────────────────────────────────────────────────────────

  function initZoom() {
    if (!canvas) return
    zoomBehavior = d3.zoom()
      .scaleExtent([0.15, 10])
      // d3 v7 uses pointerdown/pointermove internally — check button on pointer events
      .filter(e => {
        if (e.type === 'wheel') return true
        if (e.type === 'pointerdown' || e.type === 'mousedown') return e.button === 0 && !e.metaKey
        return false
      })
      .on('zoom', e => { transform = e.transform; draw() })
    d3.select(canvas).call(zoomBehavior)
  }

  function resetZoom() {
    if (zoomBehavior && canvas) {
      d3.select(canvas).call(zoomBehavior.transform, d3.zoomIdentity)
    }
  }

  function screenToWorld(sx, sy) {
    return { x: (sx - transform.x) / transform.k, y: (sy - transform.y) / transform.k }
  }

  // ── draw ───────────────────────────────────────────────────────────────────

  function draw() {
    if (!canvas || width === 0 || height === 0) return
    const ctx = canvas.getContext('2d')
    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)

    // World-space content (zoom-transformed)
    ctx.save()
    ctx.translate(transform.x, transform.y)
    ctx.scale(transform.k, transform.k)

    // Pre-compute the bottom edge of each cluster's actual nodes for label placement
    const clusterMaxY = {}
    for (const nd of nodes) {
      const cy = nd.y + 7  // node radius
      if (clusterMaxY[nd.cluster] === undefined || cy > clusterMaxY[nd.cluster])
        clusterMaxY[nd.cluster] = cy
    }

    // Cluster halos
    for (const cl of clusterDefs) {
      const pos = clusterPos[cl.id]; if (!pos) continue
      const selected = selectedCluster === cl.id
      const baseR = clusterRadius(cl.count)
      const g = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, baseR)
      g.addColorStop(0, cl.color + (selected ? '44' : '28'))
      g.addColorStop(1, cl.color + '00')
      ctx.fillStyle = g
      ctx.beginPath(); ctx.arc(pos.x, pos.y, baseR, 0, 2 * Math.PI); ctx.fill()

      if (selected) {
        ctx.strokeStyle = cl.color + 'aa'; ctx.lineWidth = 1.5 / transform.k
        ctx.beginPath(); ctx.arc(pos.x, pos.y, baseR + 4 / transform.k, 0, 2 * Math.PI); ctx.stroke()
      }

      // Label placed just below the actual node cluster, not the full halo radius
      const labelY = (clusterMaxY[cl.id] ?? pos.y) + 14 / transform.k
      const fontSize = Math.max(9, Math.min(13, 11 / transform.k))
      ctx.font = `${selected ? 'bold ' : ''}${fontSize}px system-ui`
      ctx.fillStyle = selected ? cl.color : cl.color + 'cc'
      ctx.textAlign = 'center'
      ctx.fillText(cl.label, pos.x, labelY)
    }

    // Nodes
    for (const nd of nodes) {
      const col = PALETTE[nd.cluster % PALETTE.length]
      const isHov = nd === hovered
      const isSel = selectedCluster === nd.cluster
      const isClicked = nd === selectedNode
      const r = isClicked ? 8 : isHov ? 7 : 5
      ctx.beginPath(); ctx.arc(nd.x, nd.y, r, 0, 2 * Math.PI)
      ctx.fillStyle = isClicked ? '#ffffff' : isHov ? '#f8fafc' : isSel ? col : col + '99'
      ctx.strokeStyle = isClicked ? '#ffffff' : col
      ctx.lineWidth = isClicked ? 2.5 / transform.k : (isHov || isSel) ? 1.5 / transform.k : 0.5 / transform.k
      ctx.fill(); ctx.stroke()

      if (isClicked) {
        ctx.strokeStyle = col
        ctx.lineWidth = 2 / transform.k
        ctx.beginPath(); ctx.arc(nd.x, nd.y, r + 5 / transform.k, 0, 2 * Math.PI); ctx.stroke()
      }
    }
    ctx.restore()

    // Screen-space tooltip (not zoomed)
    if (hovered) {
      const sx = hovered.x * transform.k + transform.x
      const sy = hovered.y * transform.k + transform.y
      const title = hovered.item.title_or_summary || hovered.item.url || '—'
      const maxW = 280
      ctx.font = '12px system-ui'
      const lines = wrapText(ctx, title, maxW - 16)
      const bh = lines.length * 17 + 12
      let bx = sx + 12, by = sy - bh - 8
      if (bx + maxW > width) bx = sx - maxW - 12
      if (by < 4) by = sy + 14
      ctx.fillStyle = '#1e293b'; ctx.strokeStyle = '#334155'; ctx.lineWidth = 1
      roundRect(ctx, bx, by, maxW, bh, 6); ctx.fill(); ctx.stroke()
      ctx.fillStyle = '#e2e8f0'; ctx.textAlign = 'left'
      lines.forEach((l, i) => ctx.fillText(l, bx + 8, by + 16 + i * 17))
    }

    ctx.restore()
  }

  function wrapText(ctx, text, maxW) {
    const words = text.split(' ')
    const lines = []; let cur = ''
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w
      if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = w } else cur = test
    }
    if (cur) lines.push(cur)
    return lines.slice(0, 3)
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r)
    ctx.lineTo(x+w,y+h-r); ctx.arcTo(x+w,y+h,x+w-r,y+h,r)
    ctx.lineTo(x+r,y+h); ctx.arcTo(x,y+h,x,y+h-r,r)
    ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r); ctx.closePath()
  }

  // ── interaction ────────────────────────────────────────────────────────────

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
    let closest = null, minD = 12 / transform.k
    for (const nd of nodes) {
      const d = Math.hypot(nd.x - wx, nd.y - wy)
      if (d < minD) { minD = d; closest = nd }
    }
    if (closest !== hovered) { hovered = closest; draw() }
  }
  function onMouseLeave() { hovered = null; pointerDown = null; draw() }

  function onClick(e) {
    if (dragMoved) { pointerDown = null; return }   // was a pan, not a click
    pointerDown = null
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const { x: wx, y: wy } = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)

    // Check if near a node
    let clickedNode = null, minD = 14 / transform.k
    for (const nd of nodes) {
      const d = Math.hypot(nd.x - wx, nd.y - wy)
      if (d < minD) { minD = d; clickedNode = nd }
    }

    if (clickedNode) {
      const sameNode = clickedNode === selectedNode
      selectedNode = sameNode ? null : clickedNode
      selectedCluster = sameNode ? null : clickedNode.cluster
      applyClusterFilter(selectedCluster)
      draw(); return
    }

    // Check if inside a cluster halo
    for (const cl of clusterDefs) {
      const pos = clusterPos[cl.id]; if (!pos) continue
      const baseR = clusterRadius(cl.count)
      if (Math.hypot(wx - pos.x, wy - pos.y) < baseR) {
        selectedNode = null
        selectedCluster = cl.id === selectedCluster ? null : cl.id
        applyClusterFilter(selectedCluster)
        draw(); return
      }
    }

    // Click on empty space — clear selection
    selectedNode = null; selectedCluster = null; applyClusterFilter(null); draw()
  }

  function applyClusterFilter(clusterId) {
    if (clusterId === null) {
      dispatch('filter', { itemIds: [], label: '' })
      return
    }
    const cl = clusterDefs.find(c => c.id === clusterId)
    if (!cl) return
    dispatch('filter', {
      itemIds: cl.items.map(item => item.item_id),
      label: `map cluster: ${cl.label}`,
    })
  }

  // ── resize ─────────────────────────────────────────────────────────────────

  let ro
  function resize() {
    if (!container || !canvas) return
    dpr = window.devicePixelRatio || 1
    const newW = container.clientWidth, newH = container.clientHeight
    if (newW === 0 || newH === 0) return
    width = newW; height = newH
    canvas.width = width * dpr; canvas.height = height * dpr
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px'
    layoutClusters()
    if (nodes.length > 0) {
      if (simulation) simulation.alpha(0.4).restart()
      else startSimulation()   // first real resize after load() completed without dimensions
    } else {
      draw()
    }
  }

  async function refreshViz() {
    if (refreshing || !$currentProjectId) return
    if (!latestCreatedAt || clusterDefs.length === 0) {
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
      const known = new Set(items.map(item => item.item_id))
      const newItems = (r.data.items || []).filter(item => !known.has(item.item_id)).reverse()
      if (newItems.length === 0) {
        refreshMessage = 'No new items'
        return
      }

      refreshMessage = `Adding ${newItems.length} item${newItems.length !== 1 ? 's' : ''}…`
      const embVecs = await embeddingsForItems(newItems, seq)
      if (!embVecs) return

      const additionsByCluster = new Map()
      const availableNodeSlots = Math.max(0, MAX_RENDERED_NODES - nodes.length)
      const newNodes = newItems.slice(0, availableNodeSlots).map((item, i) => {
        const cluster = nearestCluster(embVecs[i])
        if (!additionsByCluster.has(cluster)) additionsByCluster.set(cluster, [])
        additionsByCluster.get(cluster).push(item)

        const cl = clusterDefs.find(c => c.id === cluster)
        const oldCount = cl?.count || 0
        const centroid = clusterCentroids[cluster]
        if (centroid && centroid.length === embVecs[i].length) {
          const next = new Float32Array(centroid.length)
          let norm = 0
          for (let v = 0; v < next.length; v++) {
            next[v] = ((centroid[v] * oldCount) + embVecs[i][v]) / (oldCount + 1)
            norm += next[v] * next[v]
          }
          norm = Math.sqrt(norm) || 1
          for (let v = 0; v < next.length; v++) next[v] /= norm
          clusterCentroids[cluster] = next
        }

        const pos = clusterPos[cluster] || { x: width / 2, y: height / 2 }
        return {
          item,
          cluster,
          embedding: embVecs[i],
          x: pos.x + (Math.random() - 0.5) * 80,
          y: pos.y + (Math.random() - 0.5) * 80,
          vx: 0,
          vy: 0,
        }
      })

      items = [...newItems, ...items]
      nodes = [...nodes, ...newNodes]
      clusterDefs = clusterDefs.map(cl => {
        const added = additionsByCluster.get(cl.id) || []
        return added.length ? { ...cl, count: cl.count + added.length, items: [...added, ...cl.items] } : cl
      })
      latestCreatedAt = maxCreatedAt(items)
      layoutClusters()
      if (simulation) simulation.nodes(nodes).alpha(0.35).restart()
      else startSimulation()
      draw()
      refreshMessage = `Added ${newItems.length} item${newItems.length !== 1 ? 's' : ''}`
    } catch (e) {
      if (seq === loadSeq) error = e?.message || 'Refresh failed'
    } finally {
      if (seq === loadSeq) refreshing = false
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  onMount(() => {
    ro = new ResizeObserver(resize)
    ro.observe(container)
    // Don't call load() here — the reactive statement below handles it.
    // Don't call initZoom() here — canvas doesn't exist until items load.
  })

  onDestroy(() => { ro?.disconnect(); simulation?.stop() })

  // Load when project changes (fires on first mount if project is already set).
  let _loadedFor = null
  $: if ($currentProjectId && $currentProjectId !== _loadedFor) {
    _loadedFor = $currentProjectId
    load()
  }

  // Reset zoom state when canvas is destroyed (e.g. during loading overlay)
  // so initZoom() re-attaches to the new canvas element after reload.
  $: if (!canvas) zoomBehavior = null

  // Attach d3.zoom only after the canvas element exists in the DOM.
  // Canvas is inside an {#if items.length > 0} block so it's null until load() returns.
  // Also trigger a resize here so width/height are correct before the simulation runs.
  $: if (canvas && !zoomBehavior) { resize(); initZoom() }

  // Derived: items in selected cluster
  $: selectedDef = selectedCluster !== null ? clusterDefs.find(c => c.id === selectedCluster) : null
</script>

<div class="sem-outer">
  <div class="sem-canvas-wrap" bind:this={container}>
    {#if loading}
      <div class="overlay">{loadingMessage}</div>
    {:else if error}
      <div class="overlay error">{error}</div>
    {:else if items.length === 0}
      <div class="overlay muted">No items to visualise.</div>
    {:else}
      <canvas
        bind:this={canvas}
        on:mousedown={onMouseDown}
        on:mousemove={onMouseMove}
        on:mouseleave={onMouseLeave}
        on:click={onClick}
      ></canvas>
      <div class="hints">
        <span>All {items.length.toLocaleString()} {status} item{items.length !== 1 ? 's' : ''} · scroll to zoom · drag to pan · click cluster to filter</span>
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

  {#if selectedDef}
    <div class="side-panel">
      <div class="panel-header">
        <div>
          <span class="panel-dot" style="background:{selectedDef.color}"></span>
          <span class="panel-title">{selectedDef.label}</span>
          <span class="panel-count">{selectedDef.count} items</span>
        </div>
        <button class="panel-close" on:click={() => { selectedCluster = null; draw() }}>✕</button>
      </div>
      <div class="panel-list">
        {#each selectedDef.items.slice(0, 150) as item}
          <VizMiniItem {item} {status} on:dismissed on:undismissed />
        {/each}
        {#if selectedDef.items.length > 150}
          <p class="panel-limit">Showing the first 150 of {selectedDef.items.length.toLocaleString()} items. The cluster count includes all of them.</p>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .sem-outer {
    display: flex;
    flex: 1;
    min-height: 0;
    width: 100%;
    gap: 0;
    background: #0f172a;
    border-radius: 8px;
    overflow: hidden;
  }
  .sem-canvas-wrap {
    flex: 1;
    min-width: 0;
    position: relative;
  }
  canvas { display: block; cursor: crosshair; }
  .overlay {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    color: #94a3b8; font-size: 14px;
  }
  .overlay.error { color: #f87171; }
  .overlay.muted { color: #475569; }
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
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 12px;
    border-bottom: 1px solid #1e293b;
  }
  .panel-dot {
    display: inline-block; width: 8px; height: 8px;
    border-radius: 50%; margin-right: 6px; vertical-align: middle; flex-shrink: 0;
  }
  .panel-title { font-size: 12px; font-weight: 600; color: #e2e8f0; word-break: break-word; }
  .panel-count { display: block; font-size: 11px; color: #64748b; margin-top: 2px; padding-left: 14px; }
  .panel-close {
    background: none; border: none; color: #475569; cursor: pointer;
    font-size: 14px; padding: 0 0 0 8px; flex-shrink: 0; line-height: 1;
  }
  .panel-close:hover { color: #e2e8f0; }
  .panel-list {
    flex: 1;
    overflow-y: auto;
    padding: 6px;
  }
  .panel-limit { color: #64748b; font-size: 11px; line-height: 1.4; padding: 8px; }
</style>
