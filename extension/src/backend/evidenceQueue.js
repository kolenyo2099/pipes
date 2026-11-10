// The archive queue: the team sheet is the queue. Items without evidence are locked, captured here (evidence.js),
// written back with hashes, then unlocked. Runs in the app page, one capture at a time. Contract: docs/product-contract.md.
import { bridge as sheet } from './bridge.js'
import { archiveUrl } from './evidence.js'
import { getTeam } from './team.js'

const real = { bridge: sheet, archive: archiveUrl, team: getTeam }

export async function installId() {
  const { pipelineInstallId } = await chrome.storage.local.get('pipelineInstallId')
  if (pipelineInstallId) return pipelineInstallId
  const id = `install-${crypto.randomUUID()}`
  await chrome.storage.local.set({ pipelineInstallId: id })
  return id
}

export const getAutoArchive = async () => !!(await chrome.storage.local.get('pipelineAutoArchive')).pipelineAutoArchive
export const setAutoArchive = (on) => chrome.storage.local.set({ pipelineAutoArchive: !!on })

/** A crashed or closed tab leaves this install's locks behind; release them (no ids = all of ours). */
export async function releaseStaleLocks(deps = real) {
  return deps.bridge('unlock', { locked_by: await installId() })
}

/** Sheet items still to capture, and those that need a human look. */
export async function listQueue(deps = real) {
  const page = async (status, limit = 500) => (await deps.bridge('list', { status, limit })).items || []
  const [pending, review, failed, done] = await Promise.all([page('pending'), page('needs_review'), page('failed'), page('done', 100)])
  return { pending: pending.filter((item) => !item.evidence_hash), review, failed, done }
}

/** What was saved besides the page itself, from the stored result: "2 videos (0:42, 1280x720), 5 images, 1 caption file", or '' when only the page. */
export function mediaLine(item) {
  const list = (item.result_metadata || {}).media || []
  const of = (re) => list.filter((m) => re.test(m.name))
  const videos = of(/\.(mp4|webm|mkv|mov|ts|m4v|ogv|mp3|m4a|aac|ogg|opus|wav|weba)$/i), images = of(/^media_image_/), captions = of(/^subtitles-/)
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
  const parts = []
  if (videos.length) parts.push(`${videos.length} video/audio (${videos.map((v) => [v.duration && clock(v.duration), v.width && `${v.width}x${v.height}`, v.method].filter(Boolean).join(' ')).join('; ')})`)
  if (images.length) parts.push(`${images.length} image${images.length > 1 ? 's' : ''}`)
  if (captions.length) parts.push(`${captions.length} caption file${captions.length > 1 ? 's' : ''}`)
  return parts.join(', ')
}

/** Why an item needs attention: the stored error or the quality issues. */
export const reasonOf = (item) => {
  const meta = item.result_metadata || {}
  return meta.error || (meta.capture_issues || []).map((i) => i.message).join('; ') || ''
}

/**
 * Lock, capture, write back, unlock. Never throws: returns the capture result plus { skipped } when someone else holds it.
 * With `tabId` the capture runs on that already-open tab (manual capture of a bot-walled or logged-in page) and the
 * stored result_metadata says capture_mode: 'manual'; the lock/update/putText/unlock flow is the same.
 */
export async function archiveOne(item, deps = real, { tabId } = {}) {
  const by = await installId()
  const { bridge } = deps
  const lock = await bridge('lock', { ids: [item.id], locked_by: by }).catch((error) => ({ error }))
  if (lock.error) return { status: 'failed', error: lock.error.message }
  if (!lock.count) return { skipped: true, status: 'skipped', error: 'Locked by someone else' }
  let result
  try {
    result = await deps.archive({ id: item.id, url: item.url, title: item.title, ...(tabId != null && { tabId }) })
    const update = { id: item.id, status: result.status, result_metadata: { capture_issues: result.issues || [], ...(result.error && { error: result.error }), ...(result.media?.length && { media: result.media }), ...((tabId != null || result.capture_mode) && { capture_mode: 'manual' }), ...(result.wayback_url && { wayback_url: result.wayback_url }), ...(result.substitution && { substitution: result.substitution }) } }
    // The page's own publication date fills the sheet column only when nobody set one.
    if (result.published_at && !item.published_at) update.fields = { 'Published At': result.published_at }
    if (result.status !== 'failed') Object.assign(update, {
      evidence_hash: result.evidence_hash, evidence_files: result.evidence_files, captured_by: (await deps.team())?.name || '',
      captured_at: new Date().toISOString(), ...(result.timestamp_token && { timestamp_token: result.timestamp_token })
    })
    await bridge('updateMany', { updates: [update] })
    // Page text is a bonus: a failed upload must not undo a good capture.
    if (result.text && !item.has_text) await bridge('putText', { id: item.id, text: result.text }).catch(() => {})
  } catch (error) {
    result = { status: 'failed', error: error?.message || String(error) }
    await bridge('updateMany', { updates: [{ id: item.id, status: 'failed', result_metadata: { error: result.error, ...(tabId != null && { capture_mode: 'manual' }) } }] }).catch(() => {})
  } finally {
    await bridge('unlock', { ids: [item.id], locked_by: by }).catch(() => {})
  }
  return result
}

/** Items in order, one at a time. `onItem(item, 'start'|result)` reports progress; `shouldStop()` ends the run early. */
export async function archiveAll(items, { deps = real, onItem = () => {}, shouldStop = () => false } = {}) {
  for (const item of items) {
    if (shouldStop()) break
    onItem(item, 'start')
    onItem(item, await archiveOne(item, deps))
  }
}

// ── Manual capture ───────────────────────────────────────────────────────────
// A bot-walled or logged-in page cannot be captured in the engine's own window: the user opens it in a normal tab,
// gets past the wall, and the capture then runs on that very tab. Tabs waiting for that are listed in session storage
// (shared with the service worker's "Archive this page to team sheet" menu), keyed by tab id.
const TABS = 'pipelineManualTabs'
const storedTabs = async () => (await chrome.storage.session.get(TABS))[TABS] || []

export async function registerManualTab({ tabId, url, title }) {
  const rest = (await storedTabs()).filter((e) => e.tabId !== tabId)
  await chrome.storage.session.set({ [TABS]: [...rest, { tabId, url, title: title || '' }] })
}

export async function forgetManualTab(tabId) {
  await chrome.storage.session.set({ [TABS]: (await storedTabs()).filter((e) => e.tabId !== tabId) })
}

/** Open the item's URL in a normal, focused tab and remember it for "Capture this tab now". */
export async function openForManualCapture(item) {
  const tab = await chrome.tabs.create({ url: item.url, active: true })
  await registerManualTab({ tabId: tab.id, url: item.url, title: item.title })
  return tab.id
}

/** Registered tabs that are still open, each with the queue item (pending / needs review / failed) it belongs to, if any. */
export async function listManualTabs(queue) {
  const all = await storedTabs()
  const open = []
  for (const entry of all) {
    const tab = await chrome.tabs.get(entry.tabId).catch(() => null)
    if (tab) open.push({ ...entry, currentUrl: tab.url || entry.url })
  }
  if (open.length !== all.length) await chrome.storage.session.set({ [TABS]: open.map(({ currentUrl, ...entry }) => entry) })
  const items = [...queue.pending, ...queue.review, ...queue.failed]
  return open.map((entry) => ({ ...entry, item: items.find((i) => i.url === entry.url) || null }))
}

/** Capture the entry's tab as it stands and write it back through the usual flow. */
export async function archiveManual(entry, deps = real) {
  const result = await archiveOne(entry.item, deps, { tabId: entry.tabId })
  if (result.status !== 'failed' && !result.skipped) await forgetManualTab(entry.tabId)
  return result
}
