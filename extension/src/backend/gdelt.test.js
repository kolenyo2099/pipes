import { describe, expect, it } from 'vitest'
import { EVENT_COLUMNS, eventItems, eventRuleMatches, codeSets, gkgItems } from './gdelt.js'
import { gdeltFilePlan } from './collect.js'

const rule = logic => ({ bucket_name: 'Events smoke', lane: 'events', enabled: true, logic })
const project = (watchlists, countries = ['MX']) => ({ project_id: 'p', countries_focus: countries, watchlists })
const row = fields => ({ GLOBALEVENTID: '1', Actor1CountryCode: 'MEX', Actor2CountryCode: '', ActionGeo_CountryCode: '', EventCode: '145', ...fields })
const matches = (logic, fields) => eventRuleMatches(row(fields), rule(logic), codeSets(['MX']).actor, codeSets(['MX']).geo)
const line = fields => EVENT_COLUMNS.map(name => fields[name] ?? '').join('\t')

describe('GDELT events (desktop fetchers/events.rs tests)', () => {
  it('includes the first export when a project starts seconds into its quarter hour, including after an older cursor skipped it', () => {
    const since = '2026-09-28T19:15:12Z'
    const first = Date.parse('2026-09-28T19:15:00Z')
    const p = { created_at: since, collecting_since: since }
    const suffix = 'export.CSV.zip'
    const newProject = gdeltFilePlan(p, 'events', 'english', null, suffix, Date.parse('2026-09-28T19:40:00Z'))
    const oldProject = gdeltFilePlan(p, 'events', 'english', first, suffix, Date.parse('2026-09-28T19:40:00Z'))
    expect(newProject.start).toBe('2026-09-28T19:15:00.000Z')
    expect(newProject.urls[0]).toContain('20260928191500.export.CSV.zip')
    expect(oldProject.urls[0]).toBe(newProject.urls[0])
    expect(gdeltFilePlan({ ...p, [oldProject.replayField]: true }, 'events', 'english', first, suffix, Date.parse('2026-09-28T19:40:00Z')).urls[0])
      .toContain('20260928193000.export.CSV.zip')
  })
  it('requires a matching event code prefix', () => {
    expect(matches({ event_code_prefix: ['14'] }, {})).toBe(true)
    expect(matches({ event_code_prefix: ['14'] }, { EventCode: '030' })).toBe(false)
    expect(matches({ event_code_prefix: ['14'] }, { EventCode: '' })).toBe(false)
  })
  it('requires a present matching actor type', () => {
    expect(matches({ actor_type_filter: ['GOV'] }, {})).toBe(false)
    expect(matches({ actor_type_filter: ['GOV'] }, { Actor1Type1Code: 'BUS' })).toBe(false)
    expect(matches({ actor_type_filter: ['GOV'] }, { Actor2Type2Code: 'GOV' })).toBe(true)
  })
  it('matches required geo countries by FIPS code', () => {
    expect(matches({ required_actor_countries: ['USA'], required_countries_mode: 'geo' }, { ActionGeo_CountryCode: 'US' })).toBe(true)
    expect(matches({ required_actor_countries: ['USA'], required_countries_mode: 'geo' }, {})).toBe(false)
  })
  it('requires every listed actor country', () => {
    const logic = { required_actor_countries: ['MEX', 'USA'], required_countries_mode: 'actor' }
    expect(matches(logic, { Actor2CountryCode: 'USA' })).toBe(true)
    expect(matches(logic, {})).toBe(false)
    expect(matches(logic, { Actor1CountryCode: 'USA' })).toBe(false)
  })
  it('reads the action location from column 54 of the 61-column file', () => {
    // Lite read column 52 (ActionGeo_Type) as the country, so location-only events never matched.
    expect(EVENT_COLUMNS.indexOf('ActionGeo_CountryCode')).toBe(53)
    const text = line({ GLOBALEVENTID: '9', Actor1CountryCode: 'FRA', ActionGeo_Type: '1', ActionGeo_CountryCode: 'MX', EventCode: '190',
      DATEADDED: '20260927100000', SOURCEURL: 'https://example.com/a' })
    const [item] = eventItems(text, project([rule({})]), '2026-09-27T00:00:00Z', '2026-09-28T00:00:00Z', 'english')
    expect(item).toMatchObject({ source_type: 'events', datetime_utc: '2026-09-27T10:00:00Z', url: 'https://example.com/a', countries_focus: ['fr', 'mx'] })
    expect(item.normalized.source_stream).toBe('english')
  })
  it('drops records from before the project started, even inside the same file', () => {
    const text = [line({ GLOBALEVENTID: 'early', Actor1CountryCode: 'MEX', EventCode: '14', DATEADDED: '20260927090000' }),
      line({ GLOBALEVENTID: 'later', Actor1CountryCode: 'MEX', EventCode: '14', DATEADDED: '20260927091500' })].join('\n')
    const items = eventItems(text, project([rule({})]), '2026-09-27T09:04:00Z', '2026-09-28T00:00:00Z', 'english')
    expect(items.map(i => i.gdelt_primary_id)).toEqual(['later'])
  })
})

describe('GDELT GKG', () => {
  const gkgRow = cols => { const r = Array(27).fill(''); for (const [i, v] of Object.entries(cols)) r[i] = v; return r.join('\t') }
  const base = { 1: '20260927100000', 3: 'example.com', 4: 'https://example.com/story', 9: '1#Mexico#MX;1#United States#US', 10: '1#Mexico#MX#MX00#0#23#-102#MX#10;1#United States#US#US00#0#38#-97#US#40', 12: 'Maria Garcia,10',
    7: 'REFUGEES;MIGRATION', 15: '-3.5,1,4.5,5.5,20,0,300', 6: 'KILL#12#people#', 26: '<PAGE_TITLE>Border &amp; asylum</PAGE_TITLE>' }
  const gkgRule = logic => ({ bucket_name: 'Migration', lane: 'doc', enabled: true, logic })
  const run = (logic, cols = {}) => gkgItems(gkgRow({ ...base, ...cols }), project([gkgRule(logic)]), '2026-09-27T00:00:00Z', '2026-09-28T00:00:00Z', 'english')

  it('applies themes, required countries and people like desktop', () => {
    expect(run({ themes: ['REFUGEES'], required_countries: ['United States'], persons: ['garcia'] })).toHaveLength(1)
    expect(run({ themes: ['TERROR'] })).toHaveLength(0)
    expect(run({ required_countries: ['Canada'] })).toHaveLength(0)
    expect(run({ required_countries: ['Atlantis'] })).toHaveLength(0)
    expect(run({}, { 9: '1#Canada#CA' })).toHaveLength(0) // the project focus country must be mentioned
  })
  it('normalizes tone, counts, people and the page title', () => {
    const [item] = run({})
    expect(item.title_or_summary).toBe('Border & asylum')
    expect(item.normalized.tone.tone).toBe(-3.5)
    expect(item.normalized.counts).toEqual([{ type: 'KILL', count: 12, object: 'people' }])
    expect(item.normalized.persons).toEqual(['Maria Garcia'])
    expect(item.countries_focus).toEqual(['mx', 'us'])
  })
})
