// Document fallback ladder, ported from HRC desktop's simple_http_extractor (docs/adaptive-capture.md).
// Runs only after the live browser capture failed or was judged blank/walled. Order:
//   1. a plain fetch of the URL, used to discover alternates (and judged blocked/walled by status)
//   2. live alternates it advertises: AMP, canonical, print, PDF (at most 8)
//   3. the same URL with a disclosed crawler user agent, only if the server said 403/429/451 (never on 401)
//   4. Wayback (CDX latest 200 snapshot), only when every live candidate failed and `wayback` is not false
// A candidate is accepted at score >= 55 (same explainable score as desktop). Whatever wins is a SUBSTITUTE for
// the page, never the page itself (FIXES 2, 3, 18): it is named substitute-<kind>.*, flagged metadata.substituted
// and carries its full provenance. Never throws; null when nothing reaches the threshold.
//
// ponytail: crawler_ua sends `User-Agent` through fetch(). An extension page may not be allowed to override it
// (it is a restricted header in some Chrome versions, and fetch cannot set Referer/Origin/Sec-* or cookies for
// other sites at all). The attempt is recorded as `user_agent_requested`, never as applied; the robust version is
// a declarativeNetRequest session rule that rewrites User-Agent for this extension's own requests, which needs
// the declarativeNetRequest permission. Other limits: alternates are fetched anonymously (credentials omitted,
// so a walled page stays walled), cross-origin fetches need the host permission to be granted, no text-rendered
// PDF is generated (desktop's page_pdf_fallback), no per-host strategy learning, no host override table.

export const THRESHOLD = 55
const CRAWLER_UA = 'Googlebot/2.1 (+http://www.google.com/bot.html)'
const MAX_DISCOVERED = 8
const MAX_ATTEMPTS = 12
const MAX_BYTES = 100_000_000
const ERROR_MARKERS = ['access denied', 'attention required', 'captcha', 'enable javascript', 'page not found', 'request blocked', 'service unavailable', 'temporarily unavailable']
const RANK = { amp: 0, canonical: 1, print: 2, pdf: 3 }

/** http(s) with a real hostname that is not localhost or a private/loopback/link-local/reserved literal IP. */
export function isPublicHttpUrl(url) {
  let u
  try { u = new URL(url) } catch { return false }
  if (!/^https?:$/.test(u.protocol) || !u.hostname) return false
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'localhost.localdomain') return false
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]]
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127))
  }
  if (host.includes(':')) return !(host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:'))
  return true
}

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;/g, "'")

/** { title, text, hasArticle } from HTML by regex; good enough to score, not a parser. */
export function readable(html) {
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '')).replace(/\s+/g, ' ').trim()
  const body = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  const text = decode(body.replace(/<\/?(?:address|article|aside|blockquote|br|div|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|td|th|tr|ul)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' '))
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
  return { title, text, hasArticle: /<(article|main)\b/i.test(body) }
}

const attr = (tag, name) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(1).find((v) => v !== undefined) ?? ''

/** Alternates advertised by an HTML page: [{ url, kind }] ordered amp, canonical, print, pdf. Pure. */
export function discoverAlternates(html, baseUrl) {
  const found = []
  const seen = new Set([baseUrl.replace(/#.*$/, '')])
  for (const tag of html.match(/<(?:a|link)\b[^>]*>/gi) || []) {
    const href = decode(attr(tag, 'href'))
    if (!href) continue
    let abs
    try { abs = new URL(href, baseUrl).href.replace(/#.*$/, '') } catch { continue }
    const rel = `${attr(tag, 'rel')} ${attr(tag, 'media')} ${attr(tag, 'type')}`.toLowerCase()
    const path = new URL(abs).pathname.toLowerCase()
    const kind = rel.includes('amphtml') ? 'amp' : rel.includes('canonical') ? 'canonical' : rel.includes('print') || path.includes('print') ? 'print' : rel.includes('application/pdf') || path.endsWith('.pdf') ? 'pdf' : null
    if (!kind || seen.has(abs) || !isPublicHttpUrl(abs)) continue
    seen.add(abs)
    found.push({ url: abs, kind })
    if (found.length >= MAX_DISCOVERED) break
  }
  return found.sort((a, b) => RANK[a.kind] - RANK[b.kind])
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' } }

/** Desktop's evaluate_response. `bytes` is a Uint8Array, `type` the lowercase media type. */
export function scoreResponse({ originalUrl, finalUrl, status, type, bytes }) {
  const isPdf = bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-'
  if (isPdf) return { score: 100, accepted: status >= 200 && status < 400, media_type: 'application/pdf', reasons: ['pdf_signature'] }
  if (!(status >= 200 && status < 400)) return { score: 0, accepted: false, media_type: type, reasons: [`http_${status}`] }
  if (!['text/html', 'application/xhtml+xml', 'text/plain', ''].includes(type)) {
    const score = bytes.length >= 128 ? 70 : 20
    return { score, accepted: score >= THRESHOLD, media_type: type, reasons: ['non_html_response'] }
  }
  const { title, text, hasArticle } = readable(new TextDecoder().decode(bytes))
  const lowered = text.toLowerCase()
  const reasons = []
  let score = 20
  const add = (cond, points, why) => { if (cond) { score += points; reasons.push(why) } }
  add(title, 10, 'title')
  add(text.length >= 200, 15, 'text_200')
  add(text.length >= 1000, 20, 'text_1000')
  add(text.length >= 5000, 10, 'text_5000')
  add(hasArticle, 10, 'semantic_article')
  add(hostOf(originalUrl) === hostOf(finalUrl), 5, 'same_host')
  const markers = ERROR_MARKERS.filter((m) => lowered.includes(m))
  if (markers.length) { score -= 70; reasons.push(...markers.map((m) => `error_marker:${m}`)) }
  if (text.length < 80) { score -= 30; reasons.push('little_text') }
  score = Math.max(0, Math.min(100, score))
  return { score, accepted: score >= THRESHOLD, media_type: type || 'text/html', reasons }
}

async function get(fetchImpl, url, { userAgent, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { credentials: 'omit', redirect: 'follow', signal: controller.signal, headers: userAgent ? { 'User-Agent': userAgent } : {} })
    if (Number(response.headers.get('Content-Length') || 0) > MAX_BYTES) throw new Error('response larger than 100 MB')
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { status: response.status, url: response.url || url, type: (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase(), bytes }
  } finally {
    clearTimeout(timer)
  }
}

/** Latest successful Wayback snapshot of `url`: { source_url, timestamp, original } or null. */
export async function waybackSnapshot(url, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  try {
    const api = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&fl=timestamp,original&filter=statuscode:200&limit=-1`
    const r = await get(fetchImpl, api, { timeoutMs })
    if (r.status !== 200) return null
    const rows = JSON.parse(new TextDecoder().decode(r.bytes))
    const row = Array.isArray(rows) ? rows.filter((x) => Array.isArray(x) && /^\d{14}$/.test(x[0])).pop() : null
    // id_ asks for the original bytes without the Wayback toolbar or rewritten links
    return row ? { timestamp: row[0], original: row[1], source_url: `https://web.archive.org/web/${row[0]}id_/${row[1]}` } : null
  } catch {
    return null
  }
}

const nameOf = (u) => { try { return decodeURIComponent(new URL(u).pathname.split('/').pop() || '') } catch { return '' } }
const filenameFor = (kind, type) => `substitute-${kind}.${type === 'application/pdf' ? 'pdf' : type === 'text/plain' ? 'txt' : type === 'text/html' || type === 'application/xhtml+xml' || !type ? 'html' : 'bin'}`

/**
 * @param {string} url the original URL that could not be captured live
 * @param {{ reason?: string, fetchImpl?: typeof fetch, wayback?: boolean, timeoutMs?: number, now?: () => Date }} [options]
 * @returns {Promise<null | { files: {id: string, name: string, blob: Blob}[], metadata: object, text: string }>}
 */
export async function fallbackCapture(url, { reason = '', fetchImpl = globalThis.fetch, wayback = true, timeoutMs = 15000, now = () => new Date() } = {}) {
  try {
    if (typeof fetchImpl !== 'function' || !isPublicHttpUrl(url)) return null
    const attempts = []
    const tried = new Set()
    const queue = [{ url, kind: 'direct' }]
    let selected = null

    const consider = async (candidate, userAgent) => {
      const key = `${candidate.url}\n${userAgent || ''}`
      if (tried.has(key) || !isPublicHttpUrl(candidate.url) || attempts.length >= MAX_ATTEMPTS) return null
      tried.add(key)
      const attempt = { strategy: candidate.kind, url: candidate.url, ...(userAgent && { user_agent_requested: userAgent }) }
      attempts.push(attempt)
      try {
        const r = await get(fetchImpl, candidate.url, { userAgent, timeoutMs })
        const verdict = scoreResponse({ originalUrl: candidate.compareTo || url, finalUrl: r.url, status: r.status, type: r.type, bytes: r.bytes })
        Object.assign(attempt, { status_code: r.status, score: verdict.score, accepted: verdict.accepted, reasons: verdict.reasons })
        return { r, verdict }
      } catch (error) {
        attempt.accepted = false
        attempt.error = `${error?.name || 'Error'}: ${error?.message || error}`
        return null
      }
    }

    let crawlerQueued = false
    while (queue.length && !selected) {
      const candidate = queue.shift()
      const userAgent = candidate.kind === 'crawler_ua' ? CRAWLER_UA : undefined
      const got = await consider(candidate, userAgent)
      if (!got) continue
      const isHtml = ['text/html', 'application/xhtml+xml', ''].includes(got.r.type)
      // direct is only a source of alternates: the live browser capture already failed, so it is not a substitute
      if (candidate.kind !== 'direct' && got.verdict.accepted) { selected = { candidate, ...got }; break }
      if (isHtml && candidate.kind !== 'amp' && candidate.kind !== 'print') {
        queue.push(...discoverAlternates(new TextDecoder().decode(got.r.bytes), got.r.url))
        queue.sort((a, b) => (a.kind === 'crawler_ua') - (b.kind === 'crawler_ua') || (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9))
      }
      // 401 is an authentication failure, never a public variant; only 403/429/451 mean "blocked for this client"
      if ([403, 429, 451].includes(got.r.status) && !crawlerQueued && candidate.kind !== 'crawler_ua') {
        crawlerQueued = true
        queue.push({ url: candidate.url, kind: 'crawler_ua' })
        queue.sort((a, b) => (a.kind === 'crawler_ua') - (b.kind === 'crawler_ua'))
      }
    }

    let snapshot = null
    if (!selected && wayback) {
      snapshot = await waybackSnapshot(url, { fetchImpl, timeoutMs })
      if (snapshot) {
        const got = await consider({ url: snapshot.source_url, kind: 'wayback', compareTo: snapshot.original }, undefined)
        if (got?.verdict.accepted) selected = { candidate: { url: snapshot.source_url, kind: 'wayback' }, ...got }
      }
    }
    if (!selected) return null

    const { candidate, r, verdict } = selected
    const type = verdict.media_type
    const isWayback = candidate.kind === 'wayback'
    const waybackStamp = isWayback ? (/\/web\/(\d{14})/.exec(r.url)?.[1] || snapshot.timestamp) : null
    const asText = ['text/html', 'application/xhtml+xml', 'text/plain', ''].includes(type)
    const readableText = asText ? readable(new TextDecoder().decode(r.bytes)) : null
    return {
      files: [{ id: 'source_document', name: filenameFor(candidate.kind, type), blob: new Blob([r.bytes], { type: type || 'application/octet-stream' }) }],
      metadata: {
        substituted: true,
        substitution: {
          kind: candidate.kind,
          source_url: isWayback ? r.url : candidate.url,
          original_url: url,
          reason,
          retrieved_at: now().toISOString(),
          ...(isWayback && { wayback_timestamp: waybackStamp }),
          content_type: type || null,
          quality_score: verdict.score,
          quality_reasons: verdict.reasons,
          attempts
        },
        final_url: r.url,
        title: readableText?.title || nameOf(r.url)
      },
      text: readableText?.text || ''
    }
  } catch {
    return null
  }
}
