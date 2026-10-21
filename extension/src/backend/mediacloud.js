// Port of desktop mediacloud.rs.
import { countryName, hash } from './ontology.js'
import { getSetting } from './db.js'

const API = 'https://search.mediacloud.org/api'
export const TOKEN_SETTING = 'mediacloud_api_token'
const PAGE_SIZE = 1000
const MAX_PAGES_PER_RULE = 10
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const strings = (logic, key) => Array.isArray(logic?.[key]) ? logic[key].map(v => String(v).trim()).filter(Boolean) : []

export const configuredToken = () => getSetting(TOKEN_SETTING)

async function getJson(token, path, params = {}) {
  const url = `${API}/${path}?${new URLSearchParams(params)}`
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { headers: { Authorization: `Token ${token}`, Accept: 'application/json' } })
    if (response.status === 429 && attempt < 2) {
      await sleep(Math.min(Number(response.headers.get('retry-after')) || 30, 60) * 1000)
      continue
    }
    if (response.status === 429) throw new Error('Media Cloud rate limit reached')
    if (!response.ok) throw new Error(`Media Cloud returned HTTP ${response.status} for ${path}`)
    return response.json()
  }
}

export const validateToken = token => getJson(token, 'auth/profile')

const catalog = new Map()
export async function collectionSearch(token, query) {
  const key = query.trim().toLowerCase()
  if (!key) return []
  const cached = catalog.get(key)
  if (cached && Date.now() - cached.at < 86_400_000) return cached.rows
  const page = await getJson(token, 'sources/collections/', { platform: 'online_news', name: query.trim(), limit: 100, offset: 0 })
  const rows = page.results.map(r => ({ id: r.id, name: r.name, source_count: r.source_count ?? null, monitored: !!r.monitored }))
    .sort((a, b) => (b.monitored - a.monitored) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  catalog.set(key, { at: Date.now(), rows })
  return rows
}

const quote = term => { const t = term.replaceAll('"', '\\"'); return /\s/.test(t) ? `"${t}"` : t }
const orGroup = terms => { const t = terms.map(s => s.trim()).filter(Boolean).map(quote); return t.length > 1 ? `(${t.join(' OR ')})` : t[0] || null }

export function compileQuery(project, rule) {
  const logic = rule.logic || {}
  const simple = strings(logic, 'query_terms').length ? strings(logic, 'query_terms') : strings(logic, 'focus_terms')
  if (simple.length) return orGroup(simple) || '*'
  const extras = strings(logic, 'countries').map(countryName)
  const clauses = [
    orGroup(project.countries_focus.map(countryName)),
    ...(extras.length ? (logic.countries_mode === 'any' ? [orGroup(extras)] : extras.map(quote)) : []),
    orGroup([...strings(logic, 'action_core'), ...strings(logic, 'action_alt')]),
    orGroup([...strings(logic, 'people'), ...strings(logic, 'organizations')]),
    ...strings(logic, 'exclude').map(x => `NOT ${quote(x)}`),
  ].filter(Boolean)
  return clauses.length ? clauses.join(' AND ') : '*'
}

// Media Cloud runs daily with a one-day overlap; it never searches before the project's collection start.
function searchWindow(project) {
  const day = 86_400_000
  const start = project.last_mediacloud_collected_at ? Date.parse(project.last_mediacloud_collected_at) - day : Date.now() - 2 * day
  const floor = Date.parse(project.collecting_since || project.created_at)
  return [new Date(Math.max(start, floor)).toISOString().slice(0, 10), new Date().toISOString().slice(0, 10)]
}

function normalizeStory(project, rule, collections, query, story) {
  const indexed = Date.parse(String(story.indexed_date || '').replace(' ', 'T'))
  const published = story.publish_date ? Date.parse(`${story.publish_date.slice(0, 10)}T00:00:00Z`) : NaN
  const datetime = Number.isFinite(indexed) ? new Date(indexed).toISOString() : Number.isFinite(published) ? new Date(published).toISOString() : null
  const countries = [...new Set([...project.countries_focus, ...strings(rule.logic, 'countries')])]
  return {
    item_id: hash([project.project_id, 'mediacloud', story.id]), project_id: project.project_id, source_type: 'mediacloud',
    gdelt_primary_id: story.id, datetime_utc: datetime, countries_focus: countries, query_bucket: rule.bucket_name,
    title_or_summary: story.title, url: story.url, snippet_or_context: null,
    normalized: { mediacloud_story_id: story.id, source_name: story.media_name, source_url: story.media_url, language: story.language,
      publish_date: story.publish_date, indexed_date: story.indexed_date, query,
      collection_ids: collections.map(c => c.id), collection_names: collections.map(c => c.name) },
    gdelt_raw: null,
  }
}

// Returns [items, error].
export async function fetchForProject(project, token, signal) {
  const rules = project.watchlists.filter(r => r.lane === 'mediacloud' && r.enabled)
  if (!rules.length) return [[], 'No enabled Media Cloud rules']
  const [start, end] = searchWindow(project)
  const items = [], errors = [], seen = new Set()
  for (const rule of rules) {
    const collections = Array.isArray(rule.logic?.mediacloud_collections) ? rule.logic.mediacloud_collections : project.mediacloud_collections
    if (!collections.length) { errors.push(`${rule.bucket_name}: no Media Cloud collections selected`); continue }
    const query = compileQuery(project, rule)
    if (query === '*') { errors.push(`${rule.bucket_name}: rule has no search terms`); continue }
    let pagination
    for (let page = 0; page < MAX_PAGES_PER_RULE; page++) {
      if (signal?.aborted) throw new DOMException('Collection stopped', 'AbortError')
      const params = { q: query, start, end, platform: 'onlinenews-mediacloud', cs: collections.map(c => c.id).join(','), page_size: PAGE_SIZE, sort_order: 'asc',
        ...(pagination ? { pagination_token: pagination } : {}) }
      try {
        const result = await getJson(token, 'search/story-list', params)
        for (const story of result.stories) {
          if (seen.has(`${story.id}:${rule.bucket_name}`)) continue
          seen.add(`${story.id}:${rule.bucket_name}`)
          items.push(normalizeStory(project, rule, collections, query, story))
        }
        pagination = result.pagination_token
        if (!pagination) break
      } catch (error) {
        errors.push(`${rule.bucket_name}: ${error.message}`)
        break
      }
    }
  }
  return [items, errors.length ? errors.join('; ') : null]
}
