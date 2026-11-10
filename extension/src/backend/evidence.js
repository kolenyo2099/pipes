// Evidence capture for one saved URL: HRC Archiver's browser engine (src/engine, ported from HRC's Chrome build)
// drives a real tab over chrome.debugger, then the files, a hashes list, an RFC 3161 timestamp and a manifest are
// written to Downloads/Pipeline/<id>/. Files stay on this machine; the sheet gets the hashes (see the queue).
import { browserCapture, browserCaptureTab, DownloadNavigation } from '../engine/browser.js'
import { openCaptureWindow, closeWindow } from '../engine/cdp.js'
import { applyVerdict, expectsMediaDownload, verifyArchive } from '../engine/quality.js'
import { DEFAULT_MEDIA_CONFIG, embedUrls, hasPlayerHint, imageFiles, mediaLayer, playsMedia, probeMedia, removeRecordings, subtitleFiles } from '../engine/media-layer.js'
import { VIDEO_INDICATOR_EXPRESSION } from '../engine/media/page-media.js'
import { timestamp } from '../engine/timestamp.js'
import { enrich, fallbackCapture } from '../engine/enrich.js'
import { sha256Hex } from '../engine/util.js'

const CONFIG = { timeout_ms: 30000, viewport_width: 1440, viewport_height: 900, ...DEFAULT_MEDIA_CONFIG }
const safe = (value) => String(value).replace(/[^\w.-]+/g, '_').slice(0, 80)
// Capture options the Archive view edits. Wayback is never implicit: both uses are off until someone turns them on.
const OPTION_DEFAULTS = { fallback: true, wayback: false, fallbackWayback: false }
export const getArchiveOptions = async () => ({ ...OPTION_DEFAULTS, ...(await globalThis.chrome?.storage?.local.get('pipelineArchiveOptions'))?.pipelineArchiveOptions })
export const setArchiveOptions = (options) => chrome.storage.local.set({ pipelineArchiveOptions: options })
// Verdicts that mean the live page itself was not captured (blocked, error page, blank), so a substitute is worth trying.
const BLOCKED = /^(http_[45]|error_page|blank_render|navigation_error|page_not_captured)/

const noLog = ({ level, message }) => console.debug('[archive]', level, message)

/** The manifest text and its SHA-256 (the sheet's evidence_hash). `files` are { name, sha256, bytes }. Pure. */
export async function buildManifest({ id, url, title, capturedAt, status, issues = [], files, tsa = null, finalUrl = null, captureMode = null, media = [], extra = {} }) {
  const manifest = {
    id, url, final_url: finalUrl, title: title || '', captured_at: capturedAt, status, issues,
    files: [...files].sort((a, b) => a.name.localeCompare(b.name)),
    timestamp_authority: tsa,
    ...(captureMode && { capture_mode: captureMode }),
    ...(media.length && { media }),
    ...extra
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

/** What the Archive view shows per item: one short entry per saved audio/video/image/caption file. */
export const mediaSummary = (list = []) => list.map(({ name, capture_method, duration, width, height }) => ({ name, method: capture_method, ...(duration && { duration }), ...(width && height && { width, height }) }))

// Write media files next to the page evidence, one by one: a file the disk refuses is dropped and recorded, never fatal.
async function saveMedia(id, files, result) {
  const metadata = result.metadata
  for (const file of files) {
    try {
      await download(file.blob, `Pipeline/${safe(id)}/${file.name}`)
      result.files.push(file)
      ;(metadata.capture_media ||= []).push({ name: file.name, ...file.properties })
    } catch (error) {
      metadata.media_extraction_error = `${file.name} could not be saved: ${error.message}`
    }
  }
}

// Audio/video, images and captions the page carries, saved like every other file. A failed grab never fails the
// page capture: it is recorded (media_extraction_error → a media_extraction_failed review issue) and the page
// evidence stands.
// The page's video sits in another site's player frame: open that player as its own page and save what it plays.
// ponytail: at most two embeds per page, each a full extra page load; raise the cap if pages with more players matter.
async function embeddedMedia(id, dom, pageUrl, result, { windowId, temporary }) {
  let saved = false
  for (const src of embedUrls(dom, pageUrl).slice(0, 2)) {
    let tab
    try {
      const sub = await browserCapture(src, { config: CONFIG, windowId, recordMedia: CONFIG.record_playback && expectsMediaDownload(src), log: noLog })
      tab = sub.tab
      const subDom = await sub.result.files.find((f) => f.id === 'rendered_dom')?.blob.text()
      const found = await mediaLayer(src, { tab, capture: { metadata: sub.result.metadata, dom: subDom }, config: CONFIG, log: noLog })
      temporary.push(...found.temporary)
      const taken = new Set(result.files.map((f) => f.name))
      for (const file of found.files) {
        if (taken.has(file.name)) file.name = `embed-${file.name}`
        file.properties = { ...(await probeMedia(file.blob).catch(() => null)), ...file.properties, embedded_from: src }
      }
      await saveMedia(id, found.files, result)
      saved ||= found.files.length > 0
    } catch (error) {
      temporary.push(...(error.temporary || []))
    } finally {
      await tab?.close()
    }
  }
  return saved
}

async function addMedia(id, url, result, tab, { manual, temporary, windowId }) {
  if (!CONFIG.media) return
  const metadata = result.metadata
  const sources = metadata.page_media_sources || []
  const indicator = sources.length ? false : await tab.evaluate(VIDEO_INDICATOR_EXPRESSION).catch(() => false)
  const dom = await result.files.find((f) => f.id === 'rendered_dom')?.blob.text()
  if (playsMedia({ url, sources, indicator, hint: hasPlayerHint(dom) })) {
    try {
      // A manual capture never reloads the user's tab, so it cannot install the recorder: no playback recording.
      const config = { ...CONFIG, record_playback: CONFIG.record_playback && !manual }
      const found = await mediaLayer(url, { tab, capture: { metadata, dom }, config, log: noLog })
      temporary.push(...found.temporary)
      for (const file of found.files) file.properties = { ...(await probeMedia(file.blob).catch(() => null)), ...file.properties }
      await saveMedia(id, found.files, result)
      if (found.error) metadata.media_extraction_error = found.error
    } catch (error) {
      temporary.push(...(error.temporary || []))
      const fromEmbed = windowId != null && await embeddedMedia(id, dom, url, result, { windowId, temporary })
      // Nothing indicated media on this page, or its embedded player was saved: not a failure.
      if (error.message !== 'No media found' && !fromEmbed) metadata.media_extraction_error = error.message
    }
  } else if (windowId != null && embedUrls(dom, url).length && !(await embeddedMedia(id, dom, url, result, { windowId, temporary }))) {
    metadata.media_extraction_error = 'the video plays inside an embedded frame from another site and could not be saved'
  }
  // Images and captions are best effort: a failure is noted in the log, not an issue.
  try {
    const images = await imageFiles(result.image_sources)
    await saveMedia(id, images.files, result)
    if (images.failed.length) metadata.image_errors = images.failed
    await saveMedia(id, await subtitleFiles(result.track_sources), result)
  } catch (error) {
    metadata.image_errors = [error.message]
  }
  if (metadata.media_extraction_error) (metadata.capture_layers ||= []).push({ name: 'media_layer', role: 'media', error: metadata.media_extraction_error })
  metadata.capture_artifacts = result.files.map((f) => f.name)
}

/**
 * Capture one item. Never throws: returns { status: 'done'|'needs_review'|'failed', evidence_hash, evidence_files, timestamp_token?, text?, issues?, error? }.
 * With `tabId` it captures that already-open tab as it stands (manual capture: the user got past a bot wall or logged in)
 * instead of opening the URL in a new window; the result then carries capture_mode: 'manual'.
 */
export async function archiveUrl(job) {
  const state = {}
  let timer
  // A wedged tab (a renderer that never answers CDP) must not stall the whole queue: give up, close the window.
  // ponytail: one wall-clock cap for page + media; the 15-minute playback recording is the longest legitimate step.
  const limit = new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'failed', error: 'Capture timed out and was abandoned' }), (CONFIG.max_record_minutes + 5) * 60_000) })
  const result = await Promise.race([capture(job, state), limit])
  clearTimeout(timer)
  if (result.error === 'Capture timed out and was abandoned') await closeWindow(state.windowId)
  return result
}

async function capture({ id, url, title, tabId }, state) {
  let windowId = null
  const temporary = []
  const manual = tabId != null
  try {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs can be archived')
    const options = await getArchiveOptions()
    let result, tab, restore, liveError
    if (manual) {
      ;({ result, tab, restore } = await browserCaptureTab(tabId, url, { config: CONFIG, log: noLog }))
    } else {
      windowId = state.windowId = await openCaptureWindow()
      try {
        ;({ result, tab } = await browserCapture(url, { config: CONFIG, windowId, recordMedia: CONFIG.media && CONFIG.record_playback && expectsMediaDownload(url), log: noLog }))
      } catch (error) {
        if (error instanceof DownloadNavigation) result = await sourceDocument(url)
        else if (options.fallback) liveError = error // maybe an alternate version can still be saved
        else throw error
      }
    }
    result ||= { status: '', metadata: { navigation_error: liveError.message }, files: [] }
    try {
      if (tab) await addMedia(id, url, result, tab, { manual, temporary, windowId })
    } finally {
      await restore?.()
      await tab?.close()
    }
    const metadata = result.metadata
    const verdict = verifyArchive({ status: result.status, metadata, media: result.files.map((f) => ({ filename: f.name, properties: { id: f.id }, _mimetype: f.mimetype || f.blob.type })) }, { url })
    applyVerdict(metadata, verdict)

    // The live page was blocked or broken: try an alternate version. It is saved next to whatever was captured,
    // named substitute-*, with its provenance, and the item always goes to review: never presented as the live page.
    if (!manual && options.fallback && verdict.some((i) => BLOCKED.test(i.code))) {
      const found = await fallbackCapture(url, { reason: metadata.capture_issue_summary, wayback: options.fallbackWayback })
      if (found) {
        result.files.push(...found.files)
        result.text ||= found.text
        Object.assign(metadata, { substituted: true, substitution: found.metadata.substitution })
        const { kind, source_url } = found.metadata.substitution
        applyVerdict(metadata, [...verdict, { code: 'substituted_content', message: `The live page was not captured; a ${kind} copy from ${source_url} is saved as a substitute` }])
      }
    }
    if (liveError && !metadata.substituted) throw liveError

    // Publication dates from the captured DOM, and the optional Wayback save. Best effort: never fails the capture.
    const extra = await enrich({ url, result, options: { wayback: options.wayback } }).catch(() => null)
    if (extra) {
      result.files.push(...extra.files)
      Object.assign(metadata, extra.metadata)
    }

    const folder = `Pipeline/${safe(id)}`
    const written = new Set(result.files.filter((f) => f.properties).map((f) => f.name)) // media: already on disk
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
    const manifest = await buildManifest({ id, url, title: title || metadata.title, finalUrl: metadata.final_url, capturedAt: new Date().toISOString(), status, issues: metadata.capture_issues, files, tsa: stamped?.tsa ?? null, captureMode: manual ? 'manual' : null, media: metadata.capture_media,
      extra: { ...(metadata.source_dates && { source_dates: metadata.source_dates }), ...(metadata.wayback && { wayback: metadata.wayback }), ...(metadata.substitution && { substitution: metadata.substitution }) } })
    out.push({ name: 'manifest.json', blob: new Blob([manifest.text], { type: 'application/json' }) })
    for (const f of out) if (!written.has(f.name)) await download(f.blob, `${folder}/${f.name}`)

    return {
      status, evidence_hash: manifest.sha256,
      evidence_files: [...files, { name: 'manifest.json', sha256: manifest.sha256, bytes: manifest.text.length }].map(({ name, sha256 }) => ({ name, sha256 })),
      ...(stamped && { timestamp_token: btoa(String.fromCharCode(...new Uint8Array(stamped.token))) }),
      ...(result.text && { text: result.text }),
      issues: metadata.capture_issues,
      ...(manual && { capture_mode: 'manual' }),
      media: mediaSummary(metadata.capture_media),
      ...(extra?.published_at && { published_at: extra.published_at }),
      ...(metadata.wayback?.wayback_url && { wayback_url: metadata.wayback.wayback_url }),
      ...(metadata.substitution && { substitution: { kind: metadata.substitution.kind, source_url: metadata.substitution.source_url } }),
      ...(status === 'needs_review' && { error: metadata.capture_issue_summary })
    }
  } catch (error) {
    return { status: 'failed', error: error?.message || String(error) }
  } finally {
    await removeRecordings(temporary)
    await closeWindow(windowId)
  }
}
