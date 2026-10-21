// Web archives: desktop records WARC in an isolated Chromium profile. The extension opens the page in a
// background tab, saves it as MHTML with chrome.pageCapture and writes it to Downloads/Canary/.
// ponytail: MHTML only (no WARC), and pages load with this browser's own cookies and logins.
import { put, get } from './db.js'
import { getItem, now, HttpError } from './store.js'

const hasChrome = () => typeof chrome !== 'undefined' && !!chrome.pageCapture
const SETTLE_MS = 2500 // lets late scripts and lazy images render before capture

function loaded(tabId, timeoutMs = 45_000) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve() }
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') done() }
    const timer = setTimeout(done, timeoutMs)
    chrome.tabs.onUpdated.addListener(listener)
  })
}

async function sha256(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function archiveItem(projectId, itemId) {
  if (!hasChrome()) throw new HttpError(501, 'Archiving needs the Canary Chrome extension')
  const item = await getItem(projectId, itemId)
  if (!item) throw new HttpError(404, 'Item not found')
  if (item.status !== 'saved') throw new HttpError(400, 'Only saved items can be archived')
  if (!/^https?:\/\//.test(item.url || '')) throw new HttpError(400, 'Item has no web address to archive')
  const record = { archive_id: crypto.randomUUID(), item_id: itemId, project_id: projectId, archived_at: now(), target_uri: item.url,
    capture_method: 'mhtml', snapshot_path: null, download_id: null, payload_sha256: null, warc_size_bytes: null, resource_count: null, http_status: null, error: null }
  let tab
  try {
    tab = await chrome.tabs.create({ url: item.url, active: false })
    await loaded(tab.id)
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS))
    // pageCapture types the blob text/plain, which makes chrome.downloads rename .mhtml to .txt
    const blob = new Blob([await chrome.pageCapture.saveAsMHTML({ tabId: tab.id })], { type: 'multipart/related' })
    const finalUrl = (await chrome.tabs.get(tab.id)).url
    const url = URL.createObjectURL(blob)
    const filename = `Canary/${projectId.slice(0, 8)}/${record.archive_id}.mhtml`
    record.download_id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false })
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    Object.assign(record, { snapshot_path: filename, payload_sha256: await sha256(blob), warc_size_bytes: blob.size, resource_count: (await blob.text()).split(/\r?\n--/).length - 1,
      ...(finalUrl && finalUrl !== item.url ? { target_uri: finalUrl, requested_uri: item.url } : {}) })
  } catch (error) {
    record.error = error.message || String(error)
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {})
  }
  await put('archives', record)
  return record
}

export async function archiveBatch(projectId, itemIds) {
  const results = []
  // One tab at a time keeps the browser responsive; desktop runs five captures in parallel.
  for (const id of itemIds) {
    try {
      const record = await archiveItem(projectId, id)
      results.push({ item_id: id, success: !record.error, archive_id: record.archive_id, error: record.error })
    } catch (error) {
      results.push({ item_id: id, success: false, error: error.message })
    }
  }
  return { total: results.length, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, results }
}

export async function openSnapshot(projectId, archiveId) {
  const record = await get('archives', archiveId)
  if (!record || record.project_id !== projectId || record.download_id == null) throw new HttpError(404, 'Snapshot not found')
  const [download] = await chrome.downloads.search({ id: record.download_id })
  if (!download?.exists) throw new HttpError(404, 'The snapshot file was moved or deleted from Downloads')
  chrome.downloads.open(record.download_id)
}

export function openArchivesFolder() {
  if (!hasChrome()) throw new HttpError(501, 'Archives are saved by the Canary Chrome extension')
  chrome.downloads.showDefaultFolder()
}
