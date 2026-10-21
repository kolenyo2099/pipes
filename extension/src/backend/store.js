// Port of desktop store.rs over IndexedDB. Queries load a project's items and filter in memory.
// ponytail: whole-project scans; fine to tens of thousands of items. Add IndexedDB cursors per filter if projects outgrow that.
import { get, put, del, all, byIndex, putMany, delMany, projectItems, getMeta, putMeta, tx } from './db.js'
import { storyAssigner, sourceDomain } from './grouping.js'
import { removeArchiveFiles } from './archiveFiles.js'

export const now = () => new Date().toISOString()
const uuid = () => crypto.randomUUID()
const lower = s => String(s ?? '').toLowerCase()
// Embeddings stay in the database but never travel with list responses.
const view = ({ semantic_embedding, ...item }) => item

// ── Projects ─────────────────────────────────────────────────────────────────
const DEFAULT_POLLING = { events_interval_minutes: 30, doc_interval_minutes: 60, overlap_minutes: 15, events_enabled: true, doc_enabled: false,
  rss_interval_minutes: 60, rss_enabled: false, mediacloud_interval_minutes: 1440, mediacloud_enabled: false, x_interval_minutes: 60, x_enabled: false,
  bluesky_interval_minutes: 60, bluesky_enabled: false, telegram_interval_minutes: 60, telegram_enabled: false, paused: false }

// (bucket_name, lane) is a rule's identity; the last definition wins, as on desktop.
function dedupeWatchlists(rules = []) {
  const seen = new Set()
  return rules.slice().reverse().filter(r => { const k = `${r.bucket_name}|${r.lane}`; return !seen.has(k) && seen.add(k) })
    .reverse().map(r => ({ ...r, enabled: r.enabled !== false }))
}

export const listProjects = async () => (await all('projects')).sort((a, b) => b.created_at.localeCompare(a.created_at))
export const getProject = id => get('projects', id)

export async function createProject(data) {
  if (!String(data.name || '').trim()) throw new HttpError(400, 'Project name is required')
  if (!data.countries_focus?.length) throw new HttpError(400, 'At least one country is required')
  const created = now()
  const project = {
    project_id: uuid(), name: data.name, countries_focus: data.countries_focus, watchlists: dedupeWatchlists(data.watchlists),
    polling_config: { ...DEFAULT_POLLING, ...data.polling_config }, mediacloud_collections: data.mediacloud_collections || [],
    sheet_sink: data.sheet_sink || null, created_at: created, collecting_since: data.collecting_since || created,
    last_events_url: null, last_events_translation_url: null, last_events_collected_at: null, last_doc_collected_at: null,
    last_doc_translation_collected_at: null, last_doc_polled_at: null, last_rss_collected_at: null, last_mediacloud_collected_at: null,
    last_x_collected_at: null, last_bluesky_collected_at: null, last_telegram_collected_at: null, rss_cursors: {}, x_cursors: {}, bluesky_cursors: {},
    telegram_cursors: {},
  }
  await put('projects', project)
  return project
}

export async function updateProject(id, data) {
  const project = await getProject(id)
  if (!project) return null
  for (const key of ['name', 'countries_focus', 'mediacloud_collections', 'collecting_since']) {
    if (data[key] != null) project[key] = data[key]
  }
  // Projects saved before a lane existed have no settings for it.
  if (data.polling_config != null) project.polling_config = { ...DEFAULT_POLLING, ...data.polling_config }
  if (data.watchlists) project.watchlists = dedupeWatchlists(data.watchlists)
  if (data.clear_sheet_sink) project.sheet_sink = null
  else if (data.sheet_sink) project.sheet_sink = data.sheet_sink
  await put('projects', project)
  return project
}

// Collectors change cursors while the settings view may be saving the project; patch only named fields.
export async function patchProject(id, fields) {
  return tx('projects', 'readwrite', store => {
    const request = store.get(id)
    request.onsuccess = () => { if (request.result) store.put({ ...request.result, ...fields }) }
  })
}

export async function deleteProject(id) {
  if (!await getProject(id)) return false
  const archives = await byIndex('archives', 'project_id', id)
  await removeArchiveFiles(archives)
  await delMany('items', (await projectItems(id)).map(i => i.item_id))
  await delMany('logs', (await byIndex('logs', 'project_id', id)).map(l => l.log_id))
  await delMany('archives', archives.map(a => a.archive_id))
  await del('meta', id)
  await del('projects', id)
  return true
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

// ── Items: upsert ────────────────────────────────────────────────────────────
// Returns a function that stores normalized items from one collection run and reports which are new.
// New items join a story; an existing item only gains the rule that matched it again.
export async function itemUpserter(projectId) {
  const existing = await projectItems(projectId)
  const known = new Map(existing.map(i => [i.item_id, i]))
  const meta = await getMeta(projectId)
  const candidates = []
  const assign = storyAssigner(existing, { constraints: meta.group_constraints || [], onCandidate: edge => candidates.push(edge) })
  return async (items, hasSheet) => {
    const changed = new Map(), fresh = []
    for (const incoming of items) {
      const current = changed.get(incoming.item_id) || known.get(incoming.item_id)
      if (current) {
        if (incoming.query_bucket && !current.matched_buckets.includes(incoming.query_bucket)) {
          changed.set(current.item_id, { ...current, matched_buckets: [...current.matched_buckets, incoming.query_bucket] })
        }
        continue
      }
      const item = { ...incoming, matched_buckets: incoming.query_bucket ? [incoming.query_bucket] : [], status: 'inbox',
        saved_by: null, saved_at: null, tags: [], notes: null, sheet_send_status: hasSheet ? 'pending' : 'not_configured',
        sheet_sent_at: null, sheet_last_error: null, created_at: now() }
      item.story_key = assign(item)
      changed.set(item.item_id, item)
      fresh.push(item)
    }
    if (changed.size) await putMany('items', [...changed.values()])
    if (candidates.length) {
      const edges = candidates.splice(0).map(edge => ({ ...edge, edge_id: uuid(), created_at: now(), edition_id: null, human_decision: null }))
      await tx('meta', 'readwrite', store => {
        const request = store.get(projectId)
        request.onsuccess = () => {
          const current = request.result || { project_id: projectId, source_prefs: {}, pinned: {} }
          const existing = current.duplicate_edges || []
          const key = edge => `${edge.left_item_id}|${edge.right_item_id}|${edge.matching_method}`
          const seen = new Set(existing.map(key))
          current.duplicate_edges = [...existing, ...edges.filter(edge => !seen.has(key(edge)) && seen.add(key(edge)))]
          store.put(current)
        }
      })
    }
    for (const item of changed.values()) known.set(item.item_id, item)
    return fresh
  }
}

// ── Items: queries ───────────────────────────────────────────────────────────
function stringsIn(value, out = []) {
  if (typeof value === 'string') out.push(value.toLowerCase())
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringsIn(v, out)
  return out
}
const list = value => Array.isArray(value) ? value : String(value ?? '').split(',').map(s => s.trim()).filter(Boolean)

// Filters shared by list_items and bulk dismiss.
export function itemFilter(p) {
  const countries = p.countries ? list(p.countries).map(lower) : null
  const ids = p.item_ids ? new Set(list(p.item_ids)) : null
  const countTypes = p.count_type ? list(p.count_type) : []
  const num = v => v === undefined || v === null || String(v).trim() === '' ? null : Number(v)
  const toneMin = num(p.tone_min), toneMax = num(p.tone_max)
  const person = lower(p.person).trim(), org = lower(p.organization).trim(), place = lower(p.location_text).trim()
  return item => {
    if (p.status && item.status !== p.status) return false
    if (p.source_type && item.source_type !== p.source_type) return false
    if (p.query_bucket && !item.matched_buckets.includes(p.query_bucket)) return false
    if (p.since && !(item.datetime_utc && item.datetime_utc >= p.since)) return false
    if (countries?.length && !item.countries_focus.some(c => countries.includes(lower(c)))) return false
    if (ids?.size && !ids.has(item.item_id)) return false
    if (p.created_before && !(Date.parse(item.created_at) <= Date.parse(p.created_before))) return false
    if (p.created_after && !(Date.parse(item.created_at) > Date.parse(p.created_after))) return false
    const tone = item.normalized?.tone?.tone
    if (toneMin !== null && !(typeof tone === 'number' && tone >= toneMin)) return false
    if (toneMax !== null && !(typeof tone === 'number' && tone <= toneMax)) return false
    if (countTypes.length && !(item.normalized?.counts || []).some(c => countTypes.includes(c.type))) return false
    if (person || org) {
      const values = stringsIn(item.normalized)
      if (person && !values.some(v => v.includes(person))) return false
      if (org && !values.some(v => v.includes(org))) return false
    }
    if (place && !lower(JSON.stringify(item.normalized?.locations ?? null)).includes(place)) return false
    return true
  }
}

const sortAt = item => item.datetime_utc || item.created_at
function comparator(direction) {
  const sign = direction === 'asc' ? 1 : -1
  return (a, b) => sign * (Date.parse(sortAt(a)) - Date.parse(sortAt(b)) || Date.parse(a.created_at) - Date.parse(b.created_at) || a.item_id.localeCompare(b.item_id))
}

function primaryScore(item, weights) {
  const weight = weights[sourceDomain(item.url)] || 0
  return weight * 10 + (item.url ? 1 : 0) + (item.title_or_summary?.trim() ? 1 : 0) + (item.snippet_or_context?.trim() ? 1 : 0)
}

export async function listItems(projectId, p) {
  const limit = Math.min(Math.max(Number(p.limit) || 100, 1), 500), offset = Math.max(Number(p.offset) || 0, 0)
  const direction = p.sort === 'asc' ? 'asc' : 'desc'
  const source = p.status ? await byIndex('items', 'project_status', [projectId, p.status]) : await projectItems(projectId)
  const matched = source.filter(itemFilter(p)).sort(comparator(direction))
  const total = matched.length

  if (p.group_stories === true || p.group_stories === 'true') {
    const meta = await getMeta(projectId)
    const weights = Object.fromEntries(Object.entries(meta.source_prefs).filter(([, s]) => s.selection_count >= 3).map(([d, s]) => [d, s.weight]))
    const clusters = new Map()
    for (const item of matched) {
      const id = item.story_key || `item:${item.item_id}`
      if (!clusters.has(id)) clusters.set(id, [])
      clusters.get(id).push(item)
    }
    const page = [...clusters].slice(offset, offset + limit)
    const items = [], groups = []
    for (const [cluster_id, members] of page) {
      const pinned = meta.pinned[cluster_id]
      const ordered = members.slice().sort((a, b) => (b.item_id === pinned) - (a.item_id === pinned) || primaryScore(b, weights) - primaryScore(a, weights))
      const [primary, ...siblings] = ordered.map(view)
      const primary_reason = primary.item_id === pinned ? 'Selected by you for this story'
        : weights[sourceDomain(primary.url)] ? 'Preferred from your previous source choices' : 'Suggested from the most complete version'
      items.push(primary, ...siblings)
      groups.push({ cluster_id, primary, siblings, primary_reason })
    }
    const response = { items, total, group_total: clusters.size, has_more: offset + groups.length < clusters.size }
    return groups.length ? { ...response, groups } : response
  }

  let rows = matched
  if (p.cursor_sort_at && p.cursor_created_at && p.cursor_item_id) {
    const cursor = { datetime_utc: p.cursor_sort_at, created_at: p.cursor_created_at, item_id: p.cursor_item_id }
    const compare = comparator(direction)
    rows = rows.filter(item => compare(item, cursor) > 0)
  }
  const pageRows = rows.slice(offset, offset + limit)
  return { items: pageRows.map(view), total, group_total: total, has_more: rows.length > offset + limit }
}

export const getItem = async (projectId, itemId) => {
  const item = await get('items', itemId)
  return item?.project_id === projectId ? item : null
}

async function setItem(projectId, itemId, fields) {
  const item = await getItem(projectId, itemId)
  if (!item) return null
  const next = { ...item, ...fields }
  await put('items', next)
  return view(next)
}

export const saveItem = (projectId, itemId, req) => setItem(projectId, itemId, {
  status: 'saved', saved_by: req.saved_by || 'investigator', saved_at: now(), tags: req.tags || [], notes: req.notes ?? '' })
export const dismissItem = (projectId, itemId) => setItem(projectId, itemId, { status: 'dismissed' })
export const undismissItem = (projectId, itemId) => setItem(projectId, itemId, { status: 'inbox' })
export const setSheetStatus = (projectId, itemId, ok, error) => setItem(projectId, itemId, {
  sheet_send_status: ok ? 'sent' : 'failed', sheet_sent_at: ok ? now() : null, sheet_last_error: error || null })

export async function deleteItem(projectId, itemId) {
  if (!await getItem(projectId, itemId)) return false
  const archives = await byIndex('archives', 'item_id', itemId)
  await removeArchiveFiles(archives)
  await delMany('archives', archives.map(a => a.archive_id))
  await tx('meta', 'readwrite', store => {
    const request = store.get(projectId)
    request.onsuccess = () => {
      const meta = request.result
      if (!meta) return
      for (const key of ['duplicate_edges', 'group_constraints']) {
        meta[key] = (meta[key] || []).filter(pair => pair.left_item_id !== itemId && pair.right_item_id !== itemId)
      }
      store.put(meta)
    }
  })
  await del('items', itemId)
  return true
}

export async function bulkDismiss(projectId, body) {
  if (body.item_ids && body.item_ids.length > 5000) throw new HttpError(413, 'Dismiss is limited to 5000 items per request')
  const inbox = await byIndex('items', 'project_status', [projectId, 'inbox'])
  const ids = body.item_ids && new Set(body.item_ids)
  const targets = ids ? inbox.filter(i => ids.has(i.item_id)) : inbox.filter(itemFilter({ ...body, status: 'inbox' }))
  await putMany('items', targets.map(i => ({ ...i, status: 'dismissed' })))
  return targets.length
}

// Retries run one request at a time, so each batch is capped; the rest go next time.
export const failedSheetItems = async projectId => (await projectItems(projectId)).filter(i => i.sheet_send_status === 'failed').slice(0, 200)

export async function gkgCountTypes(projectId) {
  const types = new Set()
  for (const item of await projectItems(projectId)) if (item.source_type === 'gkg') for (const c of item.normalized?.counts || []) if (c.type) types.add(c.type)
  return [...types].sort()
}

export async function stats(projectId) {
  const items = await projectItems(projectId)
  const count = pred => items.filter(pred).length
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
  const days = {}
  for (const item of items) {
    const day = item.datetime_utc?.slice(0, 10)
    if (day && day >= since) days[day] = (days[day] || 0) + 1
  }
  const tracked = items.filter(i => i.source_type === 'events' && i.normalized?.source_stream)
  const translated = tracked.filter(i => i.normalized.source_stream === 'translation').length
  return {
    project_id: projectId,
    daily_counts: Object.keys(days).sort().map(day => ({ day, count: days[day] })),
    inbox_count: count(i => i.status === 'inbox'), saved_count: count(i => i.status === 'saved'), dismissed_count: count(i => i.status === 'dismissed'),
    failed_sheet_sends: count(i => i.sheet_send_status === 'failed'),
    multilingual_pct: tracked.length ? Math.round(1000 * translated / tracked.length) / 10 : null,
    tracked_events_count: tracked.length,
  }
}

export async function vizItems(projectId, p) {
  const source = p.status ? await byIndex('items', 'project_status', [projectId, p.status]) : await projectItems(projectId)
  const rows = source.filter(i => !p.since_created_at || i.created_at > p.since_created_at)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.item_id.localeCompare(a.item_id))
  const limit = Math.min(Math.max(Number(p.limit) || 500, 1), 1000), offset = Math.max(Number(p.offset) || 0, 0)
  const items = rows.slice(offset, offset + limit).map(i => {
    const embedding = i.semantic_embedding
    const current = embedding?.model === 'canary-feature-hash-v1' && embedding.source_text === (i.title_or_summary ?? i.url ?? '')
    return { item_id: i.item_id, created_at: i.created_at, title_or_summary: i.title_or_summary, url: i.url, countries_focus: i.countries_focus,
      source_type: i.source_type, query_bucket: i.query_bucket, normalized: i.normalized, ...(current ? { semantic_embedding: embedding.embedding } : {}) }
  })
  return { items, total: rows.length, has_more: offset + items.length < rows.length }
}

export async function saveEmbeddings(projectId, embeddings) {
  if (embeddings.length > 500) throw new HttpError(413, 'Embedding batch exceeds production limits')
  const updates = []
  for (const e of embeddings) {
    const item = e.embedding?.length && await getItem(projectId, e.item_id)
    if (item) updates.push({ ...item, semantic_embedding: { model: e.model, source_text: e.source_text, embedding: e.embedding } })
  }
  await putMany('items', updates)
}

// ── Story primaries and source preferences ───────────────────────────────────
export async function reviewDuplicate(projectId, itemId, { other_item_id, action }) {
  if (!['keep_both', 'not_duplicates', 'merge_groups', 'split_item'].includes(action)) throw new HttpError(400, 'Unknown duplicate review action')
  if (itemId === other_item_id || !await getItem(projectId, itemId) || !await getItem(projectId, other_item_id)) return false
  const [left_item_id, right_item_id] = [itemId, other_item_id].sort()
  await tx('meta', 'readwrite', store => {
    const request = store.get(projectId)
    request.onsuccess = () => {
      const meta = request.result || { project_id: projectId, source_prefs: {}, pinned: {} }
      const matches = pair => pair.left_item_id === left_item_id && pair.right_item_id === right_item_id
      meta.group_constraints ||= []
      if (['keep_both', 'not_duplicates'].includes(action) && !meta.group_constraints.some(c => matches(c) && c.constraint_type === action)) {
        meta.group_constraints.push({ constraint_id: uuid(), left_item_id, right_item_id, constraint_type: action, created_at: now() })
      }
      meta.duplicate_edges = (meta.duplicate_edges || []).map(edge => matches(edge) ? { ...edge, human_decision: action } : edge)
      store.put(meta)
    }
  })
  return true
}

const prefView = ([source_domain, s]) => ({ source_domain, weight: s.weight, selection_count: s.selection_count, active: s.selection_count >= 3 })

export async function listSourcePreferences(projectId) {
  const { source_prefs } = await getMeta(projectId)
  return Object.entries(source_prefs).map(prefView)
    .sort((a, b) => (b.active - a.active) || b.weight - a.weight || a.source_domain.localeCompare(b.source_domain))
}

export async function setSourcePreference(projectId, source) {
  const trimmed = String(source || '').trim()
  const domain = sourceDomain(trimmed) || sourceDomain(`https://${trimmed}`)
  if (!domain || !domain.includes('.')) throw new HttpError(400, 'Enter a valid source domain, such as reuters.com')
  const meta = await getMeta(projectId)
  const current = meta.source_prefs[domain] || { weight: 0, selection_count: 0 }
  meta.source_prefs[domain] = { weight: Math.max(current.weight, 3), selection_count: Math.max(current.selection_count, 3) }
  await putMeta(meta)
  return prefView([domain, meta.source_prefs[domain]])
}

export async function removeSourcePreference(projectId, domain) {
  const meta = await getMeta(projectId)
  if (!meta.source_prefs[domain]) return false
  delete meta.source_prefs[domain]
  await putMeta(meta)
  return true
}

export async function preferPrimary(projectId, itemId, { story_key, prefer_source }) {
  const item = await getItem(projectId, itemId)
  if (!item || item.story_key !== story_key) return false
  const meta = await getMeta(projectId)
  meta.pinned[story_key] = itemId
  const domain = sourceDomain(item.url)
  if (domain) {
    // A one-off choice is a small learning signal; "prefer source" is enough to activate the source.
    const current = meta.source_prefs[domain] || { weight: 0, selection_count: 0 }
    meta.source_prefs[domain] = { weight: current.weight + (prefer_source ? 3 : 1), selection_count: current.selection_count + (prefer_source ? 3 : 1) }
  }
  await putMeta(meta)
  return true
}

// ── Logs ─────────────────────────────────────────────────────────────────────
export async function createLog(projectId, lane) {
  const log = { log_id: uuid(), project_id: projectId, lane, started_at: now(), finished_at: null, checked_count: 0, fetch_count: 0, new_count: 0, error: null }
  await put('logs', log)
  return log
}
export async function finishLog(log, fields) {
  const current = await get('logs', log.log_id)
  // A log the user cancelled keeps its cancellation message.
  if (current?.finished_at) return
  await put('logs', { ...log, ...fields, finished_at: now() })
}
export const listLogs = async (projectId, limit = 50) => (await byIndex('logs', 'project_id', projectId))
  .sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, Math.min(Math.max(limit, 1), 500))
export async function cancelLog(projectId, logId) {
  const log = await get('logs', logId)
  if (!log || log.project_id !== projectId || log.finished_at) return false
  await put('logs', { ...log, finished_at: now(), error: 'Cancelled by user' })
  return true
}

// ── Presets ──────────────────────────────────────────────────────────────────
export const listPresets = async () => (await all('presets')).sort((a, b) => a.created_at.localeCompare(b.created_at))
export async function createPreset({ name, lane, logic }) {
  const preset = { preset_id: uuid(), name, lane, logic, created_at: now() }
  await put('presets', preset)
  return preset
}
export async function deletePreset(id) {
  if (!await get('presets', id)) return false
  await del('presets', id)
  return true
}

// ── Backup ───────────────────────────────────────────────────────────────────
// Everything except secrets (the Media Cloud token) and the archive files, which live in Downloads.
const BACKUP_STORES = ['projects', 'items', 'logs', 'presets', 'meta', 'archives']
export async function exportBackup() {
  const data = { canary_backup: 1, exported_at: now() }
  for (const name of BACKUP_STORES) data[name] = await all(name)
  return data
}
export async function importBackup(data) {
  if (data?.canary_backup !== 1 || !Array.isArray(data.projects) || !Array.isArray(data.items)) throw new HttpError(400, 'Choose a Canary backup file')
  for (const name of BACKUP_STORES) if (Array.isArray(data[name])) await putMany(name, data[name])
  return { projects: data.projects.length, items: data.items.length }
}
