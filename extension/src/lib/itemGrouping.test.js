import { describe, expect, it } from 'vitest'
import { groupRelatedItems } from './itemGrouping.js'

describe('groupRelatedItems', () => {
  it('groups matching URLs and normalized article titles', () => {
    const items = [
      { item_id: '1', source_type: 'rss', url: 'https://example.com/a', title_or_summary: 'First' },
      { item_id: '2', source_type: 'gkg', url: 'https://example.com/a', title_or_summary: 'Second' },
      { item_id: '3', source_type: 'rss', url: 'https://example.com/b', title_or_summary: 'A sufficiently long shared article headline' },
      { item_id: '4', source_type: 'gkg', url: 'https://example.com/c', title_or_summary: 'A sufficiently long shared article headline!' },
    ]

    const groups = groupRelatedItems(items)
    expect(groups).toHaveLength(2)
    expect(groups.map(group => group.siblings.map(item => item.item_id))).toEqual([
      ['2'],
      ['4'],
    ])
  })

  it('does not title-group synthetic event items', () => {
    const title = 'A sufficiently long shared synthetic event headline'
    const groups = groupRelatedItems([
      { item_id: '1', source_type: 'events', title_or_summary: title },
      { item_id: '2', source_type: 'events', title_or_summary: title },
    ])
    expect(groups).toHaveLength(2)
  })

  it('groups Media Cloud stories with other article lanes', () => {
    const title = 'United States reaches third-country removal agreement'
    const groups = groupRelatedItems([
      { item_id: 'mc', source_type: 'mediacloud', url: 'https://example.com/removal', title_or_summary: title },
      { item_id: 'rss', source_type: 'rss', url: 'https://example.com/removal?utm_source=news', title_or_summary: title },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].siblings).toHaveLength(1)
  })

  it('groups canonical URL variants and short non-Latin titles', () => {
    const groups = groupRelatedItems([
      { item_id: '1', source_type: 'events', url: 'https://www.example.com/story/?utm_source=x#top' },
      { item_id: '2', source_type: 'events', url: 'http://example.com/story' },
      { item_id: '3', source_type: 'gkg', url: 'https://one.test', title_or_summary: '法國外來移民後裔近800萬人' },
      { item_id: '4', source_type: 'gkg', url: 'https://two.test', title_or_summary: '法國外來移民後裔近800萬人' },
    ])
    expect(groups).toHaveLength(2)
    expect(groups.map(group => group.siblings.length)).toEqual([1, 1])
  })

  it('does not group boilerplate titles across different URLs', () => {
    const groups = groupRelatedItems([
      { item_id: '1', source_type: 'gkg', url: 'https://one.test/a', title_or_summary: 'Latest News' },
      { item_id: '2', source_type: 'gkg', url: 'https://two.test/b', title_or_summary: 'Latest News' },
    ])
    expect(groups).toHaveLength(2)
  })
})
