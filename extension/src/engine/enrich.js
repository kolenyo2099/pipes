// What the evidence pipeline adds after a capture: source-reported dates, an optional Internet Archive save,
// and (re-exported) the fallback ladder for pages that could not be captured live.
// All network calls take an injectable fetchImpl (default globalThis.fetch). Nothing here throws.
import { extractSourceDates, extractDatesFull, lookupLinkedInJobDate } from './source-dates.js'
import { isPublicHttpUrl, fallbackCapture } from './fallback.js'

export { extractSourceDates, lookupLinkedInJobDate, fallbackCapture, isPublicHttpUrl }

// HRC skips Save Page Now for pages behind a login wall (the saved copy would be the login page)
const AUTH_WALL = [/^https?:\/\/t\.me\/c\/.+\/\d+/, /^https?:\/\/(www\.)?instagram\.com/]
const SNAPSHOT = /\/web\/(\d{14})(?:[a-z]+_)?\/(https?:\/\/.+)$/
const STALE_MS = 2 * 60 * 1000

const stamp = (ts) => Date.parse(`${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}Z`)
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The snapshot the Wayback Machine points us at: Content-Location, then the post-redirect response URL.
function snapshotFrom(response) {
  for (const candidate of [response.headers?.get?.('Content-Location'), response.url]) {
    const m = candidate && SNAPSHOT.exec(candidate.startsWith('/') ? `https://web.archive.org${candidate}` : candidate)
    if (m) return { wayback_url: `https://web.archive.org/web/${m[1]}/${m[2]}`, taken: stamp(m[1]) }
  }
  return null
}

const verdict = (snap, startedAt) => ({ wayback_url: snap.wayback_url, status: startedAt - snap.taken > STALE_MS ? 'exists' : 'saved' })

/**
 * Ask the Internet Archive to save the live URL (Save Page Now). Anonymous by default; with { accessKey, secretKey }
 * it uses the authenticated SPN2 API as HRC's enricher does. Off unless the caller opts in. Never throws.
 * status: saved (fresh capture) | exists (IA answered with an older snapshot instead of a new capture) | failed | skipped
 * ponytail: anonymous mode cannot tell "saved just now" from "IA reused a snapshot" other than by the snapshot's
 * age (older than 2 min = exists). Use the keyed API with if_not_archived_within when that distinction matters.
 * @returns {Promise<{ wayback_url: string|null, status: 'saved'|'exists'|'failed'|'skipped', error?: string, job_id?: string, check_status?: string }>}
 */
export async function saveToWayback(url, { timeoutMs = 60000, fetchImpl = globalThis.fetch, accessKey, secretKey, pollMs = 1000, sleepImpl = defaultSleep } = {}) {
  const fail = (error, extra) => ({ wayback_url: null, status: 'failed', error, ...extra })
  if (typeof fetchImpl !== 'function') return fail('no fetch available')
  if (!isPublicHttpUrl(url)) return { wayback_url: null, status: 'skipped', error: 'not a public http(s) URL' }
  if (AUTH_WALL.some((re) => re.test(url))) return { wayback_url: null, status: 'skipped', error: 'behind an authentication wall' }
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    if (!(accessKey && secretKey)) {
      const response = await fetchImpl(`https://web.archive.org/save/${url}`, { credentials: 'omit', redirect: 'follow', signal: controller.signal })
      if (response.status === 429) return fail('rate limited by the Internet Archive')
      const snap = response.ok ? snapshotFrom(response) : null
      return snap ? verdict(snap, startedAt) : fail(response.ok ? 'no snapshot location in the response' : `Internet Archive answered HTTP ${response.status}`)
    }
    const headers = { Accept: 'application/json', Authorization: `LOW ${accessKey}:${secretKey}` }
    const response = await fetchImpl('https://web.archive.org/save/', { method: 'POST', headers, body: new URLSearchParams({ url }), credentials: 'omit', signal: controller.signal })
    const payload = await response.json().catch(() => ({}))
    if (response.status !== 200) return fail(`Internet Archive failed with HTTP ${response.status}: ${payload.message || payload.status_ext || ''}`.trim())
    if (!payload.job_id) return fail(payload.message || 'no job_id in the response')
    const check_status = `https://web.archive.org/save/status/${payload.job_id}`
    for (;;) {
      const r = await fetchImpl(check_status, { headers, credentials: 'omit', signal: controller.signal })
      const json = await r.json().catch(() => ({}))
      if (r.status === 200 && json.status === 'success') {
        return verdict({ wayback_url: `https://web.archive.org/web/${json.timestamp}/${json.original_url}`, taken: stamp(json.timestamp) }, startedAt)
      }
      if (r.status !== 200 || json.status !== 'pending') return fail(json.status_ext || json.message || `status check failed (HTTP ${r.status})`)
      if (controller.signal.aborted) throw new DOMException('timed out', 'AbortError')
      await sleepImpl(pollMs)
    }
  } catch (error) {
    return error?.name === 'AbortError' ? fail(`timed out after ${timeoutMs} ms`) : fail(error?.message || String(error))
  } finally {
    clearTimeout(timer)
  }
}

const json = (value) => new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })

/**
 * Convenience wrapper: source dates from the captured dom.html (plus the public LinkedIn job-card lookup when the page
 * carries no absolute date and options.linkedinLookup !== false), and Save Page Now when options.wayback is true.
 * options: { wayback, accessKey, secretKey, waybackTimeoutMs, linkedinLookup, fetchImpl, sleepImpl }.
 * Needs DOMParser (extension page / offscreen document). Never throws.
 * @returns {Promise<{ files: {name: string, blob: Blob}[], metadata: { source_dates?: object, wayback?: object }, published_at: string|null }>}
 */
export async function enrich({ url, result, options = {} }) {
  const out = { files: [], metadata: {}, published_at: null }
  const { fetchImpl = globalThis.fetch } = options
  try {
    const substituted = Boolean(result?.metadata?.substituted)
    const dom = (result?.files || []).find((f) => f.id === 'rendered_dom' || f.id === 'source_document' || /\.html?$/i.test(f.name || ''))
    // a substitute's own URL (Wayback, AMP) would mislead the platform rules; dates are judged against the requested URL
    const pageUrl = substituted ? url : result?.metadata?.final_url || url
    if (dom?.blob?.size && dom.blob.size <= 20 * 1024 * 1024) {
      const html = await dom.blob.text()
      const dates = extractSourceDates({ html, url: pageUrl })
      let { published_at, updated_at, method } = dates
      const lookup = await lookupLinkedInJobDate({ html, url: pageUrl, fetchImpl, sleepImpl: options.sleepImpl })
      let lookupDates = null
      if (lookup) {
        out.files.push({ name: 'linkedin-job-date-lookup.json', blob: json(lookup.record) })
        if (lookup.blob) {
          out.files.push({ name: 'linkedin-job-search.html', blob: lookup.blob })
          lookupDates = extractDatesFull(await lookup.blob.text(), pageUrl).selected
          if (lookup.record.status === 'matched' && !published_at) { published_at = lookupDates.published; method = 'linkedin_public_search_card' }
        }
      }
      out.files.push({ name: 'source-dates.json', blob: json({ ...dates.summary, source_date_lookup: lookup?.record ?? null, substituted_capture: substituted }) })
      const s = dates.summary
      out.metadata.source_dates = {
        published_at, updated_at, method, selected: s?.selected ?? {}, disagreements: s?.disagreements ?? {}, reported_relative: s?.reported_relative ?? {},
        observation_count: s?.observations.length ?? 0, errors: s?.errors ?? [], ...(lookup && { lookup_status: lookup.record.status }),
        ...(substituted && { from_substitute: true }), file: 'source-dates.json'
      }
      out.published_at = published_at
    }
  } catch (error) {
    out.metadata.source_dates = { error: error?.message || String(error) }
  }
  if (options.wayback === true) {
    out.metadata.wayback = await saveToWayback(url, { fetchImpl, accessKey: options.accessKey, secretKey: options.secretKey, timeoutMs: options.waybackTimeoutMs, sleepImpl: options.sleepImpl })
  }
  return out
}
