// Media layer: what the desktop app gets from yt-dlp, done in the browser with chrome-media-capture's libraries
// (copied to ./media/). In order: site extractors (X, Instagram), the file the page's own <video>/<audio> points at,
// the HLS/DASH streams the page requested, and for players whose streams cannot be refetched (YouTube) recording
// what the player appends. Everything is saved byte for byte as served; nothing is re-encoded. Ported from
// chrome-app/src/engine/media-layer.js; images are not saved.
import { classifyUrl } from './media/classify.js'
import { downloadPlaylist, hlsExtension, referencedPlaylists, resolveTracks } from './media/hls.js'
import { dashExtension, parseMpd, trackItems } from './media/dash.js'
import { downloadItems, fetchText } from './media/net.js'
import * as sites from './media/sites.js'
import {
  drainRecordingInPage, instagramInfoInPage, pauseInPage, pollPlaybackInPage,
  recordingSummaryInPage, startPlaybackInPage, stopRecordingInPage
} from './media/page.js'
import { bestQualityImageUrl, isRelevantImageUrl, isStreamingUrl, VIDEO_INDICATOR_EXPRESSION, MEDIA_SOURCE_EXPRESSION } from './media/page-media.js'
import { expectsMediaDownload } from './quality.js'
import { sleep, uuid } from './util.js'
import { base64ToBlob } from './cdp.js'
import { baseMime, extensionForMime, media, MediaFiles } from './media-model.js'

// ponytail: progressive files go through response.blob(), which Chrome backs with disk, so one file may be up to
// 1.5 GB; HLS/DASH streams are capped at 500 MB (media/net.js) because their segments are held in memory until
// joined; an MSE recording streams to OPFS with no cap but the 15-minute limit. At most 8 progressive files per page.
const MAX_MEDIA_BYTES = 1_500_000_000
const MAX_MEDIA_FILES = 8
const MAX_IMAGE_FILES = 24
const HLS_MIME = { '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.mp3': 'audio/mpeg' }

// Signs that a page carries a media player. A static (scripts-off) capture never runs the player.
const PLAYER_HINT = /<video|<audio|jwplayer|video-js|videojs|brightcove|hls(\.min)?\.js|dash(\.all)?(\.min)?\.js|shaka-player|\.m3u8|\.mpd\b/i
const SETTLE_MS = 8000
// A server that stalls mid-file must not wedge the queue: whole-file fetches (headers and body) get this long.
const MEDIA_FETCH_MS = 10 * 60_000

export const DEFAULT_MEDIA_CONFIG = { media: true, record_playback: true, record_rate: 16, max_record_minutes: 15 }

/** Does this page play media? Decides whether the media layer runs at all. Pure given the probe results. */
export const playsMedia = ({ url, sources = [], indicator = false, hint = false }) => sources.length > 0 || Boolean(indicator) || Boolean(hint) || expectsMediaDownload(url)

export const hasPlayerHint = (dom) => PLAYER_HINT.test(dom || '')
// ponytail: a player inside a cross-origin iframe (YouTube/Vimeo embeds, newsroom players) is a separate frame the
// debugger session does not attach to; saving it would need Target.setAutoAttach plus a recording per frame.
const EMBED = /<iframe[^>]+src="[^"]*(youtube|youtu\.be|vimeo|dailymotion|jwplatform|brightcove|embeds\.|player\.)/i

/** Fetch what the rendered page pointed at, with the live session. */
export async function downloadSources(sources, { limit = MAX_MEDIA_FILES } = {}) {
  const downloaded = []
  let uncaptured = false
  const seen = new Set()
  for (const url of sources) {
    if (!/^https?:\/\//.test(url) || seen.has(url)) continue
    seen.add(url)
    if (downloaded.length >= limit) { uncaptured = true; break }
    try {
      const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(MEDIA_FETCH_MS) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const contentType = baseMime(response.headers.get('Content-Type'))
      // HLS/DASH: the stream step's job, not a plain GET.
      if (isStreamingUrl(url, contentType)) { uncaptured = true; continue }
      if (!/^(video|audio)\//.test(contentType)) continue
      if (Number(response.headers.get('Content-Length') || 0) > MAX_MEDIA_BYTES) { uncaptured = true; continue }
      const blob = await response.blob()
      if (blob.size > MAX_MEDIA_BYTES) { uncaptured = true; continue }
      downloaded.push({ blob, mimetype: contentType, source: url })
    } catch {
      uncaptured = true
    }
  }
  return { downloaded, uncaptured }
}

// Players that build their <video> only on first play (JW Player, Video.js, Brightcove, newsroom plugins) request
// nothing until someone presses play. Press every play affordance we know, muted; what the player then requests
// (a file, an HLS/DASH manifest) is found by the steps after this.
const ACTIVATE = `(() => {
  const selectors = ['.jw-icon-display', '.jw-display-icon-container', '.vjs-big-play-button', '.plyr__control--overlaid',
    '[data-testid="playButton"]', '[aria-label="Play"]', '[aria-label="Play video"]', 'button[class*="play" i]', '[class*="play-button" i]', '[class*="PlayButton"]'];
  for (const selector of selectors) for (const el of document.querySelectorAll(selector)) { try { el.scrollIntoView({ block: 'center' }); el.click(); } catch {} }
  document.querySelectorAll('video, audio').forEach((el) => { el.muted = true; el.play?.().catch(() => {}); });
})()`

/** Start the page's players so they request their media. `reload`: the capture ran without scripts, load it again with them. */
async function wakePlayers(tab, log, { reload }) {
  log({ level: 'info', message: reload ? "Reloading with JavaScript so the page's media player loads its streams" : 'Starting the page media players' })
  await tab.send('Emulation.setScriptExecutionDisabled', { value: false })
  if (reload) {
    await tab.reload(30_000)
    await tab.waitForFlag('load', 'Page.loadEventFired', SETTLE_MS).catch(() => {})
    await tab.networkIdle(SETTLE_MS).catch(() => {})
  }
  await tab.evaluate(ACTIVATE).catch(() => {})
  await sleep(4000)
  await tab.networkIdle(SETTLE_MS).catch(() => {})
  await tab.evaluate(`document.querySelectorAll('video, audio').forEach((el) => el.pause())`).catch(() => {})
  return (await tab.evaluate(MEDIA_SOURCE_EXPRESSION).catch(() => [])) ?? []
}

async function siteMedia(url, tab) {
  const id = sites.tweetId(url)
  if (id) {
    const tweet = JSON.parse((await fetchText(sites.syndicationUrl(id))).text)
    return { method: 'site:x-syndication', items: sites.xMedia(tweet) }
  }
  // A public Telegram post: the page itself is a widget shell; the post's own embed carries the <video>.
  const post = /^https?:\/\/t\.me\/(?:s\/)?([A-Za-z0-9_]+)\/(\d+)/.exec(url)
  if (post) {
    const html = (await fetchText(`https://t.me/${post[1]}/${post[2]}?embed=1&mode=tme`)).text
    const src = /<video[^>]+src="([^"]+)"/.exec(html)?.[1]
    return { method: 'site:telegram-embed', items: src ? [{ kind: 'video', url: src.replace(/&amp;/g, '&') }] : [] }
  }
  const shortcode = sites.instagramShortcode(url)
  if (shortcode && tab) {
    const info = await tab.call(instagramInfoInPage, sites.instagramMediaId(shortcode))
    if (info?.error) throw new Error(info.error)
    return { method: 'site:instagram-api', items: sites.instagramMedia(info) }
  }
  return null
}

// JW Player (many newsrooms): the page plays one rendition but its media record lists them all. Take the tallest mp4.
async function jwBest(tab, pageSources) {
  const timing = tab ? ((await tab.evaluate(`performance.getEntriesByType('resource').map((e) => e.name)`).catch(() => [])) ?? []) : []
  const requested = [...Object.values(tab?.network.requests ?? {}).map((e) => e.request?.url), ...timing, ...pageSources].filter(Boolean)
  const id = requested.map((u) => /cdn\.jwplayer\.com\/(?:videos|manifests|v2\/media)\/([A-Za-z0-9]{8})/.exec(u)?.[1]).find(Boolean)
  if (!id) return null
  const sources = JSON.parse((await fetchText(`https://cdn.jwplayer.com/v2/media/${id}`)).text).playlist?.[0]?.sources ?? []
  const best = sources.filter((x) => x.type === 'video/mp4' && x.file).sort((a, b) => (b.height || 0) - (a.height || 0))[0]
  return best ? { url: best.file, height: best.height, width: best.width } : null
}

async function streams(tab, pageSources, files, log) {
  const timing = tab ? ((await tab.evaluate(`performance.getEntriesByType('resource').map((e) => e.name)`).catch(() => [])) ?? []) : []
  const requested = [
    ...Object.values(tab?.network.requests ?? {}).map((entry) => entry.request?.url),
    ...timing,
    ...(pageSources ?? [])
  ].filter(Boolean)
  const hls = [...new Set(requested.filter((u) => classifyUrl(u) === 'hls'))]
  const dash = [...new Set(requested.filter((u) => classifyUrl(u) === 'dash'))]

  const manifests = []
  for (const url of hls) {
    try {
      manifests.push({ ...(await fetchText(url)), requested: url })
    } catch (error) {
      log({ level: 'warning', message: `HLS manifest ${url}: ${error.message}` })
    }
  }
  const referenced = new Set(manifests.flatMap(referencedPlaylists))
  for (const manifest of manifests) {
    if (referenced.has(manifest.url) || referenced.has(manifest.requested)) continue
    for (const track of await resolveTracks(manifest, fetchText)) {
      const parts = await downloadPlaylist(track.playlist)
      const ext = hlsExtension(track.playlist, track.kind)
      const mime = HLS_MIME[ext] ?? 'video/mp2t'
      files.add(mime.startsWith('audio/') ? 'audio' : 'video', `hls-${track.kind}`, new Blob(parts, { type: mime }), mime, {
        capture_method: 'hls', source_urls: [manifest.url, track.url], segments: track.playlist.segments.length, live: track.playlist.live, ...resolution(track.resolution)
      }, ext)
    }
  }
  for (const url of dash) {
    const manifest = await fetchText(url)
    const mpd = parseMpd(manifest.text, manifest.url)
    if (mpd.drm && !mpd.tracks.length) throw new Error('DASH stream is DRM-protected')
    for (const track of mpd.tracks) {
      const items = trackItems(track)
      const parts = await downloadItems(items)
      files.add(track.kind, `dash-${track.kind}`, new Blob(parts, { type: track.mimeType }), track.mimeType, {
        capture_method: 'dash', source_urls: [manifest.url], segments: items.length, width: track.width ?? undefined, height: track.height ?? undefined
      }, dashExtension(track))
    }
  }
}

const RECORDINGS_DIR = 'recordings'
const recordingsDir = async (create) => (await navigator.storage.getDirectory()).getDirectoryHandle(RECORDINGS_DIR, { create })

export async function removeRecordings(names) {
  const dir = await recordingsDir(false).catch(() => null)
  for (const name of names) await dir?.removeEntry(name).catch(() => {})
}

/** Startup: recordings left by a page closed mid-job. */
export async function clearRecordings() {
  await (await navigator.storage.getDirectory()).removeEntry(RECORDINGS_DIR, { recursive: true }).catch(() => {})
}

/**
 * Writes what the player appends to files in the extension's private storage while it plays, so neither the page
 * nor the engine holds a whole video in memory; the archive gets disk-backed Files. Each run (one encoding, a
 * quality switch starts the next) is one file.
 */
class RecordingSink {
  constructor() {
    this.targets = new Map()
    this.summary = null
  }

  async drain(tab) {
    this.summary = await tab.call(recordingSummaryInPage)
    for (const [b, buffer] of (this.summary?.buffers ?? []).entries()) {
      for (const r of buffer.runs.keys()) {
        for (let more = true; more;) {
          const chunk = await tab.call(drainRecordingInPage, b, r)
          more = chunk.more
          if (chunk.data) await (await this.target(b, r, buffer.mimeType)).writable.write(base64ToBlob(chunk.data, ''))
        }
      }
    }
  }

  async target(b, r, mseMimeType) {
    const key = `${b}:${r}`
    if (!this.targets.has(key)) {
      const name = `${uuid()}.part`
      const handle = await (await recordingsDir(true)).getFileHandle(name, { create: true })
      this.targets.set(key, { b, r, name, handle, mseMimeType, writable: await handle.createWritable() })
    }
    return this.targets.get(key)
  }

  /** Close every file and return the playable ones (an init plus media), in buffer/run order. */
  async finish() {
    const kept = []
    for (const target of [...this.targets.values()].sort((x, y) => x.b - y.b || x.r - y.r)) {
      await target.writable.close()
      if ((this.summary?.buffers[target.b]?.runs[target.r]?.chunks ?? 0) < 2) await removeRecordings([target.name])
      else kept.push({ ...target, file: await target.handle.getFile() })
    }
    return kept
  }

  get names() {
    return [...this.targets.values()].map((t) => t.name)
  }
}

// A YouTube pre-roll ad plays in the same <video>; recording it would end at the ad's length. Let it run muted
// (skipping when allowed) before starting.
// ponytail: untested against a real ad (test profiles get none); YouTube-only selectors.
const AD_WAIT = `(() => {
  const ad = document.querySelector('#movie_player.ad-showing');
  if (ad) { const v = document.querySelector('video'); if (v) { v.muted = true; v.play?.().catch(() => {}); }
    document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern')?.click(); }
  return Boolean(ad);
})()`

/** Play the main video to the end and keep what the player appended. */
async function recordPlayback(url, tab, config, files, log, scriptsRan, temporary) {
  const hooked = () => tab.evaluate('Boolean(window.__hrcMse)').catch(() => false)
  await tab.send('Emulation.setScriptExecutionDisabled', { value: false })
  if (!scriptsRan || !(await hooked())) {
    // Captured with scripts off (the page looked complete without them): load it again with scripts. The recorder
    // is injected over DevTools, so it can exist even though the page's own player never ran.
    log({ level: 'info', message: 'Reloading with JavaScript to record the player' })
    await tab.reload(30_000)
    await tab.waitForFlag('load', 'Page.loadEventFired', SETTLE_MS).catch(() => {})
    if (!(await hooked())) return false
  }
  for (let waited = 0; waited < 15_000 && !(await tab.evaluate("Boolean(document.querySelector('video'))").catch(() => false)); waited += 500) {
    await sleep(500)
  }
  for (let waited = 0; waited < 120_000 && (await tab.evaluate(AD_WAIT).catch(() => false)); waited += 1000) {
    if (waited === 0) log({ level: 'info', message: 'Waiting for a pre-roll ad to finish' })
    await sleep(1000)
  }
  const started = await tab.call(startPlaybackInPage, config.record_rate)
  if (!started) return false
  log({ level: 'info', message: `Recording playback at ${config.record_rate}x${started.quality ? ` (quality ${started.quality})` : ''}` })
  const sink = new RecordingSink()
  let saveError = null
  const deadline = Date.now() + config.max_record_minutes * 60_000
  let lastTime = -1
  let reached = 0 // how far the player had fetched, which runs ahead of playback
  let length = started.duration
  let stalledSince = Date.now()
  while (Date.now() < deadline) {
    await sleep(2000)
    const state = await tab.call(pollPlaybackInPage).catch(() => null)
    if (!state) break
    try {
      await sink.drain(tab)
    } catch (error) {
      saveError = error
      log({ level: 'warning', message: `Could not save the recording (${error.message}); keeping what was written` })
      break
    }
    // Finished: ended, reached the length it started with, or the player moved on (time jumped back, or a different
    // video loaded — YouTube autoplays). A player the site tears down reports NaN; keep the last real length.
    if (!Number.isFinite(started.duration) && Number.isFinite(state.duration)) length = state.duration
    const movedOn = state.time + 1 < lastTime || (Number.isFinite(started.duration) && Math.abs(state.duration - started.duration) > 1)
    if (!movedOn) reached = Math.max(reached, state.time, state.buffered)
    if (state.ended || state.time >= length - 0.5 || movedOn) {
      await tab.call(pauseInPage).catch(() => {})
      break
    }
    if (state.time > lastTime) {
      lastTime = state.time
      stalledSince = Date.now()
    } else if (Date.now() - stalledSince > 60_000) {
      log({ level: 'warning', message: 'Playback stalled for a minute; keeping what was recorded' })
      break
    }
  }
  if (Date.now() >= deadline) log({ level: 'warning', message: `Recording stopped at the ${config.max_record_minutes}-minute limit` })
  await tab.call(pauseInPage).catch(() => {})
  if (!saveError) await sink.drain(tab).catch((error) => (saveError = error))
  await tab.call(stopRecordingInPage).catch(() => {})
  temporary.push(...sink.names)
  for (const target of await sink.finish()) {
    const mime = baseMime(target.mseMimeType)
    files.add(mime.startsWith('audio/') ? 'audio' : 'video', mime.startsWith('audio/') ? 'recorded-audio' : 'recorded-video', target.file, mime, {
      capture_method: 'mse-recording', source_urls: [url], mse_mime_type: target.mseMimeType, truncated: Boolean(sink.summary?.truncated || saveError)
    })
  }
  if (saveError) throw new Error(`the recording could not be saved completely: ${saveError.message}`)
  // Anything short of the full length is evidence of a failure, not a capture.
  if (!files.hasAV) throw new Error('playback recording saved no audio/video')
  if (Number.isFinite(length) && reached < length - 2) {
    throw new Error(`playback recording stopped at ${Math.round(reached)}s of ${Math.round(length)}s (the site ended playback); the saved media is partial`)
  }
  return true
}

/**
 * Save the audio/video of the page in `tab`. `capture` is what the page capture knew: { metadata, dom }. Returns
 * { files, error, temporary }: `error` is set when something was saved but not everything; throws when nothing was
 * saved although media was detected. `temporary` are OPFS recording files to delete once the files are stored.
 */
export async function mediaLayer(url, { tab, capture, config, log }) {
  const files = new MediaFiles()
  const errors = []
  const temporary = []
  const metadata = capture?.metadata ?? {}

  let site = null
  try {
    site = await siteMedia(url, tab)
  } catch (error) {
    errors.push(`site extractor: ${error.message}`)
  }
  for (const item of site?.items ?? []) {
    if (item.kind !== 'video') continue
    try {
      const response = await fetch(item.url, { credentials: 'include', signal: AbortSignal.timeout(MEDIA_FETCH_MS) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (Number(response.headers.get('Content-Length') || 0) > MAX_MEDIA_BYTES) throw new Error('larger than the 1.5 GB limit')
      files.add('video', 'site-video', await response.blob(), baseMime(response.headers.get('Content-Type')) || 'video/mp4', { capture_method: site.method, source_urls: [item.url] })
    } catch (error) {
      errors.push(`${item.url}: ${error.message}`)
    }
  }

  let pageSources = metadata.page_media_sources ?? []
  let scriptsRan = metadata.javascript_enabled !== false
  // A site extractor gives the original file; the player's own file of the same clip would only duplicate it.
  if (!files.hasAV && pageSources.length) {
    const { downloaded, uncaptured } = await downloadSources(pageSources)
    for (const clip of downloaded) {
      files.add(clip.mimetype.startsWith('audio/') ? 'audio' : 'video', 'embedded-media', clip.blob, clip.mimetype, { capture_method: 'direct', source_urls: [clip.source] })
    }
    if (uncaptured && !files.hasAV) errors.push('the page media is a stream or too large to fetch directly')
  }
  if (!files.hasAV && tab && capture?.dom && (PLAYER_HINT.test(capture.dom) || pageSources.length)) {
    try {
      const live = await wakePlayers(tab, log, { reload: !scriptsRan })
      scriptsRan = true
      const known = new Set(pageSources)
      const { downloaded } = await downloadSources(live.filter((u) => !known.has(u)))
      for (const clip of downloaded) {
        files.add(clip.mimetype.startsWith('audio/') ? 'audio' : 'video', 'player-media', clip.blob, clip.mimetype, { capture_method: 'direct', source_urls: [clip.source] })
      }
      pageSources = [...new Set([...pageSources, ...live])]
    } catch (error) {
      errors.push(`player start: ${error.message}`)
    }
  }
  // A page that played one JW rendition: replace it with the tallest one.
  if (files.hasAV && files.list.some((f) => (f.properties.source_urls || []).some((u) => /cdn\.jwplayer\.com/.test(u)))) {
    try {
      const best = await jwBest(tab, pageSources)
      if (best && !files.list.some((f) => (f.properties.source_urls || []).includes(best.url))) {
        const response = await fetch(best.url, { credentials: 'include', signal: AbortSignal.timeout(MEDIA_FETCH_MS) })
        if (response.ok) {
          const blob = await response.blob()
          files.list = files.list.filter((f) => !(f.properties.source_urls || []).some((u) => /cdn\.jwplayer\.com/.test(u)))
          files.counts = { video: 0, audio: 0 }
          files.list.forEach((f) => { files.counts[/^audio/.test(f.mimetype) ? 'audio' : 'video'] += 1 })
          files.add('video', 'player-media', blob, 'video/mp4', { capture_method: 'direct', source_urls: [best.url], width: best.width, height: best.height })
        }
      }
    } catch (error) {
      errors.push(`jwplayer rendition: ${error.message}`)
    }
  }
  if (!files.hasAV) {
    try {
      await streams(tab, pageSources, files, log)
    } catch (error) {
      errors.push(error.message)
    }
  }
  if (!files.hasAV && tab && config.record_playback && expectsMediaDownload(url)) {
    try {
      await recordPlayback(url, tab, config, files, log, scriptsRan, temporary)
    } catch (error) {
      errors.push(`recording: ${error.message}`)
    }
  }

  if (!files.hasAV) {
    const embedded = EMBED.test(capture?.dom || '')
    if (embedded) errors.push('the video plays inside an embedded frame from another site, which is not captured')
    const detected = embedded || pageSources.length > 0 || (tab ? await tab.evaluate(VIDEO_INDICATOR_EXPRESSION).catch(() => false) : false)
    if (tab && (await tab.evaluate('Boolean(window.__pipelineEme)').catch(() => false))) errors.push('the page plays DRM-protected (EME) media, which cannot be saved')
    if (detected || errors.length) throw Object.assign(new Error(`Media was detected but could not be downloaded${errors.length ? `: ${errors.join('; ')}` : ''}`), { temporary })
    throw Object.assign(new Error('No media found'), { temporary })
  }
  // Keep what was saved; only a partial recording still has to reach review.
  const partial = errors.filter((e) => e.startsWith('recording:'))
  return { files: files.list, error: partial.join('; ') || null, temporary }
}

const resolution = (value) => {
  const [width, height] = String(value || '').split('x').map(Number)
  return width && height ? { width, height } : {}
}

/** Duration and size of a saved clip, read by the browser itself; null when it cannot decode the format (MPEG-TS, some codecs). */
export function probeMedia(blob, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const el = document.createElement('video')
    const url = URL.createObjectURL(blob)
    const done = (value) => { clearTimeout(timer); el.removeAttribute('src'); el.load(); URL.revokeObjectURL(url); resolve(value) }
    const timer = setTimeout(() => done(null), timeoutMs)
    el.preload = 'metadata'
    el.muted = true
    el.onloadedmetadata = () => done({ duration: Number.isFinite(el.duration) ? Math.round(el.duration * 10) / 10 : null, width: el.videoWidth || undefined, height: el.videoHeight || undefined })
    el.onerror = () => done(null)
    el.src = url
  })
}

/** The page's own content images (not icons, ads or avatars) at full resolution, each its own file: media_image_N. */
export async function imageFiles(sources, { limit = MAX_IMAGE_FILES } = {}) {
  // A responsive page lists one photo at several sizes (?w=800, ?resize=206,40): keep the widest of each.
  const widthOf = (u) => { try { const q = new URL(u).searchParams; return Number(q.get('w') || q.get('width') || /^(\d+)/.exec(q.get('resize') || '')?.[1]) || 0 } catch { return 0 } }
  const widest = new Map()
  for (const u of new Set((sources || []).filter(isRelevantImageUrl).map(bestQualityImageUrl))) {
    const key = u.split('?')[0]
    const have = widest.get(key)
    // No size parameter at all means the original, which beats any resized copy.
    if (!have || (widthOf(have) && (!widthOf(u) || widthOf(u) > widthOf(have)))) widest.set(key, u)
  }
  const wanted = [...widest.values()]
  const files = []
  const failed = []
  for (const url of wanted) {
    if (files.length >= limit) { failed.push(`${wanted.length - files.length - failed.length} more images beyond the ${limit}-image limit`); break }
    try {
      const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const type = baseMime(response.headers.get('Content-Type'))
      if (!type.startsWith('image/') || type === 'image/svg+xml') continue
      const blob = await response.blob()
      const size = await createImageBitmap(blob).then((b) => { const s = { width: b.width, height: b.height }; b.close(); return s }).catch(() => ({}))
      // Banners, buttons and tracking pixels the page layout happens to size up are not the item's images.
      if (size.width && (size.width < 200 || size.height < 150 || size.width / size.height > 8)) continue
      const n = files.length + 1
      files.push(media(`page_image_${n}`, `media_image_${n}${extensionForMime(type, '.jpg')}`, blob, type, { capture_method: 'direct', source_urls: [url], ...size }))
    } catch (error) {
      failed.push(`${url}: ${error.message}`)
    }
  }
  return { files, failed }
}

/** Subtitle/caption files the page declares on its players. */
export async function subtitleFiles(tracks) {
  const files = []
  for (const track of tracks || []) {
    try {
      const response = await fetch(track.url, { credentials: 'include', signal: AbortSignal.timeout(30_000) })
      if (!response.ok) continue
      const blob = await response.blob()
      const n = files.length + 1
      files.push(media(`subtitle_${n}`, `subtitles-${n}${/\.srt(\?|$)/i.test(track.url) ? '.srt' : '.vtt'}`, blob, blob.type || 'text/vtt', { capture_method: 'direct', source_urls: [track.url], lang: track.lang || undefined, label: track.label || undefined }))
    } catch { /* a missing caption file is not worth an issue */ }
  }
  return files
}
