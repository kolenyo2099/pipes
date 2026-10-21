import { describe, expect, it } from 'vitest'
import { itemFilter } from './store.js'
import { nextFiles, urlTime, pageTitle } from './collect.js'
import { buildSheetRow } from './sheets.js'

describe('item filters (desktop list_items)', () => {
  const item = { status: 'inbox', source_type: 'gkg', matched_buckets: ['A', 'B'], datetime_utc: '2026-09-27T10:00:00Z', countries_focus: ['mx'],
    item_id: 'x', created_at: '2026-09-27T11:00:00Z',
    normalized: { tone: { tone: -4 }, counts: [{ type: 'KILL' }], persons: ['Volodymyr Zelensky'], locations: [{ name: 'Aleppo, Syria' }] } }
  const keep = params => itemFilter(params)(item)
  it('combines filters like the SQL version', () => {
    expect(keep({ status: 'inbox', query_bucket: 'B', countries: 'US,MX', since: '2026-09-27T00:00:00Z' })).toBe(true)
    expect(keep({ tone_max: '-3', count_type: 'ARREST,KILL', person: 'zelensky', location_text: 'aleppo' })).toBe(true)
    expect(keep({ tone_min: '0' })).toBe(false)
    expect(keep({ created_before: '2026-09-27T10:59:00Z' })).toBe(false)
    expect(keep({ item_ids: 'y,z' })).toBe(false)
  })
})

describe('GDELT file cursors', () => {
  it('continues after the cursor in quarter-hour files, eight per run', () => {
    const cursor = urlTime('https://data.gdeltproject.org/gdeltv2/20260820000000.export.CSV.zip')
    const urls = nextFiles(cursor, 0, 'export.CSV.zip', Date.parse('2026-08-21T00:00:00Z'))
    expect(urls).toHaveLength(8)
    expect(urls[0]).toContain('20260820001500.export.CSV.zip')
    expect(urls[7]).toContain('20260820020000.export.CSV.zip')
  })
  it('starts at the quarter hour containing the project start', () => {
    expect(nextFiles(null, Date.parse('2026-08-20T00:07:00Z'), 'gkg.csv.zip', Date.parse('2026-08-20T00:10:00Z')))
      .toEqual(['https://data.gdeltproject.org/gdeltv2/20260820000000.gkg.csv.zip', 'https://data.gdeltproject.org/gdeltv2/20260820001500.gkg.csv.zip'])
  })
})

describe('helpers', () => {
  it('prefers og:title for event headlines', () => {
    expect(pageTitle('<title>Site</title><meta property="og:title" content="Troops &amp; tanks">')).toBe('Troops & tanks')
  })
  it('keeps the desktop sheet row shape', () => {
    const row = buildSheetRow({ item_id: 'i', project_id: 'p', source_type: 'events', normalized: { goldstein_scale: -10 }, tags: ['a', 'b'] })
    expect(row.values).toHaveLength(row.headers.length)
    expect(row.values[row.headers.indexOf('goldstein_scale')]).toBe(-10)
    expect(row.values[row.headers.indexOf('tags')]).toBe('a; b')
  })
})
