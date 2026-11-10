// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { extractDatesFull, extractSourceDates, lookupLinkedInJobDate } from './source-dates.js'

const read = (name) => JSON.parse(readFileSync(`src/engine/fixtures/${name}`, 'utf8'))
const fixtures = read('source_dates_synthetic.json')
const expected = read('source_dates_synthetic_expected.json')

// desktop writes Python isoformat (date-only becomes T00:00:00); compare instants
const instant = (s) => {
  if (s == null) return s
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00'
  return new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : s + 'Z').getTime()
}
const rows = (obs) => obs.map((o) => [o.kind, o.scope, o.raw, o.source, instant(o.normalized)]).map((r) => JSON.stringify(r)).sort()
const expectedRows = (list) => list.map(([k, s, r, src, n]) => JSON.stringify([k, s, r, src, instant(n)])).sort()

describe('source dates vs desktop (synthetic fixtures; expected values produced by desktop source_dates.py)', () => {
  const results = fixtures.map((f) => {
    const actual = extractDatesFull(f.html, f.url)
    const want = expected[f.name]
    const sameRows = JSON.stringify(rows(actual.observations)) === JSON.stringify(expectedRows(want.observations))
    const sameSelected = JSON.stringify(Object.fromEntries(Object.entries(actual.selected).map(([k, v]) => [k, instant(v)]))) ===
      JSON.stringify(Object.fromEntries(Object.entries(want.selected).map(([k, v]) => [k, instant(v)])))
    return { name: f.name, ok: sameRows && sameSelected && !actual.errors.length }
  })

  it.each(results.map((r) => [r.name, r.ok]))('%s matches desktop', (_name, ok) => { expect(ok).toBe(true) })
  it('pass rate', () => {
    const passed = results.filter((r) => r.ok).length
    console.log(`source-date fixtures matching desktop: ${passed}/${results.length}`)
    expect(passed).toBe(results.length)
  })

  it('the contract wrapper selects the same published/updated values', () => {
    const f = fixtures.find((x) => x.name === 'news_jsonld_separate_update')
    const r = extractSourceDates({ html: f.html, url: f.url })
    expect(r.published_at).toBe('2026-01-20T18:04:43.845Z')
    expect(r.updated_at).toBe('2026-01-20T18:09:22.000Z')
    expect(r.method).toBe('json_ld')
    expect(r.candidates.length).toBeGreaterThan(0)
  })

  it('social thread: target post, not the reply; relative-only linkedin yields no absolute date', () => {
    const x = fixtures.find((f) => f.name === 'social_thread')
    expect(extractSourceDates({ html: x.html, url: x.url }).published_at).toBe('2026-02-04T21:23:36.000Z')
    const l = fixtures.find((f) => f.name === 'jobs_relative')
    const r = extractSourceDates({ html: l.html, url: l.url })
    expect(r.published_at).toBeNull()
    expect(r.summary.reported_relative).toEqual({ published: ['2 months ago'] })
  })

  it('never throws on junk', () => {
    expect(extractSourceDates({ html: null, url: undefined }).published_at).toBeNull()
  })
})

describe('platform rules vs desktop (reddit, threads, discord, bluesky, linkedin ids, tiktok, wayback urls)', () => {
  const cases = read('source_dates_platform_parity.json')
  it.each(cases.map((c, i) => [i, c.url, c]))('#%i %s', (_i, _url, c) => {
    const actual = extractDatesFull(c.html, c.url)
    expect(actual.errors).toEqual([])
    expect(rows(actual.observations)).toEqual(expectedRows(c.observations))
  })
})

describe('regression: URL equality follows desktop (raw text, not WHATWG-normalised)', () => {
  it('an entity whose URL differs only by percent-encoding is not the page, so a same-page meta date still selects', () => {
    const f = fixtures.find((x) => x.name === 'encoded_path_entity')
    const r = extractSourceDates({ html: f.html, url: f.url })
    expect(r.published_at).toBe('2026-02-07T23:56:45')
    expect(r.summary.disagreements).toEqual({})
  })
  it('trailing slashes and host case still match', () => {
    const html = '<script type="application/ld+json">{"@type":"NewsArticle","url":"https://NEWS.example/a/b//","datePublished":"2026-01-01"}</script>'
    expect(extractSourceDates({ html, url: 'https://news.example/a/b' }).published_at).toBe('2026-01-01')
  })
})

// Optional: the real archived pages HRC keeps in its own repo. Never copied here; skipped when the checkout is absent.
const HRC = process.env.HRC_CHECKOUT || '/Users/guillen/Documents/experiments/HRCARchiver'
const realFile = `${HRC}/backend/tests/fixtures/source_dates_archived.json`
describe.skipIf(!existsSync(realFile))('real HRC archived fragments (optional)', () => {
  const real = existsSync(realFile) ? JSON.parse(readFileSync(realFile, 'utf8')) : []
  const want = { government_meta: { published: '2025-11-14' }, youtube_meta: { published: '2026-02-07T18:30:06.000Z', uploaded: '2026-02-07T18:30:06.000Z' },
    x_thread: { published: '2026-02-04T21:23:36.000Z' }, instagram_target_json: { published: '2025-09-27T08:21:46.000Z' }, linkedin_job_search_exact: { published: '2026-09-15' },
    linkedin_job_relative: {}, linkedin_job_4467423828: {}, persian_header_clock: {} }
  it.each(Object.entries(want))('%s', (name, selected) => {
    const f = real.find((x) => x.name === name)
    expect(extractDatesFull(f.html, f.url).selected).toEqual(selected)
  })
})

describe('LinkedIn job-card lookup', () => {
  const job = fixtures.find((f) => f.name === 'jobs_relative')
  const card = fixtures.find((f) => f.name === 'jobs_search_card')
  const html = '<title>Senior Analyst | Example Co | LinkedIn</title>' + job.html
  const res = (status, body = '', headers = { 'Content-Type': 'text/html' }) => new Response(body, { status, headers })
  const sleeps = []
  const base = { html, url: job.url, sleepImpl: async (ms) => { sleeps.push(ms) } }

  it('matches a date from the public card, with safe fetch options', async () => {
    let init
    const r = await lookupLinkedInJobDate({ ...base, fetchImpl: async (u, o) => { init = o; return res(200, card.html) } })
    expect(r.record.status).toBe('matched')
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' })
    expect(extractDatesFull(await r.blob.text(), job.url).selected.published).toBe('2026-09-15')
  })

  it('honours Retry-After (capped at 30s, floored at our step) and reports rate_limited', async () => {
    sleeps.length = 0
    const r = await lookupLinkedInJobDate({ ...base, fetchImpl: async () => res(429, '', { 'Retry-After': '99' }) })
    expect(r.record.status).toBe('rate_limited')
    expect(sleeps).toEqual([30000, 30000])
    sleeps.length = 0
    await lookupLinkedInJobDate({ ...base, fetchImpl: async () => res(429, '', { 'Retry-After': '1' }) })
    expect(sleeps).toEqual([5000, 15000])
  })

  it('reports oversized responses as response_limit', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024 + 10)
    const r = await lookupLinkedInJobDate({ ...base, fetchImpl: async () => res(200, big) })
    expect(r.record.status).toBe('response_limit')
    expect(r.blob).toBeNull()
  })

  it('skips pages that already carry a date or are not LinkedIn jobs', async () => {
    const never = async () => { throw new Error('should not fetch') }
    expect(await lookupLinkedInJobDate({ ...base, html: card.html, fetchImpl: never })).toBeNull()
    expect(await lookupLinkedInJobDate({ ...base, url: 'https://example.com/', fetchImpl: never })).toBeNull()
  })

  it('network failure is a record, not a throw', async () => {
    const r = await lookupLinkedInJobDate({ ...base, fetchImpl: async () => { throw new TypeError('offline') } })
    expect(r.record.status).toBe('request_failed')
  })
})
