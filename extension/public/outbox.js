// Pipeline outbox (classic script, imported by background.js). Every save goes through here to the team bridge.
// Contract: docs/extension-save-contract.md. The queue lives in chrome.storage.local so it survives service-worker restarts.
const OUTBOX = 'pipelineOutbox', SENT = 'pipelineSent', RESULTS = 'pipelineResults', LAST_ERROR = 'pipelineLastError'
const BATCH = 25, MAX_TRIES = 4, MAX_SENT = 5000, MAX_RESULTS = 1000

const store = async key => (await chrome.storage.local.get(key))[key]
const getTeam = async () => (await store('pipelineTeam')) || {}
const configured = team => !!(team.url && team.token)

// All queue writes go through here one at a time, so an enqueue can't overwrite a drain's update.
let chain = Promise.resolve()
function mutate(fn) {
  const run = chain.then(async () => {
    const queue = (await store(OUTBOX)) || []
    const out = await fn(queue)
    await chrome.storage.local.set({ [OUTBOX]: queue })
    badge(queue)
    return out
  })
  chain = run.catch(() => {})
  return run
}

function badge(queue) {
  chrome.action.setBadgeText({ text: queue.length ? String(queue.length) : '' })
  if (queue.length) chrome.action.setBadgeBackgroundColor({ color: queue.some(i => i.parked) ? '#c5221f' : '#1a73e8' })
}

async function pipelineEnqueue(item) {
  const team = await getTeam()
  if (!configured(team)) return { ok: false, error: 'Team not configured: paste the join code in Settings' }
  if (item?.kind === 'capture' ? !item.capture?.url : item?.kind !== 'canary' || !item.ref || !item.headers || !item.values) return { ok: false, error: 'Invalid item' }
  const sent = (await store(SENT)) || {}
  const queued = await mutate(queue => {
    if (item.key && (sent[item.key] || queue.some(i => i.key === item.key))) return false
    const entry = { ...item, uid: Date.now() + Math.random(), retries: 0 }
    if (entry.kind === 'capture') entry.capture = { ...entry.capture, savedBy: entry.capture.savedBy || team.name || '' }
    queue.push(entry)
    return true
  })
  chrome.storage.local.remove(LAST_ERROR)
  if (queued && item.kind === 'canary') { // a resend must not be settled by the previous attempt's result
    const results = (await store(RESULTS)) || {}
    if (delete results[item.ref]) await chrome.storage.local.set({ [RESULTS]: results })
  }
  if (queued) drain()
  return { ok: true, queued }
}

// Returns one result per batch item, or throws {message, fatal} when the whole request failed (fatal = wrong token).
async function post(team, batch) {
  const request = body => fetch(team.url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ token: team.token, ...body }) })
  const fail = (message, fatal) => { throw { message, fatal: fatal || /^unauthorized/i.test(message) } }
  if (batch[0].kind === 'canary') {
    const response = await request({ headers: batch[0].headers, values: batch[0].values })
    const text = (await response.text()).trim()
    if (!response.ok) fail(`HTTP ${response.status}`)
    return text === 'OK' ? [{ ok: true }] : fail(text.slice(0, 300))
  }
  const response = await request({ action: 'dataBatch', sheetName: 'Archive', items: batch.map(i => ({ capture: i.capture })) })
  if (!response.ok) fail(`HTTP ${response.status}`)
  const reply = await response.json()
  if (reply.ok === false || reply.status === 'error' || !Array.isArray(reply.results)) fail(reply.error || 'Bad reply from the bridge')
  return batch.map((_, i) => reply.results[i] || { ok: false, error: 'No result for this item' })
}

let draining = false
async function drain() {
  if (draining) return
  draining = true
  try {
    await new Promise(r => setTimeout(r, 300)) // let a burst of enqueues (Save all) land in one batch
    for (;;) {
      const active = ((await store(OUTBOX)) || []).filter(i => !i.parked)
      if (!active.length) return
      const head = active[0]
      const batch = head.kind === 'canary' ? [head] : active.filter(i => i.kind === 'capture').slice(0, BATCH)
      const team = await getTeam()
      let results, failure
      try {
        if (!configured(team)) throw { message: 'Team not configured', fatal: true }
        results = await post(team, batch)
      } catch (error) {
        failure = { message: error.message || String(error), fatal: error.fatal }
      }
      const delivered = []
      const tries = await mutate(queue => {
        let retries = 0
        batch.forEach((entry, n) => {
          const at = queue.findIndex(i => i.uid === entry.uid)
          if (at < 0) return
          const result = results?.[n], target = queue[at]
          if (result?.ok) queue.splice(at, 1)
          else {
            target.error = failure?.message || result.error || 'Failed'
            target.retries++
            retries = Math.max(retries, target.retries)
            // A wrong token or a rejection of this one item will not fix itself: park right away.
            if (failure?.fatal || !failure || target.retries >= MAX_TRIES) target.parked = true
            else return
          }
          delivered.push({ kind: entry.kind, ref: entry.ref, key: entry.key, ok: !!result?.ok, error: result?.ok ? undefined : target.error, id: result?.id })
        })
        return retries
      })
      await finish(delivered, failure)
      if (failure && !failure.fatal && tries && tries < MAX_TRIES) await new Promise(r => setTimeout(r, Math.min(2000 * 2 ** (tries - 1), 20000)))
    }
  } finally {
    draining = false
  }
}

async function finish(delivered, failure) {
  if (failure) await chrome.storage.local.set({ [LAST_ERROR]: failure.message })
  else if (delivered.some(d => d.ok)) await chrome.storage.local.remove(LAST_ERROR)
  if (!delivered.length) return
  const now = Date.now()
  const sentKeys = delivered.filter(d => d.ok && d.key)
  if (sentKeys.length) {
    const sent = (await store(SENT)) || {}
    sentKeys.forEach(d => { sent[d.key] = now })
    const old = Object.entries(sent).sort((a, b) => a[1] - b[1]).slice(0, Math.max(0, Object.keys(sent).length - MAX_SENT))
    old.forEach(([key]) => delete sent[key])
    await chrome.storage.local.set({ [SENT]: sent })
  }
  const canary = delivered.filter(d => d.kind === 'canary')
  if (canary.length) {
    const results = (await store(RESULTS)) || {}
    canary.forEach(d => { results[d.ref] = { ok: d.ok, error: d.error || null, id: d.id || null, at: now } })
    const old = Object.entries(results).sort((a, b) => a[1].at - b[1].at).slice(0, Math.max(0, Object.keys(results).length - MAX_RESULTS))
    old.forEach(([ref]) => delete results[ref])
    await chrome.storage.local.set({ [RESULTS]: results })
  }
  Promise.resolve(chrome.runtime.sendMessage({ type: 'pipeline:delivered', results: delivered })).catch(() => {})
}

async function status() {
  const queue = (await store(OUTBOX)) || []
  const team = await getTeam()
  return { pending: queue.filter(i => !i.parked).length, parked: queue.filter(i => i.parked).length, lastError: (await store(LAST_ERROR)) || '',
    team: { configured: configured(team), name: team.name || '', url: team.url || '' } }
}

async function retry() {
  await mutate(queue => queue.forEach(i => { i.parked = false; i.retries = 0; delete i.error }))
  await chrome.storage.local.remove(LAST_ERROR)
  drain()
  return { ok: true }
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  const run = { 'pipeline:save': () => pipelineEnqueue(message.item), 'pipeline:status': status, 'pipeline:retry': retry,
    'pipeline:drain': async () => { drain(); return { ok: true } } }[message?.type]
  if (!run) return
  run().then(reply, error => reply({ ok: false, error: error.message || String(error) }))
  return true
})

// A recurring alarm is the only wake-up Chrome guarantees, so it is what makes the queue durable.
chrome.alarms.create('pipeline-drain', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'pipeline-drain') drain() })
chrome.storage.local.get(OUTBOX).then(stored => badge(stored[OUTBOX] || []))
drain()
