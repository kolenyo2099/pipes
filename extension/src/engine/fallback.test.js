import { describe, it, expect } from 'vitest'
import { fallbackCapture, discoverAlternates, scoreResponse, isPublicHttpUrl } from './fallback.js'

const enc = (s) => new TextEncoder().encode(s)
const reply = (body, { status = 200, type = 'text/html; charset=utf-8', url = '' } = {}) => ({
  status, ok: status >= 200 && status < 300, url,
  headers: { get: (h) => (h.toLowerCase() === 'content-type' ? type : null) },
  arrayBuffer: async () => (typeof body === 'string' ? enc(body) : body).buffer.slice(0)
})
const article = (title) => `<html><head><title>${title}</title></head><body><article>${'The quick brown fox jumps over the lazy dog. '.repeat(40)}</article></body></html>`
const wall = '<html><head><title>Just a moment</title></head><body>Enable JavaScript and cookies to continue</body></html>'
const ORIGINAL = 'https://news.example.com/story'
const fixedNow = () => new Date('2026-01-02T03:04:05.000Z')

// route table: url -> reply (or function); records the order of requests
function router(routes, calls = []) {
  const fetchImpl = async (url, init) => {
    calls.push({ url, ua: init?.headers?.['User-Agent'] })
    const hit = routes[url]
    if (!hit) return reply('', { status: 404, url })
    return typeof hit === 'function' ? hit(init) : hit
  }
  return fetchImpl
}

describe('fallbackCapture ladder', () => {
  it('prefers a live AMP alternate over Wayback and records provenance', async () => {
    const calls = []
    const html = `<link rel="amphtml" href="https://news.example.com/story/amp"><link rel="canonical" href="https://news.example.com/story-canon">${wall}`
    const fetchImpl = router({
      [ORIGINAL]: reply(html, { url: ORIGINAL }),
      'https://news.example.com/story/amp': reply(article('AMP story'), { url: 'https://news.example.com/story/amp' })
    }, calls)
    const r = await fallbackCapture(ORIGINAL, { reason: 'blank_render', fetchImpl, now: fixedNow })
    expect(r.metadata.substituted).toBe(true)
    expect(r.metadata.substitution).toMatchObject({ kind: 'amp', source_url: 'https://news.example.com/story/amp', original_url: ORIGINAL, reason: 'blank_render', retrieved_at: '2026-01-02T03:04:05.000Z' })
    expect(r.metadata.title).toBe('AMP story')
    expect(r.files[0]).toMatchObject({ id: 'source_document', name: 'substitute-amp.html' })
    expect(r.text).toContain('quick brown fox')
    expect(calls.some((c) => c.url.includes('web.archive.org'))).toBe(false)
  })

  it('tries alternates in amp, canonical, print, pdf order', async () => {
    const calls = []
    const html = `<a href="/doc.pdf">pdf</a><a href="/story/print">print</a><link rel="canonical" href="https://news.example.com/c"><link rel="amphtml" href="/a">${wall}`
    const fetchImpl = router({ [ORIGINAL]: reply(html, { url: ORIGINAL }) }, calls)
    await fallbackCapture(ORIGINAL, { fetchImpl, wayback: false })
    expect(calls.map((c) => c.url)).toEqual([ORIGINAL, 'https://news.example.com/a', 'https://news.example.com/c', 'https://news.example.com/story/print', 'https://news.example.com/doc.pdf'])
  })

  it('accepts a discovered PDF by signature', async () => {
    const fetchImpl = router({
      [ORIGINAL]: reply(`<a href="/doc.pdf">pdf</a>${wall}`, { url: ORIGINAL }),
      'https://news.example.com/doc.pdf': reply(enc('%PDF-1.7 ...'), { type: 'application/pdf', url: 'https://news.example.com/doc.pdf' })
    })
    const r = await fallbackCapture(ORIGINAL, { fetchImpl })
    expect(r.metadata.substitution.kind).toBe('pdf')
    expect(r.files[0].name).toBe('substitute-pdf.pdf')
    expect(r.text).toBe('')
  })

  it('retries with a crawler user agent only after 403/429/451, after live alternates, never on 401', async () => {
    const calls = []
    const fetchImpl = router({
      [ORIGINAL]: (init) => (init?.headers?.['User-Agent'] ? reply(article('Crawler view'), { url: ORIGINAL }) : reply('', { status: 403, url: ORIGINAL }))
    }, calls)
    const r = await fallbackCapture(ORIGINAL, { fetchImpl, wayback: false })
    expect(r.metadata.substitution.kind).toBe('crawler_ua')
    expect(calls.map((c) => !!c.ua)).toEqual([false, true])
    expect(r.metadata.substitution.attempts[1].user_agent_requested).toMatch(/Googlebot/)

    const calls401 = []
    expect(await fallbackCapture(ORIGINAL, { fetchImpl: router({ [ORIGINAL]: reply('', { status: 401, url: ORIGINAL }) }, calls401), wayback: false })).toBeNull()
    expect(calls401).toHaveLength(1)
  })

  it('consults Wayback only after every live candidate fails, and labels it as a snapshot', async () => {
    const calls = []
    const cdx = 'https://web.archive.org/cdx/search/cdx?url=' + encodeURIComponent(ORIGINAL) + '&output=json&fl=timestamp,original&filter=statuscode:200&limit=-1'
    const snap = 'https://web.archive.org/web/20250101120000id_/' + ORIGINAL
    const fetchImpl = router({
      [ORIGINAL]: reply(`<link rel="amphtml" href="/amp">${wall}`, { url: ORIGINAL }),
      'https://news.example.com/amp': reply('', { status: 404 }),
      [cdx]: reply(JSON.stringify([['timestamp', 'original'], ['20240101000000', ORIGINAL], ['20250101120000', ORIGINAL]]), { type: 'application/json' }),
      [snap]: reply(article('Archived story'), { url: snap })
    }, calls)
    const r = await fallbackCapture(ORIGINAL, { reason: 'walled', fetchImpl, now: fixedNow })
    expect(r.metadata.substitution).toMatchObject({ kind: 'wayback', original_url: ORIGINAL, wayback_timestamp: '20250101120000', source_url: snap })
    expect(r.files[0].name).toBe('substitute-wayback.html')
    const order = calls.map((c) => c.url)
    expect(order.indexOf(cdx)).toBeGreaterThan(order.indexOf('https://news.example.com/amp'))
  })

  it('wayback: false never contacts the Internet Archive', async () => {
    const calls = []
    const r = await fallbackCapture(ORIGINAL, { fetchImpl: router({ [ORIGINAL]: reply(wall, { url: ORIGINAL }) }, calls), wayback: false })
    expect(r).toBeNull()
    expect(calls.some((c) => c.url.includes('archive.org'))).toBe(false)
  })

  it('returns null when nothing works, when fetch throws, and for non-public URLs; never throws', async () => {
    expect(await fallbackCapture(ORIGINAL, { fetchImpl: async () => { throw new TypeError('offline') } })).toBeNull()
    expect(await fallbackCapture(ORIGINAL, { fetchImpl: router({ [ORIGINAL]: reply(wall) }) })).toBeNull()
    expect(await fallbackCapture('http://localhost:8080/x', { fetchImpl: async () => { throw new Error('must not fetch') } })).toBeNull()
    expect(await fallbackCapture('not a url', {})).toBeNull()
  })

  it('times out slow candidates', async () => {
    const slow = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    expect(await fallbackCapture(ORIGINAL, { fetchImpl: slow, timeoutMs: 20, wayback: false })).toBeNull()
  })
})

describe('helpers', () => {
  it('scores like desktop', () => {
    const ok = scoreResponse({ originalUrl: ORIGINAL, finalUrl: ORIGINAL, status: 200, type: 'text/html', bytes: enc(article('T')) })
    expect(ok).toMatchObject({ score: 20 + 10 + 15 + 20 + 10 + 5 - 0 + 0, accepted: true })
    const bad = scoreResponse({ originalUrl: ORIGINAL, finalUrl: ORIGINAL, status: 200, type: 'text/html', bytes: enc(wall) })
    expect(bad.accepted).toBe(false)
    expect(bad.reasons).toContain('error_marker:enable javascript')
    expect(scoreResponse({ originalUrl: ORIGINAL, finalUrl: ORIGINAL, status: 500, type: 'text/html', bytes: enc('x') }).score).toBe(0)
  })

  it('rejects private and local targets, deduplicates and caps alternates', () => {
    expect(['http://127.0.0.1/', 'http://10.1.2.3/', 'http://192.168.0.1/', 'http://[::1]/', 'http://localhost/', 'file:///etc/passwd', 'ftp://x.com/'].some(isPublicHttpUrl)).toBe(false)
    expect(isPublicHttpUrl('https://example.com/')).toBe(true)
    const html = '<link rel="canonical" href="http://127.0.0.1/x"><a href="/p/print">p</a><a href="/p/print#frag">p</a>' + Array.from({ length: 20 }, (_, i) => `<a href="/f${i}.pdf">`).join('')
    const found = discoverAlternates(html, 'https://e.com/p')
    expect(found).toHaveLength(8)
    expect(found[0]).toEqual({ url: 'https://e.com/p/print', kind: 'print' })
  })
})
