// Evidence capture for one saved URL: HRC Archiver's browser engine (src/engine, ported from HRC's Chrome build)
// drives a real tab over chrome.debugger, then the files, a hashes list, an RFC 3161 timestamp and a manifest are
// written to Downloads/Pipeline/<id>/. Files stay on this machine; the sheet gets the hashes (see the queue).
import { browserCapture, DownloadNavigation } from '../engine/browser.js'
import { openCaptureWindow, closeWindow } from '../engine/cdp.js'
import { applyVerdict, verifyArchive } from '../engine/quality.js'
import { timestamp } from '../engine/timestamp.js'
import { sha256Hex } from '../engine/util.js'

const CONFIG = { timeout_ms: 30000, viewport_width: 1440, viewport_height: 900 }
const safe = (value) => String(value).replace(/[^\w.-]+/g, '_').slice(0, 80)
const noLog = () => {}

/** The manifest text and its SHA-256 (the sheet's evidence_hash). `files` are { name, sha256, bytes }. Pure. */
export async function buildManifest({ id, url, title, capturedAt, status, issues = [], files, tsa = null, finalUrl = null }) {
  const manifest = {
    id, url, final_url: finalUrl, title: title || '', captured_at: capturedAt, status, issues,
    files: [...files].sort((a, b) => a.name.localeCompare(b.name)),
    timestamp_authority: tsa
  }
  const text = JSON.stringify(manifest, null, 2)
  return { text, sha256: await sha256Hex(text) }
}

// A direct PDF or other file: Chrome downloads it instead of rendering, so keep the file itself.
async function sourceDocument(url) {
  const response = await fetch(url, { credentials: 'include', redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`)
  const type = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase()
  const blob = await response.blob()
  if (!blob.size) throw new Error('the server returned an empty document')
  const name = type === 'application/pdf' ? 'document.pdf' : new URL(response.url || url).pathname.split('/').pop() || 'document.bin'
  return { status: 'simple_http: success', metadata: { final_url: response.url || url }, files: [{ id: 'source_document', name, blob }] }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob)
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId == null) { URL.revokeObjectURL(url); return reject(new Error(chrome.runtime.lastError?.message || 'download refused')) }
      const done = (delta) => {
        if (delta.id !== downloadId || !delta.state) return
        if (delta.state.current === 'in_progress') return
        chrome.downloads.onChanged.removeListener(done)
        URL.revokeObjectURL(url)
        delta.state.current === 'complete' ? resolve() : reject(new Error(`download ${delta.state.current}`))
      }
      chrome.downloads.onChanged.addListener(done)
    })
  })
}

/** Capture one item. Never throws: returns { status: 'done'|'needs_review'|'failed', evidence_hash, evidence_files, timestamp_token?, text?, issues?, error? }. */
export async function archiveUrl({ id, url, title }) {
  let windowId = null
  try {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs can be archived')
    windowId = await openCaptureWindow()
    let result, tab
    try {
      ;({ result, tab } = await browserCapture(url, { config: CONFIG, windowId, log: noLog }))
    } catch (error) {
      if (!(error instanceof DownloadNavigation)) throw error
      result = await sourceDocument(url)
    }
    await tab?.close()
    const metadata = result.metadata
    const verdict = verifyArchive({ status: result.status, metadata, media: result.files.map((f) => ({ filename: f.name, properties: { id: f.id }, _mimetype: f.blob.type })) }, { url })
    applyVerdict(metadata, verdict)

    const folder = `Pipeline/${safe(id)}`
    const out = result.files.map(({ name, blob }) => ({ name, blob }))
    const files = []
    for (const f of out) files.push({ name: f.name, sha256: await sha256Hex(f.blob), bytes: f.blob.size })
    const hashes = [...files].sort((a, b) => a.name.localeCompare(b.name)).map((f) => `${f.sha256}  ${f.name}`).join('\n') + '\n'
    out.push({ name: 'hashes.txt', blob: new Blob([hashes], { type: 'text/plain' }) })
    files.push({ name: 'hashes.txt', sha256: await sha256Hex(hashes), bytes: hashes.length })
    const stamped = await timestamp(hashes)
    if (stamped) {
      const blob = new Blob([stamped.token], { type: 'application/timestamp-reply' })
      out.push({ name: 'hashes.tsr', blob })
      files.push({ name: 'hashes.tsr', sha256: await sha256Hex(blob), bytes: blob.size })
    }
    const status = metadata.capture_quality === 'needs_review' ? 'needs_review' : 'done'
    const manifest = await buildManifest({ id, url, title: title || metadata.title, finalUrl: metadata.final_url, capturedAt: new Date().toISOString(), status, issues: metadata.capture_issues, files, tsa: stamped?.tsa ?? null })
    out.push({ name: 'manifest.json', blob: new Blob([manifest.text], { type: 'application/json' }) })
    for (const f of out) await download(f.blob, `${folder}/${f.name}`)

    return {
      status, evidence_hash: manifest.sha256,
      evidence_files: [...files, { name: 'manifest.json', sha256: manifest.sha256, bytes: manifest.text.length }].map(({ name, sha256 }) => ({ name, sha256 })),
      ...(stamped && { timestamp_token: btoa(String.fromCharCode(...new Uint8Array(stamped.token))) }),
      ...(result.text && { text: result.text }),
      issues: metadata.capture_issues,
      ...(status === 'needs_review' && { error: metadata.capture_issue_summary })
    }
  } catch (error) {
    return { status: 'failed', error: error?.message || String(error) }
  } finally {
    await closeWindow(windowId)
  }
}
