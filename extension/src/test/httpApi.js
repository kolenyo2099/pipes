// Desktop Canary's HTTP client, kept for UI tests that assert on the requests a view makes.
// Tests route api.js here with: vi.mock('../api.js', () => import('../test/httpApi.js'))
/**
 * API client – thin fetch wrapper over /api
 * All errors surface as { ok: false, error: string }
 * All successes surface as { ok: true, data: ... }
 */

const BASE = '/api'
const TOKEN_PARAM = 'canary_token'

function initializeApiToken() {
  const url = new URL(window.location.href)
  const fromUrl = url.searchParams.get(TOKEN_PARAM)
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_PARAM, fromUrl)
    url.searchParams.delete(TOKEN_PARAM)
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }
  return fromUrl || sessionStorage.getItem(TOKEN_PARAM) || ''
}

const apiToken = initializeApiToken()

async function request(method, path, body = undefined) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(apiToken ? { 'X-Canary-Token': apiToken } : {}),
    },
  }
  if (body !== undefined) opts.body = JSON.stringify(body)

  try {
    const resp = await fetch(`${BASE}${path}`, opts)
    if (!resp.ok) {
      let detail = resp.statusText
      try { const body = await resp.json(); detail = body.error || body.detail || detail } catch (_) {}
      return { ok: false, error: `${resp.status}: ${detail}` }
    }
    if (resp.status === 204) return { ok: true, data: null }
    const data = await resp.json()
    return { ok: true, data }
  } catch (err) {
    return { ok: false, error: err.message || 'Network error' }
  }
}

// ── Projects ──────────────────────────────────────────────────────────────────

export const api = {
  // Projects
  listProjects: () => request('GET', '/projects'),
  getProject: (id) => request('GET', `/projects/${id}`),
  createProject: (data) => request('POST', '/projects', data),
  updateProject: (id, data) => request('PUT', `/projects/${id}`, data),
  deleteProject: (id) => request('DELETE', `/projects/${id}`),
  getProjectStats: (id) => request('GET', `/projects/${id}/stats`),
  triggerCollect: (id) => request('POST', `/projects/${id}/trigger_collect`),
  listSourcePreferences: (id) => request('GET', `/projects/${id}/source-preferences`),
  setSourcePreference: (id, data) => request('POST', `/projects/${id}/source-preferences`, data),
  removeSourcePreference: (id, sourceDomain) =>
    request('DELETE', `/projects/${id}/source-preferences/${encodeURIComponent(sourceDomain)}`),

  // Presets
  getWatchlistPresets: () => request('GET', '/projects/presets/watchlists'),

  // Ontology (CAMEO event categories, actor types, GKG themes, countries)
  getOntology: () => request('GET', '/ontology'),
  searchGkgThemes: (q, limit = 25) =>
    request('GET', `/ontology/gkg-themes?q=${encodeURIComponent(q)}&limit=${limit}`),

  // Items
  listItems: (projectId, params = {}) => {
    const qs = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => { if (v !== null && v !== undefined && v !== '') qs.set(k, v) })
    const query = qs.toString() ? `?${qs}` : ''
    return request('GET', `/projects/${projectId}/items${query}`)
  },
  saveItem: (projectId, itemId, data) =>
    request('POST', `/projects/${projectId}/items/${itemId}/save`, data),
  deleteItem: (projectId, itemId) =>
    request('DELETE', `/projects/${projectId}/items/${itemId}`),
  dismissItem: (projectId, itemId) =>
    request('POST', `/projects/${projectId}/items/${itemId}/dismiss`),
  preferPrimary: (projectId, itemId, data) =>
    request('POST', `/projects/${projectId}/items/${itemId}/prefer-primary`, data),
  reviewDuplicate: (projectId, itemId, data) =>
    request('POST', `/projects/${projectId}/items/${itemId}/duplicate-review`, data),
  undismissItem: (projectId, itemId) =>
    request('POST', `/projects/${projectId}/items/${itemId}/undismiss`),
  bulkDismissFiltered: (projectId, params) =>
    request('POST', `/projects/${projectId}/items/dismiss-filtered`, params),
  getGkgCountTypes: (projectId) =>
    request('GET', `/projects/${projectId}/items/gkg-count-types`),
  sendToSheet: (projectId, itemId) =>
    request('POST', `/projects/${projectId}/items/${itemId}/send_to_sheet`),
  retryFailedSheets: (projectId) =>
    request('POST', `/projects/${projectId}/retry_failed_sheets`),

  // Archives
  archiveItem: (projectId, itemId, acceptCookies = true) =>
    request('POST', `/projects/${projectId}/items/${itemId}/archive?accept_cookies=${acceptCookies}`),
  archiveBatch: (projectId, itemIds, acceptCookies = true) =>
    request('POST', `/projects/${projectId}/items/archive`, {
      item_ids: itemIds,
      accept_cookies: acceptCookies,
    }),
  openArchiveSnapshot: (projectId, archiveId) =>
    request('POST', `/projects/${projectId}/archives/${archiveId}/open-snapshot`),

  // Visualisation
  getVizData: (projectId, status, params = {}) => {
    const query = new URLSearchParams()
    if (status) query.set('status', status)
    if (params.sinceCreatedAt) query.set('since_created_at', params.sinceCreatedAt)
    if (params.limit) query.set('limit', params.limit)
    if (params.offset) query.set('offset', params.offset)
    const qs = query.toString() ? `?${query}` : ''
    return request('GET', `/projects/${projectId}/items/viz-data${qs}`)
  },
  getAllVizData: async (projectId, status, params = {}) => {
    const pageSize = 500
    const items = []
    let offset = 0
    let total = 0
    while (true) {
      const result = await api.getVizData(projectId, status, {
        sinceCreatedAt: params.sinceCreatedAt,
        limit: pageSize,
        offset,
      })
      if (!result.ok) return result
      const page = result.data.items || []
      total = result.data.total ?? items.length + page.length
      items.push(...page)
      params.onProgress?.({ loaded: items.length, total })
      if (page.length === 0 || items.length >= total) {
        return { ok: true, data: { items, total } }
      }
      offset += page.length
    }
  },
  saveEmbeddings: (projectId, embeddings) =>
    request('POST', `/projects/${projectId}/items/embeddings`, { embeddings }),

  // OS helpers
  openArchivesFolder: () => request('POST', '/open-archives-folder'),
  openModelsFolder: () => request('POST', '/open-models-folder'),
  openUrl: (url) => request('POST', '/open-browser', { url }),

  // NLP enrichment (on-device NER + sentiment, plus free language detection)
  getNlpStatus: () => request('GET', '/nlp/status'),
  downloadNlpModels: (packs) => request('POST', '/nlp/download', { packs }),

  // Extension-only event headline enrichment
  getTitleEnrichment: () => request('GET', '/title-enrichment'),
  setTitleEnrichment: (enabled) => request('PUT', '/title-enrichment', { enabled }),

  // Extension-only X and Bluesky lanes
  allowSites: () => Promise.resolve({ ok: true, data: null }),
  getSocialBudgets: () => request('GET', '/social-budgets'),
  getBrokenLanes: () => Promise.resolve({ ok: true, data: {} }),
  setSocialBudget: (lane, per) => request('PUT', `/social-budgets/${lane}`, { per }),
  getBlueskyStatus: () => request('GET', '/bluesky/account'),
  setBlueskyAccount: (identifier, password) => request('PUT', '/bluesky/account', { identifier, password }),
  clearBlueskyAccount: () => request('DELETE', '/bluesky/account'),

  // Media Cloud (application credential + curated collection directory)
  getMediaCloudStatus: () => request('GET', '/mediacloud/status'),
  setMediaCloudToken: (token) => request('PUT', '/mediacloud/token', { token }),
  clearMediaCloudToken: () => request('DELETE', '/mediacloud/token'),
  searchMediaCloudCollections: (q) =>
    request('GET', `/mediacloud/collections?q=${encodeURIComponent(q)}`),

  // Logs
  getLogs: (projectId, limit = 50) =>
    request('GET', `/projects/${projectId}/logs?limit=${limit}`),
  cancelLog: (projectId, logId) =>
    request('POST', `/projects/${projectId}/logs/${logId}/cancel`),

  // Rule presets (global, DB-backed)
  listPresets: () => request('GET', '/presets'),
  createPreset: (data) => request('POST', '/presets', data),
  deletePreset: (id) => request('DELETE', `/presets/${id}`),
}
