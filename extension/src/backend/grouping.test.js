import { describe, expect, it } from 'vitest'
import { normalizeTitle, canonicalUrl, storyKey, fingerprint, fuzzyScore, storyAssigner } from './grouping.js'

describe('story grouping (ported from desktop Canary)', () => {
  it('normalizes titles across case, punctuation and unspaced languages', () => {
    expect(normalizeTitle('A Shared—Headline!')).toBe(normalizeTitle('a shared headline'))
    expect(normalizeTitle('法國外來移民後裔近800萬人')).toBe('法國外來移民後裔近800萬人')
  })
  it('drops tracking noise from URLs', () => {
    expect(canonicalUrl('https://www.Example.com/story/?utm_source=x&b=2&a=1#top')).toBe('example.com/story?a=1&b=2')
  })
  it('does not group events by their generated titles', () => {
    expect(storyKey({ item_id: 'one', source_type: 'events', title_or_summary: 'Same generated title' }))
      .not.toBe(storyKey({ item_id: 'two', source_type: 'events', title_or_summary: 'Same generated title' }))
  })
  it('falls back to the URL for boilerplate titles', () => {
    expect(storyKey({ item_id: 'one', source_type: 'gkg', title_or_summary: 'Latest News', url: 'https://example.com/a' }))
      .not.toBe(storyKey({ item_id: 'two', source_type: 'gkg', title_or_summary: 'Latest News', url: 'https://example.com/b' }))
  })
  it('scores light rewrites high and penalizes changed numbers', () => {
    const first = fingerprint('Flood kills 12 people in northern Italy')
    const rewrite = fingerprint('Northern Italy flood kills 12 people')
    const changed = fingerprint('Flood kills 45 people in northern Italy')
    expect(fuzzyScore(first, rewrite)).toBeGreaterThanOrEqual(0.78)
    expect(fuzzyScore(first, changed)).toBeLessThan(fuzzyScore(first, rewrite))
  })
  it('groups near-identical headlines and nothing looser', () => {
    const assign = storyAssigner([])
    const rss = (id, title, source_name, url) => ({ item_id: id, source_type: 'rss', title_or_summary: title, url, normalized: { source_name } })
    const items = [
      { item_id: '1', source_type: 'gkg', title_or_summary: 'SCOTUS is about to decide who gets deported where', url: 'https://a.example/x' },
      rss('3', 'SCOTUS is about to decide who gets deported where - Reuters', 'Reuters', 'https://b.example/y'),
      rss('5', 'Supreme Court is about to decide who gets deported where - AP', 'AP', 'https://d.example/w'),
      rss('4', 'Supreme Court weighs third-country deportations', null, 'https://c.example/z'),
    ]
    const keys = items.map(assign)
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).not.toBe(keys[0]) // a real rewrite stays separate
    expect(keys[3]).not.toBe(keys[0])
  })
  it('retains probable-pair evidence without merging a rewrite', () => {
    const candidates = []
    const existing = { item_id: 'a', source_type: 'rss', title_or_summary: 'Flood kills 12 people in northern Italy', story_key: 'first' }
    const assign = storyAssigner([existing], { onCandidate: edge => candidates.push(edge) })
    expect(assign({ ...existing, item_id: 'b', title_or_summary: 'Flood kills 12 people in northern Italy today' })).not.toBe('first')
    expect(candidates).toMatchObject([{ left_item_id: 'a', right_item_id: 'b', matching_method: 'fuzzy_shadow', reasons: { classification: 'probable' } }])
  })
  it('honors not-duplicate constraints and known language differences', () => {
    const existing = { item_id: 'a', source_type: 'rss', title_or_summary: 'Flood kills 12 people in northern Italy', story_key: 'first', normalized: { language: 'en' } }
    const incoming = { ...existing, item_id: 'b' }
    expect(storyAssigner([existing])(incoming)).toBe('first')
    const constraints = [{ left_item_id: 'a', right_item_id: 'b', constraint_type: 'not_duplicates' }]
    expect(storyAssigner([existing], { constraints })(incoming)).not.toBe('first')
    const print = fingerprint(existing.title_or_summary)
    expect(fuzzyScore({ ...print, language: 'eng' }, { ...print, language: 'spa' })).toBeCloseTo(0.92)
  })
})
