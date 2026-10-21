/**
 * Local API — same interface as desktop Canary's HTTP client, served from IndexedDB in the browser.
 * All errors surface as { ok: false, error: string }
 * All successes surface as { ok: true, data: ... }
 */
import * as store from './backend/store.js'
import { ontology, searchThemes } from './backend/ontology.js'
import { runProjectNow, channel, BUDGETS, budgetUsed, BROKEN_LANES } from './backend/collect.js'
import { sendToSheet } from './backend/sheets.js'
import { validateToken, collectionSearch, configuredToken, TOKEN_SETTING } from './backend/mediacloud.js'
import { BLUESKY_ACCOUNT, blueskySignIn } from './backend/bluesky.js'
import { archiveItem, archiveBatch, openSnapshot, openArchivesFolder } from './backend/archive.js'
import { getSetting, setSetting, deleteSetting } from './backend/db.js'
import watchlistPresets from './backend/data/watchlist_presets.json'
import { configureNlp, nlpStatus } from './backend/nlp.js'

const { HttpError } = store
export const inExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id

async function call(fn) {
  try {
    return { ok: true, data: (await fn()) ?? null }
  } catch (error) {
    return { ok: false, error: `${error.status || 500}: ${error.message || error}` }
  }
}
const orNotFound = (message) => value => { if (value === null || value === false) throw new HttpError(404, message); return value }

async function sendItemToSheet(projectId, itemId) {
  const project = orNotFound('Project not found')(await store.getProject(projectId) || null)
  const item = orNotFound('Item not found')(await store.getItem(projectId, itemId))
  if (!project.sheet_sink) throw new HttpError(400, 'No sheet sink configured for this project')
  const [ok, error] = await sendToSheet(item, project.sheet_sink)
  return store.setSheetStatus(projectId, itemId, ok, error)
}

// In the extension, collection runs in the offscreen document so it continues when this tab closes.
async function triggerCollect(projectId) {
  orNotFound('Project not found')(await store.getProject(projectId) || null)
  const started = inExtension ? await chrome.runtime.sendMessage({ type: 'run-now', projectId }) : await runProjectNow(projectId)
  if (!started) throw new HttpError(409, 'No enabled collection lane is available to start')
  return { status: 'triggered', project_id: projectId }
}

async function changeNlp(operation) {
  if (!inExtension) return configureNlp(operation)
  const prepared = await chrome.runtime.sendMessage({ type: 'prepare-nlp' })
  if (!prepared?.ready) throw new Error(prepared?.error || 'The NLP collector could not start')
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'nlp', operation })
  if (!response || response.error) throw new Error(response?.error || 'The NLP collector did not respond')
  return response.result
}

// Telegram's MTProto client is intentionally loaded only in the offscreen document. That keeps its
// authenticated WebSocket and session out of app tabs, while still remaining entirely local to Chrome.
async function telegramControl(operation, payload = {}) {
  if (!inExtension) throw new Error('Telegram API connection needs the Canary Chrome extension')
  const prepared = await chrome.runtime.sendMessage({ type: 'prepare-telegram' })
  if (!prepared?.ready) throw new Error(prepared?.error || 'The Telegram connector could not start')
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'telegram-api', operation, payload })
  if (!response || response.error) throw new Error(response?.error || 'The Telegram connector did not respond')
  return response.result
}

export const api = {
  // Projects
  listProjects: () => call(store.listProjects),
  getProject: (id) => call(async () => orNotFound('Project not found')(await store.getProject(id) || null)),
  createProject: (data) => call(() => store.createProject(data)),
  updateProject: (id, data) => call(async () => orNotFound('Project not found')(await store.updateProject(id, data))),
  deleteProject: (id) => call(async () => { orNotFound('Project not found')(await store.deleteProject(id)) }),
  getProjectStats: (id) => call(() => store.stats(id)),
  triggerCollect: (id) => call(() => triggerCollect(id)),
  listSourcePreferences: (id) => call(async () => ({ preferences: await store.listSourcePreferences(id) })),
  setSourcePreference: (id, data) => call(() => store.setSourcePreference(id, data.source_domain)),
  removeSourcePreference: (id, sourceDomain) =>
    call(async () => { orNotFound('Source preference not found')(await store.removeSourcePreference(id, sourceDomain)) }),

  // Presets
  getWatchlistPresets: () => call(() => watchlistPresets),

  // Ontology (CAMEO event categories, actor types, GKG themes, countries)
  getOntology: () => call(() => ontology),
  searchGkgThemes: (q, limit = 25) => call(() => searchThemes(q, limit)),

  // Items
  listItems: (projectId, params = {}) => call(() => store.listItems(projectId, params)),
  saveItem: (projectId, itemId, data) => call(async () => {
    const before = orNotFound('Item not found')(await store.getItem(projectId, itemId))
    const saved = await store.saveItem(projectId, itemId, data)
    // Auto-send only on the first save (inbox → saved), not when tags are edited later.
    const project = await store.getProject(projectId)
    if (before.status === 'inbox' && project?.sheet_sink?.auto_send_on_save) return sendItemToSheet(projectId, itemId)
    return saved
  }),
  deleteItem: (projectId, itemId) => call(async () => { orNotFound('Item not found')(await store.deleteItem(projectId, itemId)) }),
  dismissItem: (projectId, itemId) => call(async () => orNotFound('Item not found')(await store.dismissItem(projectId, itemId))),
  preferPrimary: (projectId, itemId, data) =>
    call(async () => { orNotFound('Item is not in this story group')(await store.preferPrimary(projectId, itemId, data)); return { status: 'saved' } }),
  reviewDuplicate: (projectId, itemId, data) =>
    call(async () => { orNotFound('Items not found')(await store.reviewDuplicate(projectId, itemId, data)); return { status: 'saved' } }),
  undismissItem: (projectId, itemId) => call(async () => orNotFound('Item not found')(await store.undismissItem(projectId, itemId))),
  bulkDismissFiltered: (projectId, params) => call(async () => ({ dismissed: await store.bulkDismiss(projectId, params) })),
  getGkgCountTypes: (projectId) => call(async () => ({ count_types: await store.gkgCountTypes(projectId) })),
  sendToSheet: (projectId, itemId) => call(() => sendItemToSheet(projectId, itemId)),
  retryFailedSheets: (projectId) => call(async () => {
    const failed = await store.failedSheetItems(projectId)
    const results = []
    for (const item of failed) {
      const updated = await sendItemToSheet(projectId, item.item_id)
      results.push({ item_id: item.item_id, success: updated.sheet_send_status === 'sent', error: updated.sheet_last_error })
    }
    return { retried: results.length, results }
  }),

  // Archives (MHTML in Downloads/Canary; the cookie choice applies to desktop's isolated browser only)
  archiveItem: (projectId, itemId) => call(() => archiveItem(projectId, itemId)),
  archiveBatch: (projectId, itemIds) => call(() => archiveBatch(projectId, itemIds)),
  openArchiveSnapshot: (projectId, archiveId) => call(() => openSnapshot(projectId, archiveId)),

  // Visualisation
  getVizData: (projectId, status, params = {}) => call(() => store.vizItems(projectId, {
    status, since_created_at: params.sinceCreatedAt, limit: params.limit, offset: params.offset })),
  getAllVizData: async (projectId, status, params = {}) => {
    const items = []
    for (let offset = 0; ;) {
      const result = await api.getVizData(projectId, status, { sinceCreatedAt: params.sinceCreatedAt, limit: 500, offset })
      if (!result.ok) return result
      items.push(...result.data.items)
      params.onProgress?.({ loaded: items.length, total: result.data.total })
      if (!result.data.items.length || items.length >= result.data.total) return { ok: true, data: { items, total: result.data.total } }
      offset += result.data.items.length
    }
  },
  saveEmbeddings: (projectId, embeddings) => call(() => store.saveEmbeddings(projectId, embeddings)),

  // Browser helpers
  openArchivesFolder: () => call(openArchivesFolder),
  openUrl: (url) => call(() => { window.open(url, '_blank', 'noopener,noreferrer') }),

  // Headline enrichment for GDELT events: fetches each article's <title>, which needs access to all sites.
  getTitleEnrichment: () => call(async () => !!await getSetting('title_enrichment')),
  setTitleEnrichment: (enabled) => {
    // chrome.permissions.request must run before any await, while the click still counts as a user gesture.
    const granted = enabled && inExtension ? chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] }) : Promise.resolve(enabled)
    return call(async () => {
      const on = enabled && await granted
      if (enabled && !on) throw new HttpError(403, 'Chrome did not grant access to article pages')
      await setSetting('title_enrichment', on)
      if (!on && inExtension) await chrome.permissions.remove({ origins: ['https://*/*', 'http://*/*'] })
      return on
    })
  },

  // X rules open their searches on x.com in this browser and Telegram rules read t.me; Chrome asks once for each site.
  allowSites: origins => {
    const granted = inExtension ? chrome.permissions.request({ origins }) : Promise.resolve(true)
    const names = origins.map(origin => new URL(origin.replace('*', '')).hostname).join(' and ')
    return call(async () => { if (!await granted) throw new HttpError(403, `Chrome did not grant access to ${names}`) })
  },

  // X, Bluesky and Telegram each have one request budget shared by all projects (see BUDGETS in collect.js).
  getSocialBudgets: () => call(async () => {
    const budgets = {}
    for (const lane of Object.keys(BUDGETS)) {
      const budget = { ...BUDGETS[lane], per: Number(await getSetting(`${lane}_budget_per`)) || BUDGETS[lane].per }
      budgets[lane] = { per: budget.per, minutes: budget.windowMs / 60_000, used: budgetUsed(await getSetting(`${lane}_budget`), budget, Date.now()),
        paused_until: await getSetting(`${lane}_paused_until`) || null }
    }
    return budgets
  }),
  setSocialBudget: (lane, per) => call(async () => {
    if (!BUDGETS[lane] || !(Number(per) >= 1)) throw new HttpError(400, 'Enter how many requests to allow')
    await setSetting(`${lane}_budget_per`, Math.round(Number(per)))
  }),

  // Lanes whose source changed its format (see BROKEN_LANES in collect.js).
  getBrokenLanes: () => call(async () => await getSetting(BROKEN_LANES) || {}),

  // Bluesky search needs a signed-in account: a handle and an app password, checked here and kept in this browser.
  getBlueskyStatus: () => call(async () => ({ handle: (await getSetting(BLUESKY_ACCOUNT))?.identifier || null })),
  setBlueskyAccount: (identifier, password) => call(async () => {
    const account = { identifier: identifier.trim().replace(/^@/, ''), password: password.trim() }
    if (!account.identifier || !account.password) throw new HttpError(400, 'Enter a Bluesky handle and an app password')
    try { await blueskySignIn(account) } catch (error) {
      throw new HttpError(400, error.status === 401 ? 'Bluesky rejected this handle or app password' : `Bluesky sign-in failed: ${error.message}`)
    }
    await setSetting(BLUESKY_ACCOUNT, account)
    return { handle: account.identifier }
  }),
  clearBlueskyAccount: () => call(async () => { await deleteSetting(BLUESKY_ACCOUNT); return { handle: null } }),

  // Telegram uses its user API through a local WSS client in the extension. Credentials and the saved
  // session stay in IndexedDB, never leave this browser, and are excluded from Canary backups.
  getTelegramStatus: () => call(() => telegramControl('status')),
  beginTelegramConnect: account => call(() => telegramControl('begin', account)),
  finishTelegramCode: code => call(() => telegramControl('code', { code })),
  finishTelegramPassword: password => call(() => telegramControl('password', { password })),
  cancelTelegramConnect: () => call(() => telegramControl('cancel')),
  clearTelegramAccount: () => call(() => telegramControl('clear')),

  // Shared browser NLP models; inference stays in the offscreen collector.
  getNlpStatus: () => call(nlpStatus),
  installNlpModel: pack => {
    const permission = inExtension ? chrome.permissions.request({ origins: ['https://huggingface.co/*', 'https://*.hf.co/*'] }) : Promise.resolve(true)
    return call(async () => {
      if (!await permission) throw new HttpError(403, 'Chrome did not grant access to the model download host')
      return changeNlp({ type: 'install', pack })
    })
  },
  removeNlpModel: pack => call(() => changeNlp({ type: 'remove', pack })),
  setNlpEnabled: (pack, enabled) => call(() => changeNlp({ type: 'enable', pack, enabled })),

  // Media Cloud (application credential + curated collection directory)
  getMediaCloudStatus: () => call(async () => ({ configured: !!await configuredToken(), source: 'local' })),
  setMediaCloudToken: (token) => call(async () => {
    if (!token.trim()) throw new HttpError(400, 'Media Cloud API token is required')
    try { await validateToken(token.trim()) } catch { throw new HttpError(400, 'Media Cloud rejected this API token') }
    await setSetting(TOKEN_SETTING, token.trim())
    return { configured: true }
  }),
  clearMediaCloudToken: () => call(async () => { await deleteSetting(TOKEN_SETTING); return { configured: false } }),
  searchMediaCloudCollections: (q) => call(async () => {
    const token = await configuredToken()
    if (!token) throw new HttpError(428, 'Configure a Media Cloud API token first')
    try { return { collections: await collectionSearch(token, q) } } catch { throw new HttpError(502, 'Media Cloud collection search failed') }
  }),

  // Logs
  getLogs: (projectId, limit = 50) => call(() => store.listLogs(projectId, limit)),
  cancelLog: (projectId, logId) => call(async () => {
    const cancelled = await store.cancelLog(projectId, logId)
    channel?.postMessage({ type: 'cancel', logId })
    if (!cancelled) throw new HttpError(404, 'Log not found or already finished')
    return { ok: true }
  }),

  // Backup (this browser's IndexedDB is the only copy of the data)
  exportBackup: () => call(store.exportBackup),
  importBackup: (data) => call(() => store.importBackup(data)),

  // Rule presets (global, stored locally)
  listPresets: () => call(store.listPresets),
  createPreset: (data) => call(() => store.createPreset(data)),
  deletePreset: (id) => call(async () => { orNotFound('Preset not found')(await store.deletePreset(id)) }),
}
