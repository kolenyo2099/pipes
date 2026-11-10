import { describe, expect, it } from 'vitest'
import { archiveState, domain, filterItems, newestFirst, summarize } from './library.js'

const items = [
  { id: 1, title: 'Strike report', url: 'https://www.x.com/a', saved_by: 'Ana', source_type: 'x', saved_at: '2026-01-02', evidence_hash: 'h', processed_at: 't' },
  { id: 2, title: 'Other', url: 'https://b.org/p', snippet: 'a strike nearby', saved_by: 'Bo', added_at: '2026-01-05', status: 'needs_review', evidence_hash: 'h2' },
  { id: 3, title: 'Plain', url: 'https://c.org', saved_by: 'Ana', saved_at: '2026-01-03' },
]

describe('library helpers', () => {
  it('classifies archive state', () => {
    expect(items.map(archiveState)).toEqual(['archived', 'needs_review', 'none'])
    expect(archiveState({ status: 'failed' })).toBe('failed')
  })
  it('filters by text, person, type and archive state', () => {
    expect(filterItems(items, { q: 'STRIKE' }).map(i => i.id)).toEqual([1, 2])
    expect(filterItems(items, { savedBy: 'Ana', archive: 'none' }).map(i => i.id)).toEqual([3])
    expect(filterItems(items, { type: 'link' }).map(i => i.id)).toEqual([2, 3])
  })
  it('sorts newest first, summarizes, and extracts domains', () => {
    expect(newestFirst(items).map(i => i.id)).toEqual([2, 3, 1])
    expect(summarize(items)).toEqual({ total: 3, archived: 2, processed: 1 })
    expect(domain('https://www.x.com/a')).toBe('x.com')
    expect(domain('nope')).toBe('')
  })
})
