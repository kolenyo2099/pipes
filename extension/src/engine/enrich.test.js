// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { enrich, saveToWayback } from './enrich.js'

const reply = (status, { url = '', headers = {}, body = {} } = {}) => ({
  status, ok: status >= 200 && status < 300, url,
  headers: { get: (h) => headers[h] ?? headers[h.toLowerCase()] ?? null },
  json: async () => body, arrayBuffer: async () => new ArrayBuffer(0)
})
const ts = () => { const d = new Date(Date.now() - 5000).toISOString(); return d.replace(/\D/g, '').slice(0, 14) }
const URL_ = 'https://example.com/a'

describe('saveToWayback', () => {
  it('anonymous: saved when IA redirects to a fresh snapshot', async () => {
    const t = ts()
    let seen
    const r = await saveToWayback(URL_, { fetchImpl: async (u) => { seen = u; return reply(200, { url: `https://web.archive.org/web/${t}/${URL_}` }) } })
    expect(seen).toBe(`https://web.archive.org/save/${URL_}`)
    expect(r).toEqual({ wayback_url: `https://web.archive.org/web/${t}/${URL_}`, status: 'saved' })
  })

  it('anonymous: exists when IA hands back an older snapshot (Content-Location)', async () => {
    const r = await saveToWayback(URL_, { fetchImpl: async () => reply(200, { headers: { 'Content-Location': `/web/20200101000000/${URL_}` } }) })
    expect(r).toEqual({ wayback_url: `https://web.archive.org/web/20200101000000/${URL_}`, status: 'exists' })
  })

  it('failure paths: HTTP error, rate limit, thrown fetch, no snapshot location', async () => {
    expect((await saveToWayback(URL_, { fetchImpl: async () => reply(523) })).status).toBe('failed')
    expect((await saveToWayback(URL_, { fetchImpl: async () => reply(429) })).error).toMatch(/rate limited/)
    expect((await saveToWayback(URL_, { fetchImpl: async () => { throw new TypeError('offline') } })).error).toBe('offline')
    expect((await saveToWayback(URL_, { fetchImpl: async () => reply(200, { url: URL_ }) })).status).toBe('failed')
  })

  it('timeout aborts the request and reports failed', async () => {
    const hang = (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' }))))
    const r = await saveToWayback(URL_, { fetchImpl: hang, timeoutMs: 20 })
    expect(r).toMatchObject({ wayback_url: null, status: 'failed' })
    expect(r.error).toMatch(/timed out/)
  })

  it('skips private, non-http and login-walled URLs without any request', async () => {
    const never = async () => { throw new Error('no request expected') }
    for (const u of ['http://localhost/x', 'http://192.168.1.2/', 'ftp://a.com/', 'https://www.instagram.com/p/abc/']) {
      expect((await saveToWayback(u, { fetchImpl: never })).status).toBe('skipped')
    }
  })

  it('authenticated: posts with LOW keys, polls until success; pending forever times out', async () => {
    const t = ts()
    const calls = []
    let polls = 0
    const fetchImpl = async (u, init) => {
      calls.push([u, init?.headers?.Authorization])
      if (u === 'https://web.archive.org/save/') return reply(200, { body: { job_id: 'j1' } })
      return ++polls < 3 ? reply(200, { body: { status: 'pending' } }) : reply(200, { body: { status: 'success', timestamp: t, original_url: URL_ } })
    }
    const r = await saveToWayback(URL_, { fetchImpl, accessKey: 'A', secretKey: 'S', pollMs: 1 })
    expect(r).toEqual({ wayback_url: `https://web.archive.org/web/${t}/${URL_}`, status: 'saved' })
    expect(calls[0][1]).toBe('LOW A:S')

    const pending = async (u) => (u.endsWith('/save/') ? reply(200, { body: { job_id: 'j2' } }) : reply(200, { body: { status: 'pending' } }))
    const slow = await saveToWayback(URL_, { fetchImpl: pending, accessKey: 'A', secretKey: 'S', pollMs: 5, timeoutMs: 30 })
    expect(slow.status).toBe('failed')
    expect(slow.error).toMatch(/timed out/)

    const blocked = async (u) => (u.endsWith('/save/') ? reply(200, { body: { job_id: 'j3' } }) : reply(200, { body: { status: 'error', status_ext: 'error:blocked-url' } }))
    expect((await saveToWayback(URL_, { fetchImpl: blocked, accessKey: 'A', secretKey: 'S', pollMs: 1 })).error).toBe('error:blocked-url')
  })
})

describe('enrich', () => {
  const fixtures = JSON.parse(readFileSync('src/engine/fixtures/source_dates_synthetic.json', 'utf8'))
  const gov = fixtures.find((f) => f.name === 'government_meta')
  const resultFor = (html, extra = {}) => ({ files: [{ id: 'screenshot', name: 'screenshot.png', blob: new Blob(['png']) }, { id: 'rendered_dom', name: 'dom.html', blob: new Blob([html], { type: 'text/html' }) }], metadata: { final_url: gov.url, ...extra } })
  const never = async () => { throw new Error('no network expected') }

  it('extracts dates from dom.html into source-dates.json and metadata; Wayback stays off by default', async () => {
    const out = await enrich({ url: gov.url, result: resultFor(gov.html), options: { fetchImpl: never } })
    expect(out.published_at).toBe('2025-11-14')
    expect(out.metadata.source_dates).toMatchObject({ published_at: '2025-11-14', method: 'meta', file: 'source-dates.json' })
    expect(out.metadata.wayback).toBeUndefined()
    const file = out.files.find((f) => f.name === 'source-dates.json')
    expect(JSON.parse(await file.blob.text()).selected).toEqual({ published: '2025-11-14' })
  })

  it('runs Save Page Now when options.wayback is true, and a failure does not break the result', async () => {
    const out = await enrich({ url: gov.url, result: resultFor(gov.html), options: { wayback: true, fetchImpl: async () => reply(503) } })
    expect(out.metadata.wayback.status).toBe('failed')
    expect(out.published_at).toBe('2025-11-14')
  })

  it('LinkedIn page with only a relative date: saves the lookup record and takes the date from the public card', async () => {
    const job = fixtures.find((f) => f.name === 'jobs_relative')
    const card = fixtures.find((f) => f.name === 'jobs_search_card')
    const html = '<title>Senior Analyst | Example Co | LinkedIn</title>' + job.html
    const fetchImpl = async () => ({ status: 200, headers: { get: () => 'text/html' }, body: new Response(card.html).body })
    const out = await enrich({ url: job.url, result: resultFor(html, { final_url: job.url }), options: { fetchImpl } })
    expect(out.published_at).toBe('2026-09-15')
    expect(out.metadata.source_dates).toMatchObject({ method: 'linkedin_public_search_card', lookup_status: 'matched' })
    expect(out.files.map((f) => f.name).sort()).toEqual(['linkedin-job-date-lookup.json', 'linkedin-job-search.html', 'source-dates.json'])
    const off = await enrich({ url: job.url, result: resultFor(html, { final_url: job.url }), options: { fetchImpl: never } })
    expect(off.metadata.source_dates.lookup_status).toBe('request_failed')
  })

  it('substituted captures are flagged and judged against the requested URL', async () => {
    const out = await enrich({ url: gov.url, result: resultFor(gov.html, { substituted: true, final_url: 'https://web.archive.org/web/2025/x' }), options: { fetchImpl: never } })
    expect(out.metadata.source_dates.from_substitute).toBe(true)
  })

  it('no html -> no dates, no throw', async () => {
    const out = await enrich({ url: gov.url, result: { files: [], metadata: {} }, options: {} })
    expect(out).toEqual({ files: [], metadata: {}, published_at: null })
  })
})
