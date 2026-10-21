import { describe, expect, it } from 'vitest'
import { compileQueries, rssItems, rssUrl, rssWindows, simpleFilterPasses } from './rss.js'

const feed = items => `<?xml version="1.0"?><rss version="2.0"><channel>${items.map(i => `<item><title>${i.title}</title><link>${i.link}</link><guid>${i.link}</guid><pubDate>${i.date || 'Sun, 27 Sep 2026 10:00:00 GMT'}</pubDate><description>${i.description || ''}</description><source url="https://www.reuters.com">Reuters</source></item>`).join('')}</channel></rss>`
const project = { project_id: 'p', countries_focus: ['MX'] }
const window = ['2026-09-27T00:00:00.000Z', '2026-09-28T00:00:00.000Z']

describe('Google News RSS', () => {
  it('supports required-term matches in text or existing entity metadata', () => {
    const logic = { query_terms: ['flood'], require_any: ['Italy'] }
    expect(simpleFilterPasses(logic, 'Flood in Italy')).toBe(true)
    expect(simpleFilterPasses(logic, 'Flood in Canada')).toBe(false)
    expect(simpleFilterPasses(logic, 'Flood', '', { locations: ['Northern Italy'] })).toBe(true)
    expect(simpleFilterPasses({ action_core: ['flood'], require_any: ['Italy'] }, 'Flood in Canada')).toBe(true)
  })
  it('defers simple-mode filtering until after NLP when collecting candidates', () => {
    const xml = feed([{ title: 'Flood warnings issued', link: 'https://news.example/a' }])
    const rule = { bucket_name: 'Floods', lane: 'rss', enabled: true, logic: { query_terms: ['flood'], require_any: ['Italy'] } }
    expect(rssItems(xml, project, rule, { label: 'US:en', query: 'flood' }, ...window)).toHaveLength(0)
    const candidates = rssItems(xml, project, rule, { label: 'US:en', query: 'flood' }, ...window, { deferSimpleFilter: true })
    expect(candidates).toHaveLength(1)
    expect(simpleFilterPasses(rule.logic, candidates[0].title_or_summary, '', { locations: ['Northern Italy'] })).toBe(true)
  })
  const advanced = { bucket_name: 'Deportations', lane: 'rss', enabled: true, logic: { action_core: ['deport'], action_alt: ['removal', 'expel', 'expulsion'], exclude: ['football'] } }

  it('builds strict, balanced and recall searches without desktop one-day limits', () => {
    const queries = compileQueries(project, advanced)
    expect(queries.map(q => q.label)).toEqual(['Strict', 'Balanced', 'Recall'])
    expect(queries[0].query).toBe('Mexico deport -football')
    expect(compileQueries(project, { ...advanced, logic: { query_plan: ['asylum when:1d'] } })[0].query).toBe('asylum')
    expect(rssUrl('asylum', 'MX:es', ...window)).toContain('after%3A2026-09-27%20before%3A2026-09-28')
  })
  it('keeps matching stories with their reasons and drops excluded or off-topic ones', () => {
    const xml = feed([
      { title: 'Mexican officials deport 40 people - Reuters', link: 'https://news.example/a', description: '&lt;a href="x"&gt;Mexico removal flights resume&lt;/a&gt;' },
      { title: 'Mexico deport football star', link: 'https://news.example/b' },
      { title: 'Deport debate in Canada', link: 'https://news.example/c' },
      { title: 'Mexico deport story from last week', link: 'https://news.example/d', date: 'Sun, 20 Sep 2026 10:00:00 GMT' },
    ])
    const items = rssItems(xml, project, advanced, { label: 'Strict', query: 'Mexico deport' }, ...window)
    expect(items.map(i => i.url)).toEqual(['https://news.example/a'])
    expect(items[0].normalized).toMatchObject({ matched_action_core: ['deport'], matched_action_alt: ['removal'], matched_countries: ['Mexico'], score: 7, source_name: 'Reuters' })
    expect(items[0].snippet_or_context).toBe('Mexico removal flights resume')
  })
  it('applies require_any to simple searches', () => {
    const simple = { bucket_name: 'Border', lane: 'rss', enabled: true, logic: { query_terms: ['Niger'], require_any: ['border'] } }
    const xml = feed([{ title: 'Niger reopens border', link: 'https://news.example/a' }, { title: 'Niger football', link: 'https://news.example/b' }])
    expect(rssItems(xml, project, simple, { label: 'US:en', query: 'Niger' }, ...window).map(i => i.url)).toEqual(['https://news.example/a'])
  })
  it('covers a long absence with week-long windows', () => {
    expect(rssWindows('2026-09-01T12:00:00.000Z', '2026-09-20T00:00:00.000Z').map(w => w.start.slice(0, 10))).toEqual(['2026-09-01', '2026-09-08', '2026-09-15'])
  })
})
